/** Fallback general-chat Session used when superagent is not installed or not configured. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { capText, sessionOfGeneral } from './protocol.ts'
import type { ChatMessage, Topic } from './protocol.ts'
import type { ChatStore } from './store.ts'
import type { ChatTransport } from './transport.ts'

const PROMPT_TIMEOUT_MS = 30_000
const ERROR_TEXT_MAX = 400

export interface GeneralSessionOptions {
  cwd: string
  agentPreset?: string
  permissionPreset?: string
}

interface ContentBlock { type: string; text?: unknown }

const failureText = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  return capText(text.replace(/\s+/gu, ' ').trim() || 'unknown error', ERROR_TEXT_MAX)
}

const messageText = (message: { content?: readonly ContentBlock[] }): string =>
  (message.content ?? [])
    .filter((block): block is ContentBlock & { text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()

/** Prefix the fallback prompt with the topic names so the standalone Session still sees the cues. */
const cueText = (message: ChatMessage, topics: Topic[]): string =>
  topics.length === 0 ? message.text : '[topics: ' + topics.map(topic => topic.name).join(', ') + ']\n' + message.text

/**
 * One persistent DSH Session for the general chat. It mirrors assistant output and turn failures
 * into the single stream; it is used only while the superagent Source is unavailable.
 */
export class GeneralSession implements ChatTransport {
  private sessionId?: string
  private opening?: Promise<string>
  private starting = false
  private tags: string[] = []
  private readonly tagQueue: string[][] = []
  private readonly sessionIdWanted = sessionOfGeneral()

  constructor(
    private readonly ctx: Context,
    private readonly store: ChatStore,
    private readonly options: GeneralSessionOptions,
  ) {}

  start(): () => void {
    const offSession = this.ctx.on('session/event', (session, event) => this.onSessionEvent(String(session.id), event))
    const offStatus = this.ctx.on('agent/status', ({ agent, status }) => {
      if (!this.owns(String(agent.id))) return
      this.starting = status === 'running'
    })
    return () => { offSession(); offStatus() }
  }

  mode(): 'session' { return 'session' }

  busy(topicId?: string): boolean {
    if (topicId && !this.tags.includes(topicId) && !this.tagQueue.some(tags => tags.includes(topicId))) return false
    const agent = this.ctx.agents.get(this.sessionIdWanted as SessionId)
    return agent ? agent.status === 'running' : this.starting
  }

  async deliver(message: ChatMessage, topics: Topic[]): Promise<void> {
    const entryTags = [...message.tags]
    this.tags = entryTags
    this.tagQueue.push(entryTags)
    this.starting = true
    try {
      const sessionId = await this.ensureSession()
      await this.ctx.sessionController.prompt({
        requestId: message.id as SessionRequestId,
        sessionId: sessionId as SessionId,
        mode: 'queue',
        content: [{ type: 'text', text: cueText(message, topics) }],
      }, AbortSignal.timeout(PROMPT_TIMEOUT_MS))
    } catch (error) {
      const idx = this.tagQueue.lastIndexOf(entryTags)
      if (idx >= 0) this.tagQueue.splice(idx, 1)
      this.starting = false
      // The user message is already stored; keep the failure visible in the same topic view.
      this.store.appendAgent({
        id: 'error-' + message.id,
        text: 'Could not deliver this message: ' + failureText(error),
        at: new Date().toISOString(),
        tags: message.tags,
        kind: 'error',
      })
    }
  }

  async cancel(topicId?: string): Promise<boolean> {
    if (topicId && !this.tags.includes(topicId) && !this.tagQueue.some(tags => tags.includes(topicId))) return false
    const agent = this.ctx.agents.get(this.sessionIdWanted as SessionId)
    if (!agent) return false
    this.tagQueue.length = 0
    this.ctx.sessionController.cancel({ sessionId: this.sessionIdWanted as SessionId })
    return true
  }

  private owns(sessionId: string): boolean {
    return sessionId === this.sessionIdWanted || sessionId === this.sessionId
  }

  private ensureSession(): Promise<string> {
    if (this.sessionId) return Promise.resolve(this.sessionId)
    if (this.opening) return this.opening
    this.opening = this.openSession().finally(() => { this.opening = undefined })
    return this.opening
  }

  private async openSession(): Promise<string> {
    const wanted = this.sessionIdWanted
    const resolved = await this.ctx.sessionController.resolveAgent(wanted as SessionId)
    if (!('error' in resolved)) {
      this.applyPermission(wanted)
      this.sessionId = wanted
      return wanted
    }
    if (resolved.error.code !== 'session/not-found') throw resolved.error
    const created = await this.ctx.sessionController.create({
      sessionId: wanted as SessionId,
      cwd: this.options.cwd,
      ...(this.options.agentPreset ? { agentPreset: this.options.agentPreset } : {}),
    })
    const sessionId = String(created.sessionId)
    this.applyPermission(sessionId)
    this.sessionId = sessionId
    try { await this.ctx.sessionController.rename({ sessionId: sessionId as SessionId, title: 'Super Chat' }) } catch { /* the panel owns the title */ }
    return sessionId
  }

  private applyPermission(sessionId: string): void {
    const preset = this.options.permissionPreset
    if (!preset) return
    const agent = this.ctx.agents.get(sessionId as SessionId)
    if (!agent) return
    try {
      this.ctx.permissionPresets.set(agent.session, preset)
    } catch (error) {
      this.ctx.logger.warn('dsh-super-chat: permission preset %s rejected: %s', preset, error instanceof Error ? error.message : String(error))
    }
  }

  private onSessionEvent(sessionId: string, event: SessionEvent): void {
    if (!this.owns(sessionId)) return
    const turnTags = this.tagQueue[0] ?? this.tags
    if (event.type === 'assistant/message') {
      const text = messageText(event.data.message)
      if (text) {
        this.store.appendAgent({
          id: 'a-' + sessionId + '-' + event.seq,
          text,
          at: new Date(event.time).toISOString(),
          tags: turnTags,
        })
      }
      return
    }
    if (event.type === 'turn/end') {
      if (this.tagQueue.length > 0) this.tags = this.tagQueue.shift()!
      if (event.data.reason.kind === 'error') {
        this.store.appendAgent({
          id: 'e-' + sessionId + '-' + event.seq,
          text: 'The agent turn failed: ' + failureText(event.data.reason.error.message),
          at: new Date(event.time).toISOString(),
          tags: turnTags,
          kind: 'error',
        })
      }
    }
  }
}
