/** Loopback HTTP API the Super Chat panel calls on the DSH web server's origin. */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  MAX_BODY, MAX_TEXT, VIEW_LIMIT, cleanTopicName, validMessageId, validTopicId,
  type ChatMessage, type ChatView, type Topic,
} from './protocol.ts'
import type { ChatStore } from './store.ts'
import type { ChatTransport } from './transport.ts'
import type { WorkspaceGroupInfo } from './workspace-group.ts'

/** Everything the HTTP layer needs. */
export interface ApiDeps {
  store: ChatStore
  transport: ChatTransport
  /** On-demand model-backed tagging; absent only in tests that do not exercise it. */
  tagger?: { tag(): Promise<{ tagged: number }> }
  /** On-demand WeChat bridge manager; absent only in tests that do not exercise it. */
  wechat?: { ensure(): Promise<unknown> }
  /** Listening web-server port, used for the same-origin check. */
  port: number
  /** Configured bind address, used for the same-origin check. */
  host: string
  /** Current Superagent workspace group; absent when Superagent is not integrated. */
  workspaceGroup?: () => WorkspaceGroupInfo | undefined
}

const REQUEST_HEADER = 'x-super-chat-request'

const writeJson = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

const hostOf = (host: string, port: number): string => host.includes(':') ? '[' + host + ']:' + port : host + ':' + port

function sameOrigin(req: IncomingMessage, deps: Pick<ApiDeps, 'host' | 'port'>): boolean {
  const authority = req.headers.host
  if (!authority) return false
  const allowed = new Set([hostOf(deps.host, deps.port), '127.0.0.1:' + deps.port, 'localhost:' + deps.port, '[::1]:' + deps.port])
  if (!allowed.has(authority)) return false
  if (req.headers[REQUEST_HEADER] !== '1') return false
  const origin = req.headers.origin
  return origin === undefined || origin === 'http://' + authority || origin === 'https://' + authority
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Buffer)
    size += bytes.length
    if (size > MAX_BODY) throw new Error('Request body exceeds ' + MAX_BODY + ' bytes')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new Error('Request body is not JSON')
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const topicParam = (value: string | null): string | undefined => {
  if (!value) return undefined
  if (!validTopicId(value)) throw new Error('Invalid topic id')
  return value
}

const topicNames = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').map(cleanTopicName).filter(Boolean)
  : []

class NotFound extends Error {}

