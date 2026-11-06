import { describe, expect, it } from 'vitest'
import {
  mergeWorkspaceGroup, sameWorkspaceGroup, withinDirectory, workspaceGroupInfo,
  type WorkspaceGroupInfo,
} from '../src/workspace-group.ts'

const group: WorkspaceGroupInfo = {
  root: '/tmp/superagent',
  workRoot: '/tmp/superagent/work',
  workspaceId: 'group',
  title: 'Superagent',
  orchestratorSessionId: 'orchestrator',
}

const workspace = (workspaceId: string, path: string, sessionIds: string[]) =>
  ({ workspaceId, path, title: workspaceId, sessionIds, createdAt: '2026-01-01T00:00:00.000Z' })

const snapshot = () => ({
  items: [
    workspace('other', '/tmp/project', ['s-other']),
    workspace('group', '/tmp/superagent', ['orchestrator']),
    workspace('a', '/tmp/superagent/work/ticket-a', ['worker-a']),
    workspace('b', '/tmp/superagent/work/ticket-b', ['worker-b']),
  ],
  archivedSessionIds: ['worker-b'],
  pinnedSessionIds: ['orchestrator'],
})

describe('Superagent workspace grouping projection', () => {
  it('folds ticket workspaces into the Superagent group and leaves other groups alone', () => {
    const merged = mergeWorkspaceGroup(snapshot(), group)
    expect(merged.items.map(item => item.workspaceId)).toEqual(['other', 'group'])
    expect(merged.items[1]!.sessionIds).toEqual(['orchestrator', 'worker-a', 'worker-b'])
    expect(merged.archivedSessionIds).toEqual(['worker-b'])
    expect(merged.pinnedSessionIds).toEqual(['orchestrator'])
  })

  it('returns the same snapshot when there is no group or no member to fold', () => {
    const original = snapshot()
    expect(mergeWorkspaceGroup(original, undefined)).toBe(original)
    expect(mergeWorkspaceGroup(original, { ...group, workspaceId: 'missing' })).toBe(original)
    expect(mergeWorkspaceGroup(original, { ...group, workRoot: '/tmp/elsewhere' })).toBe(original)
  })

  it('includes the orchestrator even when the Host could not attach it to the group', () => {
    const original = snapshot()
    const items = original.items.map(item => item.workspaceId === 'group'
      ? workspace('group', '/tmp/superagent', [])
      : item)
    const merged = mergeWorkspaceGroup({ ...original, items }, { ...group, orchestratorSessionId: 'orchestrator' })
    expect(merged.items[1]!.sessionIds).toEqual(['orchestrator', 'worker-a', 'worker-b'])
  })

  it('deduplicates session ids and keeps the group in its original position', () => {
    const original = snapshot()
    const items = original.items.map(item => item.workspaceId === 'group'
      ? workspace('group', '/tmp/superagent', ['worker-a'])
      : item)
    const merged = mergeWorkspaceGroup({ ...original, items }, group)
    expect(merged.items.map(item => item.workspaceId)).toEqual(['other', 'group'])
    expect(merged.items[1]!.sessionIds).toEqual(['orchestrator', 'worker-a', 'worker-b'])
  })

  it('recognises descendants without matching a sibling with a shared prefix', () => {
    expect(withinDirectory('/tmp/superagent/work/a', '/tmp/superagent/work')).toBe(true)
    expect(withinDirectory('/tmp/superagent/work', '/tmp/superagent/work/')).toBe(true)
    expect(withinDirectory('/tmp/superagent/worker', '/tmp/superagent/work')).toBe(false)
    expect(withinDirectory('/tmp/superagent/work/a', '/')).toBe(true)
  })

  it('validates the Host response and compares group identity', () => {
    expect(workspaceGroupInfo({ ...group })).toEqual(group)
    expect(workspaceGroupInfo({ ...group, orchestratorSessionId: '' })).toEqual({
      root: group.root, workRoot: group.workRoot, workspaceId: group.workspaceId, title: group.title,
    })
    expect(workspaceGroupInfo(null)).toBeUndefined()
    expect(workspaceGroupInfo({ root: '', workRoot: '/work', workspaceId: 'g', title: 'S' })).toBeUndefined()
    expect(sameWorkspaceGroup(group, { ...group })).toBe(true)
    expect(sameWorkspaceGroup(group, { ...group, workspaceId: 'other' })).toBe(false)
    expect(sameWorkspaceGroup(undefined, undefined)).toBe(true)
  })
})
