import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  SuperagentChat, chatOnly, chatTrigger, connectSuperagent, createSourceKind, cueText, dispatchThread, patchSetup, threadKey,
  type OrchestratorLike,
} from '../src/superagent.ts'
import { ChatStore } from '../src/store.ts'
import type { ChatMessage, Topic } from '../src/protocol.ts'

interface TestSettings {
  sources: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>
  policy: { sources: Record<string, { allowed?: { id: string; name?: string }[] } & Record<string, unknown>> } & Record<string, unknown>
  [key: string]: unknown
}
interface TestThread { subscriptions: string[] }
interface TestTicket { id: string; ended?: unknown }

const stores: ChatStore[] = []
const dirs: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close() } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function harness(options: { configured?: boolean; github?: Record<string, unknown>; policy?: TestSettings['policy']['sources'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'super-chat-superagent-'))
  const store = new ChatStore(join(dir, 'chat.sqlite'))
  store.load()
  stores.push(store); dirs.push(dir)
  let settings: TestSettings = {
    sources: { github: { enabled: false, config: options.github ?? { repository: '', cli: '' } } },
    policy: { sources: options.policy ?? {} },
  }
  const Setup = class {
    resolved?: unknown
    problem?: unknown
    feishuProblem?: unknown
    restarts = 0
    constructor(readonly host: { machine: unknown }) {}
    async run(_settings: unknown): Promise<boolean> { throw new Error('repositoryUnset') }
    restart(): void { this.restarts += 1 }
  }
  const setup = new Setup({ machine: { stateDir: dir } })
  let configured = options.configured ?? false
  const registered: unknown[] = []
  const reports: { entry: string; health: unknown }[] = []
  const received: unknown[] = []
  const threads = new Map<string, TestThread>()
  const tickets = new Map<string, TestTicket>()
  const context = {
    receive: vi.fn(async (trigger: unknown) => { received.push(trigger); return 'stored' }),
    report: vi.fn((entry: string, health: unknown) => { reports.push({ entry, health }) }),
    threads: { get: (key: string) => threads.get(key) },
    tickets: { get: (id: string) => tickets.get(id), open: () => [...tickets.values()] },
  }
  const save = vi.fn(async (block: string, value: unknown) => {
    if (block === 'policy') settings = { ...settings, policy: value as TestSettings['policy'] }
  })
  const orchestrator: OrchestratorLike = {
    ready: Promise.resolve(),
    machine: { stateDir: dir },
    setup,
    store: { settings: () => settings, blockRevision: () => 1 },
    settings: { current: () => settings, save },
    sources: { register: vi.fn((kind: unknown) => { registered.push(kind); return () => {} }) },
    engine: { stopTicket: vi.fn() },
    configured: () => configured,
    context: () => context,
  }
  const ctx = { get: (name: string) => name === 'orchestrator' ? orchestrator : undefined } as unknown as Context
  return {
    store, settings: () => settings, setup, orchestrator, ctx, registered, reports, received, threads, tickets, save, context,
    setConfigured(value: boolean) { configured = value },
  }
}

const at = '2026-01-01T00:00:00.000Z'
const topic = (id: string, name: string): Topic => ({ id, name, createdAt: at, updatedAt: at, messageCount: 1 })
const message = (tags: string[] = []): ChatMessage => ({ id: 'u1', role: 'user', text: 'fix it', at, tags, via: 'panel' })

