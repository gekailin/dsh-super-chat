import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ensureWorkspaceGroup, readWorkspaceGroup } from '../src/workspace-group-host.ts'

interface FakeWorkspace {
  id: string
  title: string
  sessionIds: string[]
  attachSession(sessionId: string): Promise<void>
  setTitle(title: string): Promise<void>
}

function harness(options: { stateDir?: string; masterId?: string; executor?: string; sessions?: string[]; pinned?: string[]; title?: string } = {}) {
  const sessions = options.sessions ?? []
  const pinned = options.pinned ?? []
  const workspace: FakeWorkspace = {
    id: 'workspace-group',
    title: options.title ?? 'Superagent',
    sessionIds: sessions,
    attachSession: vi.fn(async (sessionId: string) => { sessions.push(sessionId) }),
    setTitle: vi.fn(async (title: string) => { workspace.title = title }),
  }
  const registry = {
    create: vi.fn(async (_path: string, _title?: string) => workspace),
    pinnedSessionIds: pinned,
    pinSession: vi.fn(async (sessionId: string) => { pinned.unshift(sessionId) }),
  }
  const settings = { executor: options.executor ? { directory: options.executor } : {} }
  const orchestrator = {
    machine: { stateDir: options.stateDir ?? '/tmp/superagent' },
    masterId: options.masterId ?? 'orchestrator-1',
    store: { settings: () => settings },
  }
  const ctx = { workspaceRegistry: registry } as unknown as Context
  return { ctx, orchestrator, registry, workspace, sessions, pinned }
}

describe('Superagent workspace group host half', () => {
  it('creates the group workspace, attaches and pins the orchestrator', async () => {
    const { ctx, orchestrator, registry, sessions, pinned } = harness()
    const info = await ensureWorkspaceGroup(ctx, orchestrator)
    expect(registry.create).toHaveBeenCalledWith('/tmp/superagent', 'Superagent')
    expect(sessions).toEqual(['orchestrator-1'])
    expect(pinned).toEqual(['orchestrator-1'])
    expect(info).toEqual({
      root: '/tmp/superagent', workRoot: '/tmp/superagent/work', workspaceId: 'workspace-group',
      title: 'Superagent', orchestratorSessionId: 'orchestrator-1',
    })
  })

  it('renames a workspace still carrying the state directory basename', async () => {
    const { ctx, orchestrator, workspace } = harness({ title: 'superagent' })
    const info = await ensureWorkspaceGroup(ctx, orchestrator)
    expect(workspace.setTitle).toHaveBeenCalledWith('Superagent')
    expect(info?.title).toBe('Superagent')
  })

  it('uses the configured executor directory as the ticket root', () => {
    const { ctx, orchestrator } = harness({ executor: '/tmp/tickets' })
    expect(readWorkspaceGroup(orchestrator)?.workRoot).toBe('/tmp/tickets')
  })

  it('does not attach or pin twice', async () => {
    const { ctx, orchestrator, registry } = harness({ sessions: ['orchestrator-1'], pinned: ['orchestrator-1'] })
    await ensureWorkspaceGroup(ctx, orchestrator)
    expect(registry.create).toHaveBeenCalledTimes(1)
    expect(registry.pinSession).not.toHaveBeenCalled()
  })

  it('keeps the group usable when attach or pin is refused', async () => {
    const { ctx, orchestrator, workspace, registry } = harness()
    workspace.attachSession = vi.fn(async () => { throw new Error('header cwd mismatch') })
    registry.pinSession = vi.fn(async () => { throw new Error('unknown session') })
    const info = await ensureWorkspaceGroup(ctx, orchestrator)
    expect(info?.workspaceId).toBe('workspace-group')
    expect(info?.orchestratorSessionId).toBe('orchestrator-1')
  })

  it('does nothing without a state directory or workspace registry', async () => {
    const { ctx, orchestrator } = harness()
    expect(await ensureWorkspaceGroup(ctx, { ...orchestrator, machine: undefined })).toBeUndefined()
    expect(await ensureWorkspaceGroup({} as Context, orchestrator)).toBeUndefined()
    expect(readWorkspaceGroup({ ...orchestrator, machine: { stateDir: '' } })).toBeUndefined()
  })

  it('falls back to the state work directory when settings cannot be read', () => {
    const { ctx, orchestrator } = harness()
    const broken = { ...orchestrator, store: { settings: () => { throw new Error('unavailable') } } }
    expect(readWorkspaceGroup(broken)?.workRoot).toBe('/tmp/superagent/work')
  })
})