/** Build the request handler registered on /super-chat. */
export function createApi(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const view = (topicId?: string): ChatView => {
    if (topicId && !deps.store.topic(topicId)) throw new NotFound('Unknown topic')
    const topics = deps.store.topics().map(topic => deps.transport.busy(topic.id) ? { ...topic, busy: true } : topic)
    const topic = topicId ? topics.find(item => item.id === topicId) : undefined
    return {
      ...(topic ? { topic } : {}),
      topics,
      messages: deps.store.messages(topicId, VIEW_LIMIT),
      mode: deps.transport.mode(),
      ...(deps.transport.busy(topicId) ? { busy: true } : {}),
    }
  }

  const selected = (body: Record<string, unknown>): string | undefined => {
    const topic = body.topic
    if (topic === undefined || topic === null || topic === '') return undefined
    if (typeof topic !== 'string' || !validTopicId(topic)) throw new Error('Invalid topic id')
    if (!deps.store.topic(topic)) throw new NotFound('Unknown topic')
    return topic
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/super-chat/api/')) {
      writeJson(res, 404, { error: 'Not found' })
      return
    }
    if (!sameOrigin(req, deps)) {
      writeJson(res, 403, { error: 'A same-origin Super Chat request is required' })
      return
    }
    const path = url.pathname.slice('/super-chat/api/'.length)
    try {
      if (path === 'health' && req.method === 'GET') {
        const stats = deps.store.stats()
        writeJson(res, 200, { ok: true, messages: stats.messages, topics: stats.topics })
        return
      }
      if (path === 'workspace-group' && req.method === 'GET') {
        writeJson(res, 200, { group: deps.workspaceGroup?.() ?? null })
        return
      }
      if (path === 'wechat/start' && req.method === 'POST') {
        if (!deps.wechat) throw new NotFound('WeChat bridge is not available')
        const result = await deps.wechat.ensure()
        writeJson(res, 200, { ok: true, result })
        return
      }
      if (path === 'chat' && req.method === 'GET') {
        const topic = topicParam(url.searchParams.get('topic'))
        writeJson(res, 200, view(topic))
        return
      }
      if (path === 'chat' && req.method === 'POST') {
        const body = await readBody(req)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) throw new Error('A message is required')
        if (text.length > MAX_TEXT) throw new Error('A message is limited to ' + MAX_TEXT + ' characters')
        const selectedTopic = selected(body)
        const clientId = typeof body.clientId === 'string' && validMessageId(body.clientId) ? body.clientId : randomUUID()
        const requested = body.tags
        if (requested !== undefined && !Array.isArray(requested)) throw new Error('tags must be an array')
        const at = new Date().toISOString()
        if (deps.store.hasMessage(clientId)) {
          writeJson(res, 200, { result: 'duplicate', ...view(selectedTopic) })
          return
        }
        const topics = deps.store.resolveTags(topicNames(requested), at)
        const { message, created } = deps.store.appendUser({
          id: clientId,
          text,
          at,
          tags: topics.map(topic => topic.id),
          via: body.via === 'wechat' ? 'wechat' : 'panel',
        })
        if (!created) {
          writeJson(res, 200, { result: 'duplicate', ...view(selectedTopic) })
          return
        }
        try {
          await deps.transport.deliver(message, topics)
        } catch (error) {
          deps.store.appendAgent({
            id: 'error-' + clientId,
            text: 'Could not deliver this message: ' + (error instanceof Error ? error.message : String(error)),
            at: new Date().toISOString(),
            tags: message.tags,
            kind: 'error',
          })
        }
        writeJson(res, 200, { result: 'stored', ...view(selectedTopic ?? topics[0]?.id) })
        return
      }
      if (path === 'chat/tag' && req.method === 'POST') {
        if (!deps.tagger) throw new NotFound('Automatic tagging is not available')
        const result = await deps.tagger.tag()
        writeJson(res, 200, { tagged: result.tagged, ...view() })
        return
      }
      if (path === 'chat/tags' && req.method === 'POST') {
        const body = await readBody(req)
        if (!isRecord(body) || typeof body.id !== 'string' || !body.id.trim()) throw new Error('Invalid message id')
        if (!Array.isArray(body.tags)) throw new Error('tags must be an array')
        const selectedTopic = selected(body)
        const updated = deps.store.setMessageTags(body.id, topicNames(body.tags), new Date().toISOString())
        if (!updated) throw new NotFound('Unknown message')
        writeJson(res, 200, { result: 'updated', ...view(selectedTopic) })
        return
      }
      if (path === 'topics' && req.method === 'POST') {
        const body = await readBody(req)
        if (!isRecord(body) || typeof body.name !== 'string') throw new Error('A topic name is required')
        const name = cleanTopicName(body.name)
        if (!name) throw new Error('A topic name is required')
        const topic = deps.store.ensureTopic(name, new Date().toISOString())
        writeJson(res, 200, { topic, topics: deps.store.topics().map(item => deps.transport.busy(item.id) ? { ...item, busy: true } : item) })
        return
      }
      if (path === 'topics/rename' && req.method === 'POST') {
        const body = await readBody(req)
        if (!isRecord(body) || typeof body.id !== 'string' || !validTopicId(body.id)) throw new Error('Invalid topic id')
        if (typeof body.name !== 'string') throw new Error('A topic name is required')
        if (!deps.store.topic(body.id)) throw new NotFound('Unknown topic')
        if (!deps.store.renameTopic(body.id, body.name)) throw new Error('A topic with that name already exists')
        writeJson(res, 200, { topic: deps.store.topic(body.id), topics: deps.store.topics().map(item => deps.transport.busy(item.id) ? { ...item, busy: true } : item) })
        return
      }
      if (path === 'chat/cancel' && req.method === 'POST') {
        const body = await readBody(req)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const topic = selected(body)
        const cancelled = await deps.transport.cancel(topic)
        writeJson(res, 200, { cancelled, ...view(topic) })
        return
      }
      writeJson(res, 404, { error: 'Unknown operation' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof NotFound ? 404 : /required|Invalid|limited|must be|not JSON|exceeds|too many|already exists|at least one topic/iu.test(message) ? 400 : 500
      writeJson(res, status, { error: message })
    }
  }
}
