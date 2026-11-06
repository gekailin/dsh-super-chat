/** One delivery contract for the chat: superagent Tickets when available, a general Session otherwise. */
import type { ChatMessage, Topic } from './protocol.ts'

export interface ChatTransport {
  /** Which backend currently handles messages. */
  mode(): 'superagent' | 'session'
  /** Deliver one stored user message; the transport may append agent replies or inline errors. */
  deliver(message: ChatMessage, topics: Topic[]): Promise<void>
  /** Whether this topic (or the general chat when omitted) has work in flight. */
  busy(topicId?: string): boolean
  /** Stop work for this topic or the general chat; returns false when there is none. */
  cancel(topicId?: string): Promise<boolean>
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

  deliver(message: ChatMessage, topics: Topic[]): Promise<void> {
    return this.mode() === 'superagent' ? this.superagent.deliver(message, topics) : this.session.deliver(message, topics)
  }

  busy(topicId?: string): boolean {
    return this.mode() === 'superagent' ? this.superagent.busy(topicId) : this.session.busy(topicId)
  }

  cancel(topicId?: string): Promise<boolean> {
    return this.mode() === 'superagent' ? this.superagent.cancel(topicId) : this.session.cancel(topicId)
  }
}
