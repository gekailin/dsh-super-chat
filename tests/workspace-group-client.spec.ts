import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '../src/client/dsh.ts'
import { installWorkspaceGroup } from '../src/client/workspace-group.ts'
import type { WorkspaceGroupInfo, WorkspaceGroupSnapshot } from '../src/workspace-group.ts'

const group: WorkspaceGroupInfo = {
  root: '/tmp/superagent',
  workRoot: '/tmp/superagent/work',
  workspaceId: 'group',
  title: 'Superagent',
  orchestratorSessionId: 'orchestrator',
}

function source(initial: WorkspaceGroupSnapshot) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    change(next: WorkspaceGroupSnapshot) { snapshot = next; for (const listener of [...listeners]) listener() },
    listeners,
  }
}

const base = (): WorkspaceGroupSnapshot => ({
  items: [
    { workspaceId: 'group', path: '/tmp/superagent', title: 'Superagent', sessionIds: ['orchestrator'] },
    { workspaceId: 'ticket', path: '/tmp/superagent/work/ticket', title: 'ticket', sessionIds: ['worker'] },
  ],
})

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function fixture(load: () => Promise<WorkspaceGroupInfo | undefined>) {
  const list = source(base())
  const ctx = { workspaces: { list } } as unknown as ClientContext
  return { list, ctx, dispose: installWorkspaceGroup(ctx, { load, pollMs: 60_000 }) }
}

describe('Superagent workspace group browser projection', () => {
  it('merges ticket groups once the Host facts arrive and keeps snapshot identity stable', async () => {
    const { list, dispose } = fixture(async () => group)
    const before = list.getSnapshot()
    await tick()
    const merged = list.getSnapshot()
    expect(merged).not.toBe(before)
    expect(merged.items.map(item => item.workspaceId)).toEqual(['group'])
    expect(merged.items[0]!.sessionIds).toEqual(['orchestrator', 'worker'])
    expect(list.getSnapshot()).toBe(merged)
    await tick()
    expect(list.getSnapshot()).toBe(merged)
    dispose()
  })

  it('notifies subscribers when the grouping arrives and restores the source on dispose', async () => {
    const { list, dispose } = fixture(async () => group)
    const listener = vi.fn()
    const off = list.subscribe(listener)
    await tick()
    expect(listener).toHaveBeenCalled()
    expect(list.getSnapshot().items).toHaveLength(1)
    dispose()
    off()
    expect(list.getSnapshot().items).toHaveLength(2)
    expect(listeners(list)).toBe(0)
  })

  it('tracks a later Host snapshot with the same group facts', async () => {
    const { list, dispose } = fixture(async () => group)
    await tick()
    const next = base()
    list.change({ ...next, items: [...next.items] })
    expect(list.getSnapshot().items).toHaveLength(1)
    dispose()
  })

  it('does nothing when the workspace service or a group is absent', async () => {
    const dispose = installWorkspaceGroup({} as ClientContext)
    expect(dispose).not.toThrow()
    const { list, dispose: stop } = fixture(async () => undefined)
    await tick()
    expect(list.getSnapshot().items).toHaveLength(2)
    stop()
  })
})

/** Number of listeners registered on the source wrapper. */
function listeners(list: { listeners: Set<() => void> }): number {
  return list.listeners.size
}
