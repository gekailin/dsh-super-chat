/**
 * Core bridge to the installed dsh-superagent-prototype bundle.
 *
 * The chat is one message stream with named topic tags. A message with tags gets its first tag as the
 * dispatch thread (a cue for task assignment); an untagged message goes to the general thread and
 * lets superagent decide. All tags travel in the Trigger meta and in a short text cue. A chat-only
 * prototype (both GitHub fields empty) is made usable through a memory-only Setup patch; no file in
 * the prototype is changed.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  EMPTY_MODEL_ROLES, modelLabel, parseWorkerModelDirective, resolveModelRef, roleModelOf,
  type ModelRole, type ModelRolesView, type RoleModel,
} from './models.ts'
import {
  GENERAL_CHAT, MAX_TAGS, VIEW_LIMIT, capText, validTopicId,
  type ChatMessage, type Topic,
} from './protocol.ts'
import type { ChatStore } from './store.ts'
import type { ChatTransport, DeliverOptions } from './transport.ts'
import { ensureWorkspaceGroup } from './workspace-group-host.ts'
import type { WorkspaceGroupInfo } from './workspace-group.ts'

/** Source kind registered with the prototype; stable because Triggers and Policy parts use it. */
export const SOURCE = 'super-chat'
/** Health entry the Source reports to the prototype. */
export const HEALTH = 'super-chat'
/** The only sender a local panel can have. */
export const LOCAL_ACTOR = 'local'
/** Longest inline delivery failure. */
const ERROR_TEXT_MAX = 400
/** How often the bridge re-checks the prototype service (it is replaced when that plugin restarts). */
const WATCH_MS = 2000
/** How long startup waits for the prototype's own ready promise before trying again. */
const READY_TIMEOUT_MS = 10_000
/** Marks a patched Setup class prototype, and stores the original method for diagnostics. */
const SETUP_PATCH = Symbol.for('dsh-super-chat.chat-only-setup')
/** The documented prefix of a prototype worker Session id: `worker-<ticket id>`. */
const WORKER_SESSION_PREFIX = 'worker-'
/** How long a worker-model directive waits for its Ticket's worker Session before it is forgotten. */
const WORKER_MODEL_TTL_MS = 30 * 60_000
/** Most worker-model directives remembered at once; the oldest is dropped first. */
const WORKER_MODEL_LIMIT = 50

interface Localized { zh: string; en: string }
interface AllowedSender { id: string; name?: string }
interface Schema<T> {
  parse(value: unknown): T
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown }
}
interface SettingsLike {
  sources: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>
  policy: { sources: Record<string, { allowed?: AllowedSender[] } & Record<string, unknown>> } & Record<string, unknown>
  eval?: { model?: unknown } & Record<string, unknown>
  executor?: { model?: unknown } & Record<string, unknown>
  [key: string]: unknown
}
interface TriggerLike {
  id: string
  source: string
  threads: { source: string; id: string }[]
  actor: { source: string; id: string }
  human: true
  addressed: 'direct'
  at: string
  text: string
  channel: { source: string; thread: string; address: Record<string, string> }
  meta: Record<string, unknown>
}
interface OutboundLike {
  id: string
  text: string
  channel: { source: string; thread: string; address: Record<string, string> }
  ticketId?: string
  kind?: string
}
interface ContextMessageLike {
  id: string
  from: string
  at: string
  text: string
  bot?: true
}
interface ThreadLike { subscriptions?: string[] }
interface TicketLike { id: string; ended?: unknown; origin?: { triggerId?: string } }
interface SourceContextLike {
  receive(trigger: TriggerLike): unknown | Promise<unknown>
  report(entry: string, health: { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string }): void
  threads: { get(key: string): ThreadLike | undefined }
  tickets: { get(id: string): TicketLike | undefined; open(): TicketLike[] }
}
interface SetupLike {
  run(settings: unknown): Promise<boolean>
  restart(): void
  host?: { machine?: unknown }
  resolved?: unknown
  problem?: unknown
  feishuProblem?: unknown
}
/** The subset of the prototype's Runtime/SourceHost this plugin uses. */
export interface OrchestratorLike {
  readonly ready: Promise<void>
  readonly machine?: unknown
  /** Orchestrator Session id exposed by the prototype Runtime. */
  readonly masterId?: string
  readonly setup: SetupLike
  readonly store: { settings(): SettingsLike; blockRevision(block: string): number }
  readonly settings: {
    current(): SettingsLike
    save(block: string, value: unknown, revision: number, origin: string): Promise<unknown>
  }
  readonly sources: { register(kind: unknown): () => void }
  readonly engine?: { stopTicket(ticketId: string): unknown }
  configured(): boolean
  context(kind: { kind: string; health: readonly string[] }): SourceContextLike
}
/** A Source registered on one prototype Runtime; orchestrator changes when the prototype restarts. */
export interface Registration {
  orchestrator: OrchestratorLike
  context: SourceContextLike
  unregister: () => void
  /** Superagent workspace group, when the Host registry is available. */
  group?: WorkspaceGroupInfo
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Build the tiny schema surface the prototype calls (parse/safeParse); no Zod dependency is needed. */
function schemaOf<T>(parse: (value: unknown) => T): Schema<T> {
  return {
    parse,
    safeParse(value: unknown) {
      try { return { success: true as const, data: parse(value) } }
      catch (error) { return { success: false as const, error } }
    },
  }
}

const EMPTY_CONFIG = schemaOf((): Record<string, never> => ({}))

function allowed(value: unknown): value is AllowedSender {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) return false
  return value.name === undefined || typeof value.name === 'string'
}