describe('superagent integration', () => {
  it('recognizes a chat-only deployment from empty GitHub fields', () => {
    expect(chatOnly({ sources: { github: { config: { repository: '', cli: '' } } }, policy: { sources: {} } })).toBe(true)
    expect(chatOnly({ sources: { github: { config: { repository: 'acme/widgets', cli: '' } } }, policy: { sources: {} } })).toBe(false)
    expect(chatOnly(undefined)).toBe(false)
  })

  it('patches Setup so an empty GitHub configuration resolves a chat-only deployment', async () => {
    const h = harness()
    patchSetup(h.orchestrator)
    patchSetup(h.orchestrator)
    await expect(h.setup.run(h.settings())).resolves.toBe(true)
    expect(h.setup.resolved).toMatchObject({ repository: '', github: { cli: '', login: '', noreply: '' } })
    h.settings().sources.github = { enabled: true, config: { repository: 'acme/widgets', cli: '/bin/gh' } }
    await expect(h.setup.run(h.settings())).rejects.toThrow('repositoryUnset')
  })

  it('restarts a chat-only prototype once, then registers the Source and seeds the local sender', async () => {
    const h = harness()
    expect(await connectSuperagent(h.ctx, h.store)).toBeUndefined()
    expect(h.setup.restarts).toBe(1)
    expect(h.registered).toHaveLength(0)

    h.setConfigured(true)
    const registration = await connectSuperagent(h.ctx, h.store)
    expect(registration?.orchestrator).toBe(h.orchestrator)
    expect(h.registered[0]).toMatchObject({ kind: 'super-chat', health: ['super-chat'] })
    expect(h.reports).toContainEqual(expect.objectContaining({ entry: 'super-chat' }))
    expect(h.save).toHaveBeenCalledWith('policy', expect.objectContaining({
      sources: expect.objectContaining({ 'super-chat': { allowed: [{ id: 'local', name: 'Local user' }], admission: {} } }),
    }), 1, 'sync')
  })

  it('uses the first topic as the dispatch thread and keeps every tag as a cue', () => {
    const design = topic('tp-design', 'Design')
    const urgent = topic('tp-urgent', 'Urgent')
    expect(dispatchThread()).toBe('general')
    expect(dispatchThread(design.id)).toBe('topic:' + design.id)
    expect(threadKey('general')).toBe('super-chat:general')
    expect(cueText(message([design.id]), [design])).toBe('[topics: Design]\nfix it')
    expect(cueText(message(), [])).toBe('fix it')

    const trigger = chatTrigger(message([design.id, urgent.id]), [design, urgent])
    expect(trigger).toMatchObject({
      id: 'super-chat-u1',
      threads: [{ source: 'super-chat', id: 'topic:' + design.id }],
      channel: { source: 'super-chat', thread: 'topic:' + design.id, address: { topics: design.id + ',' + urgent.id } },
      meta: {
        chat_message_id: 'u1',
        topic_ids: [design.id, urgent.id],
        topic_names: ['Design', 'Urgent'],
        dispatch: 'topic',
      },
    })
    expect(chatTrigger(message(), []).meta.dispatch).toBe('general')
  })

  it('registers a chat Source whose Channel and context use the stream', async () => {
    const h = harness()
    const design = h.store.ensureTopic('Design', at)
    h.store.appendUser({ id: 'u1', text: 'fix it', at, tags: [design.id] })
    const kind = createSourceKind(h.store) as {
      channel: { send(host: unknown, message: unknown): Promise<string> }
      threadContext: { messageId(trigger: unknown): string; read(host: unknown, trigger: unknown): Promise<{ messages: unknown[] }> }
    }
    expect(await kind.channel.send({}, { id: 'a1', text: 'working on it', channel: { source: 'super-chat', thread: 'topic:' + design.id, address: { topics: design.id } } })).toBe('sent')
    expect(h.store.messages(design.id).at(-1)).toMatchObject({ role: 'agent', text: 'working on it', tags: [design.id] })

    const trigger = chatTrigger(message([design.id]), [design])
    expect(kind.threadContext.messageId(trigger)).toBe('u1')
    const read = await kind.threadContext.read({}, trigger)
    expect(read.messages).toContainEqual(expect.objectContaining({ id: 'u1', from: 'local', text: expect.stringContaining('[Design]') }))
  })

  it('delivers, tracks and stops work on the selected dispatch thread', async () => {
    const h = harness({ configured: true })
    const design = h.store.ensureTopic('Design', at)
    const chat = new SuperagentChat(h.ctx, h.store)
    await chat.refresh()
    expect(chat.available()).toBe(true)
    expect(chat.mode()).toBe('superagent')

    const entry = message([design.id])
    h.store.appendUser(entry)
    await chat.deliver(entry, [design])
    expect(h.received).toHaveLength(1)
    expect(h.received[0]).toMatchObject({
      text: '[topics: Design]\nfix it',
      threads: [{ source: 'super-chat', id: 'topic:' + design.id }],
      meta: { topic_ids: [design.id], dispatch: 'topic' },
    })

    h.threads.set(threadKey('topic:' + design.id), { subscriptions: ['ticket-1'] })
    h.tickets.set('ticket-1', { id: 'ticket-1' })
    expect(chat.busy(design.id)).toBe(true)
    expect(await chat.cancel(design.id)).toBe(true)
    expect(h.orchestrator.engine?.stopTicket).toHaveBeenCalledWith('ticket-1')
    h.tickets.set('ticket-1', { id: 'ticket-1', ended: {} })
    expect(chat.busy(design.id)).toBe(false)
    chat.stop()
  })

  it('stays unavailable until the prototype is configured, then reports delivery errors inline', async () => {
    const h = harness({ configured: false })
    const chat = new SuperagentChat(h.ctx, h.store)
    await chat.refresh()
    expect(chat.available()).toBe(false)
    h.setConfigured(true)
    await chat.refresh()
    h.context.receive.mockRejectedValueOnce(new Error('engine down'))
    const entry = message()
    h.store.appendUser(entry)
    await chat.deliver(entry, [])
    expect(h.store.messages().at(-1)).toMatchObject({ role: 'agent', kind: 'error', tags: [] })
    expect(h.store.messages().at(-1)?.text).toContain('engine down')
    chat.stop()
  })

  it('unregisters the Source if stop() is called while connectSuperagent is in flight', async () => {
    const h = harness({ configured: true })
    let releaseReady!: () => void
    ;(h.orchestrator as { ready: Promise<void> }).ready = new Promise<void>(resolve => { releaseReady = resolve })
    let unregistered = 0
    h.orchestrator.sources.register = vi.fn(() => () => { unregistered += 1 })

    const chat = new SuperagentChat(h.ctx, h.store)
    const refreshing = chat.refresh()
    chat.stop()
    releaseReady()
    await refreshing
    expect(unregistered).toBe(0)
    expect(chat.available()).toBe(false)
  })
})
