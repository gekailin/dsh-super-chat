import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { GeneralSession } from '../src/session.ts'
import { ChatStore } from '../src/store.ts'
import type { Topic } from '../src/protocol.ts'

interface FakeAgent { id: string; status: 'idle' | 'running'; session: object }

function harness() {
  const agents = new Map<string, FakeAgent>()
  const listeners = new Map<string, (first: unknown, second: unknown) => void>()
  const created: unknown[] = []
  const prompts: unknown[] = []
  const cancels: unknown[] = []
  const renames: unknown[] = []
  const presets: string[] = []
  const ctx = {
    on(event: string, listener: (first: unknown, second: unknown) => void) {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    agents: { get: (id: string) => agents.get(id) },
    sessionController: {
      async resolveAgent(id: string) {
        const agent = agents.get(id)
        return agent ? { agent } : { error: { code: 'session/not-found' } }
      },
      async create(request: { sessionId: string }) {
        created.push(request)
        const agent: FakeAgent = { id: request.sessionId, status: 'idle', session: {} }
        agents.set(request.sessionId, agent)
        return { sessionId: request.sessionId }
      },
      async prompt(request: unknown) { prompts.push(request) },
      async rename(request: unknown) { renames.push(request) },
      cancel(request: unknown) { cancels.push(request) },
    },
    permissionPresets: { set(_session: object, name: string) { presets.push(name) } },
    logger: { warn() {} },
  }
  const dir = mkdtempSync(join(tmpdir(), 'super-chat-session-'))
  const store = new ChatStore(join(dir, 'chat.sqlite'))
  store.load()
  return { ctx: ctx as unknown as Context, agents, listeners, created, prompts, cancels, renames, presets, store, dir }
}

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

describe('GeneralSession', () => {
  it('uses one Session, sends the topic cue and mirrors replies into the stream', async () => {
    const host = harness()
    const session = new GeneralSession(host.ctx, host.store, { cwd: '/work', agentPreset: 'standard', permissionPreset: 'danger-full-access' })
    const stop = session.start()
    cleanup = () => { stop(); host.store.close(); rmSync(host.dir, { recursive: true, force: true }) }

    const topic: Topic = host.store.ensureTopic('Design', '2026-01-01T00:00:00Z')
    const message = { id: 'u1', role: 'user' as const, text: 'fix it', at: '2026-01-01T00:00:00Z', tags: [topic.id], via: 'panel' as const }
    host.store.appendUser(message)
    await session.deliver(message, [topic])

    expect(host.created).toEqual([{ sessionId: 'super-chat-general', cwd: '/work', agentPreset: 'standard' }])
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]).toMatchObject({ sessionId: 'super-chat-general', mode: 'queue' })
    expect((host.prompts[0] as { content: { text: string }[] }).content[0]?.text).toBe('[topics: Design]\nfix it')
    expect(host.presets).toEqual(['danger-full-access'])
    expect(session.mode()).toBe('session')

    const emit = host.listeners.get('session/event')!
    emit({ id: 'super-chat-general' }, {
      type: 'assistant/message', seq: 7, time: Date.now(),
      data: { message: { content: [{ type: 'text', text: 'Working on it' }] } },
    } as unknown as SessionEvent)
    expect(host.store.messages()).toContainEqual(expect.objectContaining({ role: 'agent', text: 'Working on it', tags: [topic.id] }))

    host.agents.get('super-chat-general')!.status = 'running'
    expect(session.busy()).toBe(true)
    host.agents.get('super-chat-general')!.status = 'idle'
    expect(session.busy()).toBe(false)

    expect(await session.cancel()).toBe(true)
    expect(host.cancels).toEqual([{ sessionId: 'super-chat-general' }])
    expect(await session.cancel()).toBe(true)
    expect(await session.cancel('tp-1')).toBe(false)
  })

  it('keeps a delivery failure inline in the same tags', async () => {
    const host = harness()
    const session = new GeneralSession(host.ctx, host.store, { cwd: '/work' })
    const stop = session.start()
    cleanup = () => { stop(); host.store.close(); rmSync(host.dir, { recursive: true, force: true }) }
    ;(host.ctx.sessionController as unknown as { prompt: () => Promise<void> }).prompt = async () => {
      throw new Error('no model configured')
    }
    const topic = host.store.ensureTopic('Design', '2026-01-01T00:00:00Z')
    const message = { id: 'u2', role: 'user' as const, text: 'hello', at: '2026-01-01T00:00:00Z', tags: [topic.id] }
    host.store.appendUser(message)
    await session.deliver(message, [])
    expect(host.store.messages().at(-1)).toMatchObject({ role: 'agent', kind: 'error', tags: [topic.id] })
    expect(host.store.messages().at(-1)?.text).toContain('no model configured')
  })
})