/** Policy part of the Source; the local sender is seeded once and an empty part stays empty. */
const POLICY = schemaOf((value: unknown): { allowed: AllowedSender[] } => {
  const record = isRecord(value) ? value : {}
  return { allowed: Array.isArray(record.allowed) ? record.allowed.filter(allowed) : [] }
})

const POLICY_FIELDS = [{
  key: 'allowed',
  type: 'rows',
  label: { zh: '能通过 Super Chat 发起工作的人', en: 'People who may originate work through Super Chat' },
  hint: { zh: '本机面板使用固定的 local 身份；名单为空时消息仍会记录，但不会发起工作。',
    en: 'The local panel uses the fixed local identity; with an empty list messages are still recorded but originate no work.' },
  columns: [
    { key: 'id', type: 'text', label: { zh: '身份', en: 'Identity' }, pattern: '[A-Za-z0-9_-]+' },
    { key: 'name', type: 'text', label: { zh: '显示名', en: 'Display name' }, optional: true },
  ],
}] as const

/** The dispatch thread for one message: its first topic, or the general thread. */
export const dispatchThread = (topicId?: string): string => topicId ? 'topic:' + topicId : GENERAL_CHAT

/** The prototype Thread key for a dispatch thread. */
export const threadKey = (thread: string): string => SOURCE + ':' + thread

/** The topic ids a Trigger's meta carries. */
export function triggerTopics(trigger: Pick<TriggerLike, 'meta'>): string[] {
  const value = trigger.meta.topic_ids
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && validTopicId(item)).slice(0, MAX_TAGS) : []
}

/** The first topic id of a stored message, used as its dispatch cue. */
export const primaryTopic = (message: Pick<ChatMessage, 'tags'>): string | undefined => message.tags[0]

const failureText = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  return capText(text.replace(/\s+/gu, ' ').trim() || 'unknown error', ERROR_TEXT_MAX)
}

/** A worker-model directive waiting for the new Ticket's worker Session. */
interface PendingWorkerModel {
  messageId: string
  tags: string[]
  model: RoleModel
  timer: NodeJS.Timeout
}

/** Convert a catalog route into the Session event's selection value. */
const toSelection = (model: RoleModel): ModelSelection => ({
  provider: model.provider,
  model: model.model,
  ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort as NonNullable<ModelSelection['reasoningEffort']> } : {}),
})

/**
 * The DSH request waterfalls that carry one selection to the next request. DSH's live model
 * selection cache does not observe a `model/selection` event appended by another plugin, so the
 * selection is also injected into prompt assembly and the request, as the prototype does for its
 * own role model.
 */
