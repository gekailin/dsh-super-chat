/**
 * DSH has no public extension point for "a Session that belongs to a plugin but is not a user
 * session": every persisted Session is listed by the Session Controller and rendered by the
 * workspace browser. Super Chat's conversations are real Sessions, so without this patch each new
 * chat would also appear as a stray row in the workspace sidebar, and opening it there would show a
 * transcript the panel does not own. The public Session API has no visibility flag, so the plugin
 * filters its own Session ids out of the list response and restores the original method on dispose.
 *
 * The patch is intentionally narrow: it only filters rows, keeps the response shape, and does not
 * touch `create`, `resolveAgent`, `prompt` or `cancel`, which the chat panel continues to use.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { isChatSession } from './protocol.ts'

/** The slice of the Session Controller list response this patch needs. */
interface SessionList {
  items: readonly { sessionId: string }[]
}

/** The one Session Controller method the patch replaces. */
type ListMethod = (request: unknown, signal?: AbortSignal) => Promise<SessionList>

/** Replace `ctx.sessionController.list` with a filtering wrapper; returns the restoring disposer. */
export function hideChatSessions(ctx: Context): () => void {
  const controller = ctx.sessionController as unknown as { list?: ListMethod }
  const original = controller.list
  if (typeof original !== 'function') return () => {}
  const patched: ListMethod = async function (this: unknown, request, signal) {
    const value = await original.call(this, request, signal)
    if (!value || !Array.isArray(value.items)) return value
    return { ...value, items: value.items.filter(item => !isChatSession(item.sessionId)) }
  }
  controller.list = patched
  return () => {
    if (controller.list === patched) controller.list = original
  }
}
