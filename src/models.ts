/**
 * Model vocabulary shared by the host and browser halves: role model selections, the catalog view,
 * and the chat directive that gives one new worker a chosen model.
 *
 * A role model is the same `{ provider, model, reasoningEffort? }` shape the prototype's
 * `eval.model` and `executor.model` settings use, so a value can travel between the panel and those
 * settings without translation.
 */

/** The two model roles the panel can configure. */
export type ModelRole = 'orchestrator' | 'worker'

/** A provider/model route plus an optional reasoning effort. */
export interface RoleModel {
  provider: string
  model: string
  reasoningEffort?: string
}

/** One selectable reasoning effort of an exact model route. */
export interface ModelEffort {
  id: string
  name: string
}

/** Selectable reasoning metadata for one exact model route. */
export interface ModelReasoning {
  efforts: readonly ModelEffort[]
  defaultEffort?: string
}

/** One model in the profile's catalog. */
export interface ModelInfo {
  id: string
  name: string
  reasoning?: ModelReasoning
}

/** One provider group of the profile's catalog. */
export interface ModelGroup {
  id: string
  name: string
  models: readonly ModelInfo[]
}

/** One provider whose catalog lookup failed. */
export interface ModelFailure {
  id: string
  name: string
  message: string
}

/** What the model settings dialog reads: the catalog and the configured roles. */
export interface ModelRolesView {
  /** Whether Superagent is available; without it there are no role settings to edit. */
  available: boolean
  /** Why the settings or catalog could not be read. */
  error?: string
  /** The deployment default used by a role that inherits its model. */
  default?: RoleModel
  orchestrator: RoleModel | null
  worker: RoleModel | null
  groups: readonly ModelGroup[]
  failures: readonly ModelFailure[]
}

/** The empty view served when Superagent or its catalog is unavailable. */
export const EMPTY_MODEL_ROLES: ModelRolesView = {
  available: false,
  orchestrator: null,
  worker: null,
  groups: [],
  failures: [],
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** Read a valid role model, or null for absent or malformed input. */
export function roleModelOf(value: unknown): RoleModel | null {
  if (!isRecord(value)) return null
  const provider = nonEmpty(value.provider)
  const model = nonEmpty(value.model)
  if (!provider || !model) return null
  if (value.reasoningEffort !== undefined && !nonEmpty(value.reasoningEffort)) return null
  const reasoningEffort = nonEmpty(value.reasoningEffort)
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}

/** Whether two role models are the same selection. */
export function sameRoleModel(left: RoleModel | null, right: RoleModel | null): boolean {
  if (!left || !right) return left === right
  return left.provider === right.provider && left.model === right.model
    && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
}

/** A short label such as `mccodex / deepseek-v4.1-flash · high`. */
export function modelLabel(model: RoleModel): string {
  return model.provider + ' / ' + model.model + (model.reasoningEffort ? ' · ' + model.reasoningEffort : '')
}

/** The models one provider exposes, or an empty list for an unknown or empty provider. */
export function modelsOf(groups: readonly ModelGroup[], provider: string | undefined): readonly ModelInfo[] {
  if (!provider) return []
  return groups.find(group => group.id === provider)?.models ?? []
}

/** The reasoning efforts one model route exposes. */
export function effortsOf(groups: readonly ModelGroup[], provider: string | undefined, model: string | undefined): readonly ModelEffort[] {
  return modelsOf(groups, provider).find(item => item.id === model)?.reasoning?.efforts ?? []
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'default', 'new', 'current', 'same', 'worker', 'model',
  '默认', '这个', '该', '此', '当前', '新', '同样',
])
const ZH_START = /(?:启动|启|起|开|新建|创建|派|拉|做|处理|跑|运行)/u
const ZH_WORKER = /(?:worker|工作单元|工单)/iu
const EN_START = /\b(?:start|spawn|launch|create|run)\b/i
const EN_WORKER = /\b(?:worker|ticket)\b/i
const ZH_QUOTED = /用\s*[“"「『']([^”"」』']{1,80})[”"」』']\s*模型/u
const ZH_BARE = /用\s*([^\s，,。;；:：!！?？"“”「」『』]{1,60})\s*模型/u
const EN_QUOTED = /\buse\s+["']([^"']{1,80})["']\s+model\b/i
const EN_BARE = /\buse\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9._/@:-]{0,79})\s+model\b/i