interface SessionEventLike {
  type: string
  data?: { header?: { config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } }
}

interface AgentContextLike {
  effect(factory: () => () => void): void
  on(event: 'system-prompt/assemble', listener: (assembly: unknown, context: unknown, next: () => Promise<unknown>) => Promise<unknown>,
    options: { prepend: true }): () => void
  on(event: 'agent/request', listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
    options: { prepend: true }): () => void
  on(event: 'session/event', listener: (session: unknown, event: SessionEventLike) => void): () => void
}

interface ForcedModel {
  /** The selection to force on the next request; cleared by that request's header. */
  pending?: ModelSelection
}

const forcedModels = new WeakMap<Agent, ForcedModel>()

/** Install the one-shot request override once per Agent and return its mutable state. */
function forcedModel(agent: Agent): ForcedModel {
  const existing = forcedModels.get(agent)
  if (existing) return existing
  const state: ForcedModel = {}
  forcedModels.set(agent, state)
  let assembled: ModelSelection | undefined
  const scoped = agent.ctx as unknown as AgentContextLike
  scoped.effect(() => {
    const disposers = [
      scoped.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selected = state.pending
        const result = await next() as { variables?: Record<string, unknown> }
        assembled = selected
        return selected
          ? { ...result, variables: { ...(result.variables ?? {}), provider: selected.provider, model: selected.model } }
          : result
      }, { prepend: true }),
      scoped.on('agent/request', async (_payload, next) => {
        const result = await next() as Record<string, unknown>
        const selected = assembled
        assembled = undefined
        if (!selected) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...selected }
      }, { prepend: true }),
      scoped.on('session/event', (session, event) => {
        // A header that matches our selection proves the override reached that request; a header
        // already in flight when the selection was offered must not clear it.
        if (session !== agent.session || event.type !== 'request/header' || !state.pending) return
        const config = event.data?.header?.config
        if (!config) return
        const pending = state.pending
        if (config.provider === pending.provider && config.model === pending.model
          && (config.reasoningEffort ?? '') === (pending.reasoningEffort ?? '')) state.pending = undefined
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  })
  return state
}

/** Record the selection on the Session and force it onto the next request. */
function offerModel(agent: Agent, model: RoleModel): void {
  const selection = toSelection(model)
  agent.session.append('model/selection', selection)
  forcedModel(agent).pending = selection
}

/** Whether a settings failure is an optimistic-concurrency conflict worth retrying. */
const isSettingsConflict = (error: unknown): boolean =>
  (error instanceof Error ? error.message : String(error)).includes('Settings changed')

/** Prefix the original text with a short topic cue; the chat keeps the user's original text. */
export function cueText(message: Pick<ChatMessage, 'text'>, topics: readonly Topic[]): string {
  if (topics.length === 0) return message.text
  return '[topics: ' + topics.map(topic => topic.name).join(', ') + ']\n' + message.text
}

/** A Trigger for one stored chat message; its tags are cues, not a hard partition. */
export function chatTrigger(message: ChatMessage, topics: readonly Topic[]): TriggerLike {
  const primary = primaryTopic(message)
  const thread = dispatchThread(primary)
  return {
    id: SOURCE + '-' + message.id,
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: LOCAL_ACTOR },
    human: true,
    addressed: 'direct',
    at: message.at,
    text: cueText(message, topics),
    channel: { source: SOURCE, thread, address: { topics: message.tags.join(',') } },
    meta: {
      chat_message_id: message.id,
      topic_ids: [...message.tags],
      topic_names: topics.map(topic => topic.name),
      dispatch: primary ? 'topic' : 'general',
    },
  }
}

