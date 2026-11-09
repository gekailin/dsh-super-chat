/** One delivery contract for the chat: superagent Tickets when available, a general Session otherwise. */
import type { ModelRole, ModelRolesView, RoleModel } from './models.ts'
import type { ChatMessage, Topic } from './protocol.ts'

/** Options a caller can attach to one delivery. */
export interface DeliverOptions {
  /** Give the new worker Session of the resulting Ticket this model. */
  workerModel?: RoleModel
}

export interface ChatTransport {
  /** Which backend currently handles messages. */
  mode(): 'superagent' | 'session'
  /** Deliver one stored user message; the transport may append agent replies or inline errors. */
  deliver(message: ChatMessage, topics: Topic[], options?: DeliverOptions): Promise<void>
  /** Whether this topic (or the general chat when omitted) has work in flight. */
  busy(topicId?: string): boolean
  /** Stop work for this topic or the general chat; returns false when there is none. */
  cancel(topicId?: string): Promise<boolean>
  /** Read the configured orchestrator/worker role models and the profile catalog. */
  models?(): Promise<ModelRolesView>
  /** Save one role model; null makes the role inherit the deployment default. */
  setModel?(role: ModelRole, model: RoleModel | null): Promise<ModelRolesView>
  /** The resolved model of a worker-model chat directive, or undefined when the message has none. */
  workerModel?(text: string): Promise<{ model: RoleModel } | { error: string } | undefined>
}

/** Chooses the transport per operation, so a prototype that appears or disappears is handled without remounting. */
export class ChatTransportRouter implements ChatTransport {
  constructor(
    private readonly superagent: ChatTransport & { available(): boolean },
    private readonly session: ChatTransport,
  ) {}

  mode(): 'superagent' | 'session' {
    return this.superagent.available() ? 'superagent' : 'session'
  }

  deliver(message: ChatMessage, topics: Topic[], options?: DeliverOptions): Promise<void> {
    return this.mode() === 'superagent'
      ? this.superagent.deliver(message, topics, options)
      : this.session.deliver(message, topics, options)
  }

  busy(topicId?: string): boolean {
    return this.mode() === 'superagent' ? this.superagent.busy(topicId) : this.session.busy(topicId)
  }

  cancel(topicId?: string): Promise<boolean> {
    return this.mode() === 'superagent' ? this.superagent.cancel(topicId) : this.session.cancel(topicId)
  }

  models(): Promise<ModelRolesView> {
    if (this.superagent.models) return this.superagent.models()
    return Promise.reject(new Error('Model settings are not available'))
  }

  setModel(role: ModelRole, model: RoleModel | null): Promise<ModelRolesView> {
    if (this.mode() !== 'superagent') return Promise.reject(new Error('Superagent is not available; model settings need it'))
    if (this.superagent.setModel) return this.superagent.setModel(role, model)
    return Promise.reject(new Error('Model settings are not available'))
  }

  workerModel(text: string): Promise<{ model: RoleModel } | { error: string } | undefined> {
    return this.mode() === 'superagent' && this.superagent.workerModel
      ? this.superagent.workerModel(text)
      : Promise.resolve(undefined)
  }
}
