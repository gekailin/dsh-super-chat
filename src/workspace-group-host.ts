/**
 * Host half of the Superagent workspace grouping.
 *
 * One Workspace is created over the prototype's state directory and the orchestrator Session is
 * attached and pinned there. The browser then folds the per-ticket Workspaces into that group, so
 * the Workspace sidebar shows a single Superagent section whose first row is the orchestrator.
 * The registry stays authoritative for every Session's own workspace; nothing here moves a worker
 * out of its ticket directory or changes how it executes.
 */
import { basename, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceGroupInfo } from './workspace-group.ts'

/** Display title of the Workspace that owns the group. */
export const GROUP_TITLE = 'Superagent'

interface GroupWorkspace {
  readonly id: string
  readonly title: string
  readonly sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
  setTitle(title: string): Promise<void>
}

interface GroupRegistry {
  create(path: string, title?: string): Promise<GroupWorkspace>
  readonly pinnedSessionIds: readonly string[]
  pinSession(sessionId: string): Promise<void>
}

interface GroupOrchestrator {
  readonly machine?: unknown
  readonly masterId?: unknown
  readonly store: { settings(): unknown }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** Read the state directory and orchestrator Session id from the prototype Runtime surface. */
function runtimeFacts(orchestrator: GroupOrchestrator): { stateDir: string; orchestratorSessionId?: string } | undefined {
  const machine = isRecord(orchestrator.machine) ? orchestrator.machine : undefined
  const stateDir = machine && nonEmpty(machine.stateDir) ? resolve(machine.stateDir) : undefined
  if (!stateDir) return undefined
  const masterId = nonEmpty(orchestrator.masterId) ? orchestrator.masterId : undefined
  return { stateDir, ...(masterId ? { orchestratorSessionId: masterId } : {}) }
}

/** Ticket root for the current settings, matching the prototype's executor default. */
function ticketRoot(orchestrator: GroupOrchestrator, stateDir: string): string {
  try {
    const settings = orchestrator.store.settings()
    const executor = isRecord(settings) && isRecord(settings.executor) ? settings.executor : undefined
    if (executor && nonEmpty(executor.directory)) return resolve(executor.directory)
  } catch {
    // An unavailable settings snapshot falls back to the documented executor default.
  }
  return join(stateDir, 'work')
}

function registryOf(ctx: Context): GroupRegistry | undefined {
  const registry = (ctx as unknown as { workspaceRegistry?: GroupRegistry }).workspaceRegistry
  return registry && typeof registry.create === 'function' ? registry : undefined
}

/** Resolve the grouping facts without creating or mutating anything. */
export function readWorkspaceGroup(orchestrator: GroupOrchestrator): Omit<WorkspaceGroupInfo, 'workspaceId' | 'title'> | undefined {
  const facts = runtimeFacts(orchestrator)
  if (!facts) return undefined
  return {
    root: facts.stateDir,
    workRoot: ticketRoot(orchestrator, facts.stateDir),
    ...(facts.orchestratorSessionId ? { orchestratorSessionId: facts.orchestratorSessionId } : {}),
  }
}

/**
 * Create or reuse the group Workspace, attach the orchestrator Session and keep it pinned.
 *
 * Failures are contained: a Session that cannot be attached (for example a header written under a
 * different directory) still shows in the merged group because the browser receives its id, and a
 * pin the Host refuses does not stop the integration. Resolution inside `ensure` is idempotent, so
 * this runs again whenever the prototype service is replaced.
 * @param ctx - Host context providing the Workspace registry.
 * @param orchestrator - Prototype Runtime surface with machine, master id and settings.
 * @returns group facts, or undefined when the Runtime does not expose a state directory.
 */
export async function ensureWorkspaceGroup(ctx: Context, orchestrator: GroupOrchestrator): Promise<WorkspaceGroupInfo | undefined> {
  const info = readWorkspaceGroup(orchestrator)
  const registry = registryOf(ctx)
  if (!info || !registry) return undefined
  const workspace = await registry.create(info.root, GROUP_TITLE)
  let title = workspace.title
  if (title === basename(info.root) && title !== GROUP_TITLE) {
    try { await workspace.setTitle(GROUP_TITLE); title = GROUP_TITLE } catch { /* Keep the existing title. */ }
  }
  const sessionId = info.orchestratorSessionId
  if (sessionId && !workspace.sessionIds.includes(sessionId)) {
    try { await workspace.attachSession(sessionId) } catch { /* The browser still groups the id. */ }
  }
  if (sessionId && !registry.pinnedSessionIds.includes(sessionId)) {
    try { await registry.pinSession(sessionId) } catch { /* A refused pin leaves the group usable. */ }
  }
  return { ...info, workspaceId: workspace.id, title }
}