/** Build the SourceKind the prototype registers. */
export function createSourceKind(store: ChatStore) {
  return {
    kind: SOURCE,
    title: { zh: 'Super Chat', en: 'Super Chat' },
    description: {
      zh: '本机 Super Chat 面板；通用聊天与主题标签会作为明确请求交给 Superagent，回复回到同一聊天流。',
      en: 'The local Super Chat panel; the general chat and topic tags become explicit requests to Superagent, and replies return to the same stream.',
    },
    schema: EMPTY_CONFIG,
    fields: [],
    health: [HEALTH],
    scope: () => ({ listened: true, observed: false }),
    channel: {
      allowed: () => true,
      async send(_host: unknown, message: OutboundLike): Promise<'sent' | 'gone'> {
        const ids = typeof message.channel.address.topics === 'string'
          ? message.channel.address.topics.split(',').filter(validTopicId).slice(0, MAX_TAGS)
          : message.channel.thread.startsWith('topic:') ? [message.channel.thread.slice('topic:'.length)] : []
        store.appendAgent({ id: message.id, text: message.text, at: new Date().toISOString(), tags: ids })
        return 'sent'
      },
      link: () => ({ url: '', label: { zh: 'Super Chat', en: 'Super Chat' } satisfies Localized }),
    },
    threadContext: {
      messageId: (trigger: TriggerLike): string =>
        typeof trigger.meta.chat_message_id === 'string' ? trigger.meta.chat_message_id : trigger.id,
      async read(_host: unknown, trigger: TriggerLike): Promise<{ messages: ContextMessageLike[]; body: Record<string, unknown> }> {
        const ids = triggerTopics(trigger)
        const names = new Map(store.topics().map(topic => [topic.id, topic.name]))
        const selected = ids[0] ? store.messages(ids[0], VIEW_LIMIT) : store.messages(undefined, VIEW_LIMIT)
        const messages = selected.map((message): ContextMessageLike => ({
          id: message.id,
          from: message.role === 'user' ? LOCAL_ACTOR : 'agent',
          at: message.at,
          text: message.tags.length === 0 ? message.text
            : '[' + message.tags.map(id => names.get(id) ?? id).join(', ') + '] ' + message.text,
          ...(message.role === 'agent' ? { bot: true as const } : {}),
        }))
        return { messages, body: {} }
      },
    },
    policy: {
      schema: POLICY,
      fields: POLICY_FIELDS,
      explicit: {
        zh: '本机 Super Chat 里的 local 用户直接对 Superagent 说话；主题标签只是任务分配的线索。',
        en: 'The local user writes directly to Superagent in Super Chat; topic tags are cues for task assignment.',
      },
    },
  }
}

/** Whether settings describe a chat-only deployment: both GitHub fields are empty. */
export function chatOnly(settings: SettingsLike | undefined): boolean {
  if (!settings) return false
  const github = settings.sources.github
  const config = isRecord(github?.config) ? github.config : {}
  const repository = typeof config.repository === 'string' ? config.repository.trim() : ''
  const cli = typeof config.cli === 'string' ? config.cli.trim() : ''
  return !repository && !cli
}

/**
 * Install the chat-only Setup patch on the prototype's class, so a Runtime created later (after a
 * restart) also accepts an empty GitHub configuration. Every other shape runs the prototype's check.
 */
export function patchSetup(orchestrator: OrchestratorLike): void {
  const setup = orchestrator.setup
  const proto = Object.getPrototypeOf(setup) as (Record<PropertyKey, unknown> & { run?: (settings: unknown) => Promise<boolean> }) | null
  if (!proto || typeof proto.run !== 'function' || proto[SETUP_PATCH]) return
  const original = proto.run
  proto.run = async function patchedRun(this: SetupLike, settings: unknown): Promise<boolean> {
    if (!chatOnly(settings as SettingsLike | undefined)) return original.call(this, settings)
    const machine = this.host?.machine ?? orchestrator.machine
    this.resolved = {
      ...(isRecord(machine) ? machine : {}),
      repository: '',
      github: { cli: '', login: '', noreply: '' },
    }
    this.problem = undefined
    this.feishuProblem = undefined
    return true
  }
  proto[SETUP_PATCH] = original
}