const trimRef = (value: string): string => value.trim().replace(/^[“"「『']+|[”"」』']+$/gu, '').trim()

/** Whether the message asks to start or run a new worker, the part that makes a model phrase a directive. */
function startsWorker(text: string): boolean {
  return (ZH_START.test(text) && ZH_WORKER.test(text)) || (EN_START.test(text) && EN_WORKER.test(text))
}

/**
 * The model reference of a chat directive such as `用 gemini4 模型启动一个新 worker 做…` or
 * `use gemini4 model to start a new worker for …`, or undefined when the message is ordinary chat.
 * The reference is returned as written; `resolveModelRef` turns it into a catalog route.
 */
export function parseWorkerModelDirective(text: string): string | undefined {
  if (!startsWorker(text)) return undefined
  for (const pattern of [ZH_QUOTED, EN_QUOTED, ZH_BARE, EN_BARE]) {
    const match = pattern.exec(text)
    if (!match?.[1]) continue
    const ref = trimRef(match[1])
    if (!ref || STOPWORDS.has(ref.toLowerCase())) continue
    return ref
  }
  return undefined
}

const splitEffort = (ref: string): { base: string; effort?: string } => {
  const at = ref.lastIndexOf('@')
  return at > 0 && at < ref.length - 1 ? { base: ref.slice(0, at), effort: ref.slice(at + 1) } : { base: ref }
}

interface Route { provider: string; model: ModelInfo }

const routes = (groups: readonly ModelGroup[]): Route[] =>
  groups.flatMap(group => group.models.map(model => ({ provider: group.id, model })))

/**
 * Resolve a reference to a catalog route. `provider/model`, `provider:model`, an exact model id or
 * an exact model name are accepted, case-insensitively; an optional `@effort` suffix selects a
 * reasoning effort. Ambiguous bare ids are rejected rather than guessed.
 */
export function resolveModelRef(raw: string, groups: readonly ModelGroup[]): { model: RoleModel } | { error: string } {
  const ref = trimRef(raw)
  const all = routes(groups)
  const find = (value: string): Route[] => {
    const lower = value.toLowerCase()
    if (!lower) return []
    const qualified = all.filter(route => lower === (route.provider + '/' + route.model.id).toLowerCase()
      || lower === (route.provider + ':' + route.model.id).toLowerCase())
    if (qualified.length) return qualified
    const byId = all.filter(route => lower === route.model.id.toLowerCase())
    if (byId.length) return byId
    return all.filter(route => lower === route.model.name.toLowerCase())
  }
  const pick = (value: string): { route?: Route; error?: string } => {
    const found = find(value)
    if (found.length === 0) return {}
    if (found.length > 1) {
      return { error: 'Model "' + value + '" is ambiguous; name it as provider/model. Providers: '
        + found.map(route => route.provider).join(', ') + '.' }
    }
    return { route: found[0]! }
  }
  let picked = pick(ref)
  let effort: string | undefined
  if (!picked.route && !picked.error) {
    const split = splitEffort(ref)
    if (split.effort) {
      const base = pick(split.base)
      if (base.route || base.error) { picked = base; effort = split.effort }
    }
  }
  if (picked.error) return { error: picked.error }
  if (!picked.route) return { error: 'Unknown model "' + ref + '". Use a provider/model from the model list.' }
  const { provider, model } = picked.route
  if (effort) {
    const efforts = model.reasoning?.efforts ?? []
    const match = efforts.find(item => item.id.toLowerCase() === effort!.toLowerCase())
    if (!match) {
      return { error: 'Model ' + provider + '/' + model.id + ' does not support reasoning effort "' + effort + '"'
        + (efforts.length ? '; available: ' + efforts.map(item => item.id).join(', ') + '.' : '.') }
    }
    return { model: { provider, model: model.id, reasoningEffort: match.id } }
  }
  return { model: { provider, model: model.id } }
}
