/**
 * Shared description of the Superagent workspace group and the browser-side projection that folds
 * the prototype's per-ticket workspaces into it.
 *
 * The Host creates one Workspace over the prototype's state directory so the orchestrator Session
 * has a stable home. The browser then presents every Workspace under the executor's ticket root as
 * members of that same group; the Host registry is not rewritten and each ticket keeps its own
 * working directory.
 */

/** One Workspace as the browser projection sees it: the durable fields the grouping rewrite needs. */
export interface WorkspaceGroupView {
  readonly workspaceId: string
  readonly path: string
  readonly sessionIds: readonly string[]
  readonly [key: string]: unknown
}

/** A Workspace snapshot with the list the grouping rewrite replaces. */
export interface WorkspaceGroupSnapshot {
  readonly items: readonly WorkspaceGroupView[]
  readonly [key: string]: unknown
}

/** Group facts resolved on the Host and served to the browser. */
export interface WorkspaceGroupInfo {
  /** Canonical state directory whose Workspace owns the group. */
  root: string
  /** Ticket directory root whose child Workspaces are folded into the group. */
  workRoot: string
  /** Durable Workspace id that backs the group. */
  workspaceId: string
  /** Display title of the backing Workspace. */
  title: string
  /** Orchestrator Session, when the prototype has created it. */
  orchestratorSessionId?: string
}

/** API path serving {@link WorkspaceGroupInfo} to this plugin's browser half. */
export const WORKSPACE_GROUP_PATH = '/super-chat/api/workspace-group'

const trimmed = (path: string): string => path.replace(/[\\/]+$/u, '')

/** Whether `path` is `root` or one of its descendants, using the separator `root` was written with. */
export function withinDirectory(path: string, root: string): boolean {
  const filesystemRoot = root === '/' || /^[A-Za-z]:[\\/]$/u.test(root)
  const base = trimmed(root)
  if (!base) return filesystemRoot
  if (path === base) return true
  const separator = base.includes('\\') ? '\\' : '/'
  return path.startsWith(base.endsWith(separator) ? base : base + separator)
}

const unique = (ids: readonly string[]): string[] => {
  const seen = new Set<string>()
  return ids.filter(id => {
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/**
 * Fold the ticket Workspaces into the Superagent group.
 *
 * Every Workspace under `workRoot` is hidden from the browser and its Session ids join the group's
 * account. The group keeps its identity, title, path and position; all other Workspaces remain
 * untouched and in order. When the group is absent, or has no members to fold, the snapshot is
 * returned unchanged so deleting the group restores the normal per-ticket view.
 */
export function mergeWorkspaceGroup<T extends WorkspaceGroupSnapshot>(snapshot: T, group: WorkspaceGroupInfo | undefined): T {
  if (!group) return snapshot
  const index = snapshot.items.findIndex(workspace => workspace.workspaceId === group.workspaceId)
  if (index < 0) return snapshot
  const members = snapshot.items.filter(workspace =>
    workspace.workspaceId !== group.workspaceId && withinDirectory(workspace.path, group.workRoot))
  if (members.length === 0) return snapshot
  const groupWorkspace = snapshot.items[index]!
  const sessionIds = unique([
    ...(group.orchestratorSessionId ? [group.orchestratorSessionId] : []),
    ...groupWorkspace.sessionIds,
    ...members.flatMap(workspace => workspace.sessionIds),
  ])
  const hidden = new Set(members.map(workspace => workspace.workspaceId))
  const items = snapshot.items.flatMap((workspace, position) => {
    if (hidden.has(workspace.workspaceId)) return []
    if (position !== index) return [workspace]
    return [{ ...workspace, sessionIds }]
  })
  return { ...snapshot, items }
}

/** Read the group description from an untrusted API response. */
export function workspaceGroupInfo(value: unknown): WorkspaceGroupInfo | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const { root, workRoot, workspaceId, title, orchestratorSessionId } = record
  if (typeof root !== 'string' || !root || typeof workRoot !== 'string' || !workRoot) return undefined
  if (typeof workspaceId !== 'string' || !workspaceId || typeof title !== 'string') return undefined
  return {
    root,
    workRoot,
    workspaceId,
    title,
    ...(typeof orchestratorSessionId === 'string' && orchestratorSessionId ? { orchestratorSessionId } : {}),
  }
}

/** Whether two group descriptions name the same grouping; used to avoid notifying for a no-op poll. */
export function sameWorkspaceGroup(left: WorkspaceGroupInfo | undefined, right: WorkspaceGroupInfo | undefined): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.root === right.root && left.workRoot === right.workRoot && left.workspaceId === right.workspaceId
    && left.title === right.title && left.orchestratorSessionId === right.orchestratorSessionId
}