/** Read the prototype service without a hard injection, so the plugin also loads without it. */
export function getOrchestrator(ctx: Context): OrchestratorLike | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  try { return get.call(ctx, 'orchestrator') as OrchestratorLike | undefined } catch { return undefined }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); timer.unref?.() }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Add the local sender to the prototype's Policy unless a part already exists. */
export async function seedPolicy(orchestrator: OrchestratorLike): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const settings = orchestrator.settings.current()
    if (settings.policy.sources[SOURCE] !== undefined) return
    const policy = {
      ...settings.policy,
      sources: {
        ...settings.policy.sources,
        [SOURCE]: { allowed: [{ id: LOCAL_ACTOR, name: 'Local user' }], admission: {} },
      },
    }
    try {
      await orchestrator.settings.save('policy', policy, orchestrator.store.blockRevision('policy'), 'sync')
      return
    } catch (error) {
      if (attempt === 2) throw error
      await delay(50)
    }
  }
}

const restartRequested = new WeakSet<object>()
let restarts = 0

/** Connect once: patch chat-only setup, restart when needed, register the Source, seed Policy. */
export async function connectSuperagent(ctx: Context, store: ChatStore, shouldStop?: () => boolean): Promise<Registration | undefined> {
  const orchestrator = getOrchestrator(ctx)
  if (!orchestrator || shouldStop?.()) return undefined
  patchSetup(orchestrator)
  await withTimeout(orchestrator.ready, READY_TIMEOUT_MS)
  if (shouldStop?.()) return undefined
  if (!orchestrator.configured()) {
    if (chatOnly(orchestrator.store.settings()) && !restartRequested.has(orchestrator) && restarts < 3) {
      restartRequested.add(orchestrator)
      restarts += 1
      try { orchestrator.setup.restart() } catch { /* the prototype is probably shutting down */ }
    }
    return undefined
  }
  restarts = 0
  const unregister = orchestrator.sources.register(createSourceKind(store))
  try {
    if (shouldStop?.()) {
      unregister()
      return undefined
    }
    const context = orchestrator.context({ kind: SOURCE, health: [HEALTH] })
    context.report(HEALTH, { state: 'ready', detail: 'Super Chat source ready', at: new Date().toISOString() })
    await seedPolicy(orchestrator)
    if (shouldStop?.()) {
      unregister()
      return undefined
    }
    return { orchestrator, context, unregister }
  } catch (error) {
    unregister()
    throw error
  }
}

/** The panel-facing transport used while superagent is available. */
export class SuperagentChat implements ChatTransport {
  private registration?: Registration
  private timer?: NodeJS.Timeout
  private syncing = false
  private stopped = false
  private offCreated?: () => void
  /** Worker-model directives waiting for the new Ticket's `worker-<ticket id>` Session. */
  private readonly pending = new Map<string, PendingWorkerModel>()

