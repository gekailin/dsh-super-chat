/**
 * Browser half of the Superagent workspace grouping.
 *
 * The Host creates one Workspace over the prototype's state directory. This module folds the
 * per-ticket Workspaces into that group in the client Workspace snapshot, so the sidebar renders a
 * single Superagent section while the Host registry and every Session's working directory stay as
 * they are. The wrapper is installed once, keeps a stable snapshot for React, and is removed when
 * the plugin stops.
 */
import {
  WORKSPACE_GROUP_PATH, mergeWorkspaceGroup, sameWorkspaceGroup, workspaceGroupInfo,
  type WorkspaceGroupInfo, type WorkspaceGroupSnapshot,
} from '../workspace-group.ts'
import type { ClientContext, WorkspaceSource } from './dsh.ts'

/** Re-check the Host grouping facts; a Host restart can replace the backing Workspace. */
const POLL_MS = 5000

/** Fetch the group facts from this plugin's own API; unavailable when Superagent is not running. */
async function loadWorkspaceGroup(): Promise<WorkspaceGroupInfo | undefined> {
  const response = await fetch(WORKSPACE_GROUP_PATH, { headers: { 'x-super-chat-request': '1' } })
  if (!response.ok) return undefined
  const body = await response.json() as { group?: unknown }
  return workspaceGroupInfo(body.group)
}

/** Install the snapshot projection; returns the disposer that restores the original source. */
export function installWorkspaceGroup(
  ctx: ClientContext,
  options: { load?: () => Promise<WorkspaceGroupInfo | undefined>; pollMs?: number } = {},
): () => void {
  const source: WorkspaceSource | undefined = ctx.workspaces?.list
  if (!source || typeof source.getSnapshot !== 'function' || typeof source.subscribe !== 'function') return () => {}
  const read = source.getSnapshot
  const subscribe = source.subscribe
  const listeners = new Set<() => void>()
  const load = options.load ?? loadWorkspaceGroup
  const pollMs = options.pollMs ?? POLL_MS
  let group: WorkspaceGroupInfo | undefined
  let stopped = false
  let lastRaw: unknown
  let lastGroup: WorkspaceGroupInfo | undefined
  let lastSnapshot: WorkspaceGroupSnapshot

  /** Keep the returned snapshot identical while neither the Host snapshot nor the group changed. */
  const merged = (): WorkspaceGroupSnapshot => {
    const raw = read.call(source)
    if (raw === lastRaw && group === lastGroup) return lastSnapshot
    lastRaw = raw
    lastGroup = group
    lastSnapshot = mergeWorkspaceGroup(raw, group)
    return lastSnapshot
  }

  const wrappedSubscribe = (listener: () => void) => {
    listeners.add(listener)
    const off = subscribe.call(source, listener)
    return () => { listeners.delete(listener); off() }
  }
  source.getSnapshot = merged
  source.subscribe = wrappedSubscribe

  const notify = (): void => { for (const listener of [...listeners]) listener() }
  const accept = (value: WorkspaceGroupInfo | undefined): void => {
    if (stopped || sameWorkspaceGroup(group, value)) return
    group = value
    notify()
  }
  const poll = (): void => { load().then(accept, () => { /* The Host may still be starting. */ }) }
  poll()
  const timer = setInterval(poll, pollMs)

  return () => {
    stopped = true
    clearInterval(timer)
    // A later plugin may have wrapped the source after this one; only undo this plugin's layer.
    if (source.getSnapshot === merged) source.getSnapshot = read
    if (source.subscribe === wrappedSubscribe) source.subscribe = subscribe
    notify()
  }
}
