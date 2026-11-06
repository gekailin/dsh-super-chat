import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { hideChatSessions } from '../src/monkey.ts'

interface Row { sessionId: string }

function fakeContext(rows: Row[], counter: { calls: number }) {
  const controller = {
    prefix: 'kept',
    async list(_request: unknown, _signal?: AbortSignal) {
      counter.calls += 1
      return { items: rows, marker: this.prefix }
    },
  }
  return { ctx: { sessionController: controller } as unknown as Context, controller }
}

describe('hideChatSessions', () => {
  it('filters Super Chat sessions out of the Session list response', async () => {
    const counter = { calls: 0 }
    const { ctx, controller } = fakeContext([
      { sessionId: 'super-chat-local' },
      { sessionId: 'worker-1' },
      { sessionId: 'super-chat-t-2' },
    ], counter)
    const restore = hideChatSessions(ctx)
    const value = await controller.list({}, undefined) as { items: Row[]; marker: string }
    expect(value.items.map(item => item.sessionId)).toEqual(['worker-1'])
    expect(value.marker).toBe('kept')
    expect(counter.calls).toBe(1)
    restore()
    const restored = await controller.list({}, undefined) as { items: Row[] }
    expect(restored.items).toHaveLength(3)
  })

  it('restores only its own wrapper', async () => {
    const counter = { calls: 0 }
    const { ctx, controller } = fakeContext([{ sessionId: 'super-chat-local' }], counter)
    const first = hideChatSessions(ctx)
    const second = hideChatSessions(ctx)
    // The earlier restore is a no-op while a later wrapper sits on top.
    first()
    expect((await controller.list({}, undefined) as { items: Row[] }).items).toEqual([])
    // Restoring the later wrapper exposes the earlier one, still filtering.
    second()
    expect((await controller.list({}, undefined) as { items: Row[] }).items).toEqual([])
    first()
    expect((await controller.list({}, undefined) as { items: Row[] }).items).toHaveLength(1)
  })

  it('does nothing for a controller without a list method', () => {
    const ctx = { sessionController: {} } as unknown as Context
    expect(() => hideChatSessions(ctx)()).not.toThrow()
  })
})