  constructor(
    private readonly ctx: Context,
    private readonly store: ChatStore,
    private readonly log: (message: string) => void = () => {},
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.refresh() }, WATCH_MS)
    this.timer.unref?.()
    // A directive names a model before the Ticket exists; `agent/created` runs before the worker's
    // first request, so the selection is in place before the Executor seeds its configured default.
    this.offCreated = this.ctx.on('agent/created', ({ agent }) => { this.onAgentCreated(agent) })
    void this.refresh()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.offCreated?.()
    this.offCreated = undefined
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.pending.clear()
    this.clear()
  }

  mode(): 'superagent' { return 'superagent' }

  /** Whether messages should go to the prototype rather than the fallback Session. */
  available(): boolean {
    const registration = this.registration
    if (!registration || !registration.orchestrator.configured()) return false
    return registration.orchestrator.store.settings().policy.sources[SOURCE] !== undefined
  }

  async deliver(message: ChatMessage, topics: Topic[], options?: DeliverOptions): Promise<void> {
    const registration = this.registration
    if (!registration || !this.available()) throw new Error('Superagent is not available')
    const trigger = chatTrigger(message, topics)
    if (options?.workerModel) this.trackWorkerModel(trigger.id, message, options.workerModel)
    try {
      await registration.context.receive(trigger)
    } catch (error) {
      if (options?.workerModel) this.removePending(trigger.id)
      this.store.appendAgent({
        id: 'error-' + message.id,
        text: 'Could not deliver this message: ' + failureText(error),
        at: new Date().toISOString(),
        tags: message.tags,
        kind: 'error',
      })
    }
  }

  /** Read the configured role models together with the profile's catalog. */
  async models(): Promise<ModelRolesView> {
    const registration = this.registration
    if (!registration || !this.available()) return EMPTY_MODEL_ROLES
    try {
      const catalog = await this.ctx.sessionController.modelCatalog()
      const settings = registration.orchestrator.store.settings()
      return {
        available: true,
        ...(catalog.default ? { default: roleModelOf(catalog.default) ?? undefined } : {}),
        orchestrator: roleModelOf(settings.eval?.model),
        worker: roleModelOf(settings.executor?.model),
        groups: catalog.groups,
        failures: catalog.failures,
      }
    } catch (error) {
      const detail = failureText(error)
      this.log('Could not read the model settings: ' + detail)
      return { ...EMPTY_MODEL_ROLES, error: detail }
    }
  }

  /** Save one role model; a null model makes that role inherit the deployment default. */
  async setModel(role: ModelRole, model: RoleModel | null): Promise<ModelRolesView> {
    const registration = this.registration
    if (!registration || !this.available()) throw new Error('Superagent is not available; model settings need it')
    const orchestrator = registration.orchestrator
    const block = role === 'orchestrator' ? 'eval' : 'executor'
    for (let attempt = 0; ; attempt++) {
      const current = orchestrator.store.settings()
      const base = isRecord(current[block]) ? current[block] : {}
      try {
        await orchestrator.settings.save(block, { ...base, model }, orchestrator.store.blockRevision(block), 'panel')
        break
      } catch (error) {
        if (attempt >= 2 || !isSettingsConflict(error)) throw error
        await delay(50)
      }
    }
    if (role === 'orchestrator') await this.switchOrchestrator(orchestrator, model)
    return this.models()
  }

  /** Resolve the model reference of a worker-model chat directive; no directive returns undefined. */
  async workerModel(text: string): Promise<{ model: RoleModel } | { error: string } | undefined> {
    const ref = parseWorkerModelDirective(text)
    if (!ref) return undefined
    if (!this.available()) return undefined
    try {
      const catalog = await this.ctx.sessionController.modelCatalog()
      return resolveModelRef(ref, catalog.groups)
    } catch (error) {
      return { error: 'Could not read the model list: ' + failureText(error) }
    }
  }

  busy(topicId?: string): boolean {
    const context = this.registration?.context
    if (!context) return false
    try {
      const subscriptions = context.threads.get(threadKey(dispatchThread(topicId)))?.subscriptions ?? []
      return subscriptions.some(id => {
        const ticket = context.tickets.get(id)
        return ticket !== undefined && ticket.ended === undefined
      })
    } catch {
      return false
    }
  }

  async cancel(topicId?: string): Promise<boolean> {
    const registration = this.registration
    const context = registration?.context
    if (!registration || !context) return false
    try {
      const subscriptions = context.threads.get(threadKey(dispatchThread(topicId)))?.subscriptions ?? []
      const live = subscriptions.flatMap(id => {
        const ticket = context.tickets.get(id)
        return ticket && ticket.ended === undefined ? [ticket] : []
      })
      if (live.length === 0) return false
      for (const ticket of live) registration.orchestrator.engine?.stopTicket(ticket.id)
      return true
    } catch {
      return false
    }
  }

  async refresh(): Promise<void> {
    if (this.stopped || this.syncing) return
    this.syncing = true
    try {
      const orchestrator = getOrchestrator(this.ctx)
      if (!orchestrator) { this.clear(); return }
      if (this.registration?.orchestrator === orchestrator) {
        await this.ensureGroup(this.registration)
        return
      }
      this.clear()
      const registration = await connectSuperagent(this.ctx, this.store, () => this.stopped)
      if (!this.stopped && registration) {
        await this.ensureGroup(registration)
        if (!this.stopped) {
          this.registration = registration
        } else {
          try { registration.unregister() } catch { /* the Runtime may already be disposed */ }
        }
      } else if (registration) {
        try { registration.unregister() } catch { /* the Runtime may already be disposed */ }
      }
    } catch (error) {
      this.log('Superagent integration is unavailable: ' + failureText(error))
    } finally {
      this.syncing = false
    }
  }

  /** Grouping facts the panel API serves to the browser; absent while Superagent is unavailable. */
  workspaceGroup(): WorkspaceGroupInfo | undefined { return this.registration?.group }

  /** Resolve the group once per registration; a failure retries on the next watch tick. */
  private async ensureGroup(registration: Registration): Promise<void> {
    if (registration.group) return
    try {
      registration.group = await ensureWorkspaceGroup(this.ctx, registration.orchestrator)
    } catch (error) {
      this.log('Superagent workspace group is unavailable: ' + failureText(error))
    }
  }

  /**
   * Give a directive's model to the new worker Session before its first request. The prototype
   * seeds the configured Executor model in `Sessions.ensure` after the Session is created, so this
   * listener runs first and a Session that already made a request keeps its model. A listener must
   * never fail Session creation, so every panel-side failure stays in the log.
   */
  private onAgentCreated(agent: Agent): void {
    try { this.applyWorkerModel(agent) } catch (error) { this.log('Worker model setup failed: ' + failureText(error)) }
  }

  private applyWorkerModel(agent: Agent): void {
    if (this.pending.size === 0) return
    const sessionId = String(agent.id)
    if (!sessionId.startsWith(WORKER_SESSION_PREFIX)) return
    const ticketId = sessionId.slice(WORKER_SESSION_PREFIX.length)
    let ticket: TicketLike | undefined
    try { ticket = this.registration?.context.tickets.get(ticketId) } catch { return }
    const triggerId = ticket?.origin?.triggerId
    if (!triggerId) return
    const pending = this.pending.get(triggerId)
    if (!pending) return
    try {
      if (agent.session.requestHeader()) {
        this.clearPending(triggerId, pending)
        return
      }
      offerModel(agent, pending.model)
    } catch (error) {
      this.log('Could not set the worker model: ' + failureText(error))
      this.clearPending(triggerId, pending)
      return
    }
    this.clearPending(triggerId, pending)
    this.store.appendAgent({
      id: 'model-' + pending.messageId,
      text: 'Worker model: ' + modelLabel(pending.model) + '.',
      at: new Date().toISOString(),
      tags: pending.tags,
      kind: 'note',
    })
  }

  /** Remember a directive until its Ticket creates the worker Session, bounded in time and count. */
  private trackWorkerModel(triggerId: string, message: ChatMessage, model: RoleModel): void {
    const previous = this.pending.get(triggerId)
    if (previous) clearTimeout(previous.timer)
    while (this.pending.size >= WORKER_MODEL_LIMIT) {
      const oldest = this.pending.keys().next().value
      if (oldest === undefined) break
      this.removePending(oldest)
    }
    const timer = setTimeout(() => { this.pending.delete(triggerId) }, WORKER_MODEL_TTL_MS)
    timer.unref?.()
    this.pending.set(triggerId, { messageId: message.id, tags: [...message.tags], model, timer })
  }

  private clearPending(triggerId: string, pending: PendingWorkerModel): void {
    clearTimeout(pending.timer)
    if (this.pending.get(triggerId) === pending) this.pending.delete(triggerId)
  }

  private removePending(triggerId: string): void {
    const pending = this.pending.get(triggerId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(triggerId)
  }

  /** Switch the live orchestrator Session as well; the saved `eval.model` covers later Sessions. */
  private async switchOrchestrator(orchestrator: OrchestratorLike, model: RoleModel | null): Promise<void> {
    if (!orchestrator.masterId) return
    try {
      const agent = this.ctx.agents.get(orchestrator.masterId as SessionId)
      if (!agent) return
      const selected = model ?? roleModelOf((await this.ctx.sessionController.modelCatalog()).default)
      if (selected) offerModel(agent, selected)
    } catch (error) {
      this.log('Could not switch the orchestrator model: ' + failureText(error))
    }
  }

  private clear(): void {
    if (!this.registration) return
    try { this.registration.unregister() } catch { /* the Runtime may already be disposed */ }
    this.registration = undefined
  }
}
