import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApi } from '../src/api.ts'
import { ChatStore } from '../src/store.ts'
import type { ChatTransport } from '../src/transport.ts'
import type { WorkspaceGroupInfo } from '../src/workspace-group.ts'

describe('Super Chat HTTP API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-chat-api-'))
  const store = new ChatStore(join(dir, 'chat.sqlite'))
  let server: Server
  let base = ''
  const deliver = vi.fn<(message: import('../src/protocol.ts').ChatMessage, topics: import('../src/protocol.ts').Topic[], options?: import('../src/transport.ts').DeliverOptions) => Promise<void>>(async () => {})
  const busy = vi.fn<(topicId?: string) => boolean>(() => false)
  const cancel = vi.fn<(topicId?: string) => Promise<boolean>>(async () => true)
  const mode = vi.fn<() => 'superagent' | 'session'>(() => 'superagent')
  const roles = {
    available: true,
    default: { provider: 'mccodex', model: 'deepseek-v4.1-flash' },
    orchestrator: { provider: 'mccodex', model: 'deepseek-v4.1-flash' },
    worker: null,
    groups: [{ id: 'mccodex', name: 'MCCODEX', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] }],
    failures: [],
  }
  const models = vi.fn(async () => roles)
  const setModel = vi.fn(async (_role: import('../src/models.ts').ModelRole, model: import('../src/models.ts').RoleModel | null) => ({
    ...roles, worker: model,
  }))
  const workerModel = vi.fn<(text: string) => Promise<{ model: import('../src/models.ts').RoleModel } | { error: string } | undefined>>(async () => undefined)
  // The methods require the transport receiver, as the real router does; a bare function
  // reference passed to the handler would lose `this` and must fail the test.
  const transport: ChatTransport & { receiver?: true } = {
    mode, deliver, busy, cancel, workerModel, receiver: true,
    async models() {
      if (!this.receiver) throw new Error('models called without the transport receiver')
      return models()
    },
    async setModel(role, model) {
      if (!this.receiver) throw new Error('setModel called without the transport receiver')
      return setModel(role, model)
    },
  }
  const ensureBridge = vi.fn(async () => 'started')
  const tag = vi.fn(async () => ({ tagged: 2 }))
  const workspaceGroup = vi.fn<() => WorkspaceGroupInfo | undefined>(() => undefined)
  let deps: { store: ChatStore; transport: ChatTransport; tagger?: { tag(): Promise<{ tagged: number }> }; wechat?: { ensure(): Promise<unknown> }; workspaceGroup?: () => WorkspaceGroupInfo | undefined; port: number; host: string }

  beforeAll(async () => {
    store.load()
    deps = { store, transport, tagger: { tag }, wechat: { ensure: ensureBridge }, workspaceGroup, port: 0, host: '127.0.0.1' }
    server = createServer(createApi(deps))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('unexpected address')
    deps.port = address.port
    base = 'http://127.0.0.1:' + address.port
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const call = (path: string, init?: RequestInit & { headers?: Record<string, string> }) =>
    fetch(base + path, {
      ...init,
      headers: { 'x-super-chat-request': '1', ...init?.body ? { 'content-type': 'application/json' } : {}, ...init?.headers },
    })

  it('rejects requests without the panel header or with a foreign Origin', async () => {
    expect((await fetch(base + '/super-chat/api/health')).status).toBe(403)
    expect((await call('/super-chat/api/health', { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await call('/super-chat/api/health', { headers: { origin: base } })).status).toBe(200)
  })

  it('serves the current Superagent workspace group', async () => {
    const info = { root: '/state/superagent', workRoot: '/state/superagent/work', workspaceId: 'w', title: 'Superagent', orchestratorSessionId: 'o' }
    workspaceGroup.mockReturnValueOnce(info)
    const response = await call('/super-chat/api/workspace-group')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ group: info })
    const empty = await call('/super-chat/api/workspace-group')
    expect(await empty.json()).toEqual({ group: null })
  })

  it('reports health and an empty general chat', async () => {
    expect(await (await call('/super-chat/api/health')).json()).toEqual({ ok: true, messages: 0, topics: 0 })
    expect(await (await call('/super-chat/api/chat')).json()).toMatchObject({ topics: [], messages: [], mode: 'superagent' })
  })

  it('serves model settings and saves one role model', async () => {
    const read = await call('/super-chat/api/models')
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual(roles)
    const save = await call('/super-chat/api/models', {
      method: 'POST',
      body: JSON.stringify({ role: 'worker', model: { provider: 'mccodex', model: 'glm-5.3', reasoningEffort: 'high' } }),
    })
    expect(save.status).toBe(200)
    expect(setModel).toHaveBeenCalledWith('worker', { provider: 'mccodex', model: 'glm-5.3', reasoningEffort: 'high' })
    expect(await save.json()).toMatchObject({ worker: { provider: 'mccodex', model: 'glm-5.3' } })
    const clear = await call('/super-chat/api/models', { method: 'POST', body: JSON.stringify({ role: 'orchestrator', model: null }) })
    expect(clear.status).toBe(200)
    expect(setModel).toHaveBeenLastCalledWith('orchestrator', null)
  })

  it('rejects malformed model saves and model settings without Superagent', async () => {
    expect((await call('/super-chat/api/models', { method: 'POST', body: JSON.stringify({ role: 'nobody', model: null }) })).status).toBe(400)
    expect((await call('/super-chat/api/models', {
      method: 'POST', body: JSON.stringify({ role: 'worker', model: { provider: '', model: 'x' } }),
    })).status).toBe(400)
    mode.mockReturnValueOnce('session')
    expect((await call('/super-chat/api/models', {
      method: 'POST', body: JSON.stringify({ role: 'worker', model: null }),
    })).status).toBe(409)
  })

  it('starts the WeChat bridge only when the panel asks', async () => {
    const response = await call('/super-chat/api/wechat/start', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, result: 'started' })
    expect(ensureBridge).toHaveBeenCalledTimes(1)
  })

  it('stores a general message and delivers it once', async () => {
    const response = await call('/super-chat/api/chat', {
      method: 'POST',
      body: JSON.stringify({ text: '  hello  ', clientId: 'client-1', via: 'panel' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: string; messages: { role: string; text: string; tags: string[] }[]; mode: string }
    expect(body.result).toBe('stored')
    expect(body.mode).toBe('superagent')
    expect(body.messages[0]).toMatchObject({ role: 'user', text: 'hello', tags: [] })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]![0]).toMatchObject({ id: 'client-1', text: 'hello', tags: [] })

    const duplicate = await call('/super-chat/api/chat', {
      method: 'POST', body: JSON.stringify({ text: 'changed', clientId: 'client-1' }),
    })
    expect((await duplicate.json() as { result: string }).result).toBe('duplicate')
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('creates tagged topics, filters a view and marks a busy topic', async () => {
    const response = await call('/super-chat/api/chat', {
      method: 'POST',
      body: JSON.stringify({ text: 'tagged request', tags: ['Design', 'Urgent'], clientId: 'client-2' }),
    })
    const body = await response.json() as { topics: { id: string; name: string; messageCount?: number }[]; messages: { tags: string[] }[]; topic?: { id: string; name: string } }
    expect(body.topics.map(topic => topic.name)).toEqual(expect.arrayContaining(['Design', 'Urgent']))
    expect(body.messages[0]?.tags).toHaveLength(2)
    const design = body.topics.find(topic => topic.name === 'Design')!
    expect(design.messageCount).toBe(1)
    const topics = deliver.mock.calls[1]?.[1] ?? []
    expect(topics.map(topic => topic.name)).toEqual(['Design', 'Urgent'])

    const view = await call('/super-chat/api/chat?topic=' + design.id)
    expect(await view.json()).toMatchObject({ topic: { name: 'Design' }, messages: [expect.objectContaining({ text: 'tagged request' })] })

    busy.mockReturnValue(true)
    const busyResponse = await call('/super-chat/api/chat?topic=' + design.id)
    expect(await busyResponse.json()).toMatchObject({ busy: true })
    busy.mockReturnValue(false)
  })

  it('pages topic views backwards and filters the untagged view with a count', async () => {
    const first = await (await call('/super-chat/api/chat', {
      method: 'POST', body: JSON.stringify({ text: 'paged topic one', tags: ['Paging'], clientId: 'page-t1' }),
    })).json() as { topic: { id: string } }
    const second = await (await call('/super-chat/api/chat', {
      method: 'POST', body: JSON.stringify({ text: 'paged topic two', tags: ['Paging'], clientId: 'page-t2' }),
    })).json() as { topic: { id: string } }
    const topicId = first.topic.id
    expect(second.topic.id).toBe(topicId)

    const newest = await (await call('/super-chat/api/chat?topic=' + topicId + '&limit=1')).json() as {
      messages: { id: string }[]; hasOlder: boolean; olderCursor?: string; untaggedCount: number
    }
    expect(newest.messages.map(message => message.id)).toEqual(['page-t2'])
    expect(newest.hasOlder).toBe(true)
    expect(newest.olderCursor).toBe('page-t2')
    expect(newest.untaggedCount).toBeGreaterThanOrEqual(0)

    const older = await (await call('/super-chat/api/chat?topic=' + topicId + '&limit=1&before=' + newest.olderCursor)).json() as typeof newest
    expect(older.messages.map(message => message.id)).toEqual(['page-t1'])
    expect(older.hasOlder).toBe(false)

    await call('/super-chat/api/chat', {
      method: 'POST', body: JSON.stringify({ text: 'untagged paging a', clientId: 'page-a' }),
    })
    await call('/super-chat/api/chat', {
      method: 'POST', body: JSON.stringify({ text: 'untagged paging b', clientId: 'page-b' }),
    })
    const untagged = await (await call('/super-chat/api/chat?untagged=1&limit=2')).json() as {
      messages: { id: string; tags: string[] }[]; hasOlder: boolean; olderCursor?: string; untaggedCount: number
    }
    expect(untagged.messages.map(message => message.id)).toEqual(['page-a', 'page-b'])
    expect(untagged.messages.every(message => message.tags.length === 0)).toBe(true)
    expect(untagged.hasOlder).toBe(true)
    expect(untagged.olderCursor).toBe('page-a')
    expect(untagged.untaggedCount).toBeGreaterThanOrEqual(2)

    const untaggedOlder = await (await call('/super-chat/api/chat?untagged=1&limit=2&before=' + untagged.olderCursor)).json() as typeof untagged
    expect(untaggedOlder.messages.every(message => message.tags.length === 0)).toBe(true)
    expect(untaggedOlder.messages.some(message => message.id === 'page-a' || message.id === 'page-b')).toBe(false)

    expect((await call('/super-chat/api/chat?limit=0')).status).toBe(400)
    expect((await call('/super-chat/api/chat?limit=201')).status).toBe(400)
    expect((await call('/super-chat/api/chat?limit=many')).status).toBe(400)
    expect((await call('/super-chat/api/chat?before=bad!id')).status).toBe(400)
    expect((await call('/super-chat/api/chat?topic=' + topicId + '&untagged=1')).status).toBe(400)
  })

  it('runs auto-tagging on demand and reports the count with the refreshed view', async () => {
    const response = await call('/super-chat/api/chat/tag', { method: 'POST', body: JSON.stringify({}) })
    expect(response.status).toBe(200)
    const body = await response.json() as { tagged: number; messages: unknown[]; topics: unknown[]; mode: string }
    expect(body.tagged).toBe(2)
    expect(body.mode).toBe('superagent')
    expect(body.messages.length).toBeGreaterThan(0)
    expect(tag).toHaveBeenCalledTimes(1)

    tag.mockRejectedValueOnce(new Error('Create at least one topic before tagging existing messages'))
    const rejected = await call('/super-chat/api/chat/tag', { method: 'POST', body: JSON.stringify({}) })
    expect(rejected.status).toBe(400)
  })

  it('replaces one message tags on demand and clears them', async () => {
    const view = await (await call('/super-chat/api/chat')).json() as { messages: { id: string; text: string; tags: string[] }[] }
    const target = view.messages.find(message => message.text === 'hello')!
    expect(target).toBeDefined()

    const updated = await call('/super-chat/api/chat/tags', { method: 'POST', body: JSON.stringify({ id: target.id, tags: ['Manual'] }) })
    expect(updated.status).toBe(200)
    const body = await updated.json() as { result: string; topics: { id: string; name: string }[]; messages: { id: string; tags: string[] }[] }
    expect(body.result).toBe('updated')
    const manual = body.topics.find(topic => topic.name === 'Manual')!
    expect(manual).toBeDefined()
    expect(body.messages.find(message => message.id === target.id)?.tags).toEqual([manual.id])

    const cleared = await call('/super-chat/api/chat/tags', { method: 'POST', body: JSON.stringify({ id: target.id, tags: [] }) })
    expect(cleared.status).toBe(200)
    expect((await cleared.json() as { messages: { id: string; tags: string[] }[] }).messages
      .find(message => message.id === target.id)?.tags).toEqual([])

    expect((await call('/super-chat/api/chat/tags', { method: 'POST', body: JSON.stringify({ id: 'missing', tags: [] }) })).status).toBe(404)
    expect((await call('/super-chat/api/chat/tags', { method: 'POST', body: JSON.stringify({ id: target.id, tags: 'bad' }) })).status).toBe(400)
    expect((await call('/super-chat/api/chat/tags', { method: 'POST', body: JSON.stringify({ tags: [] }) })).status).toBe(400)
  })

  it('creates, renames and validates topics', async () => {
    const created = await call('/super-chat/api/topics', { method: 'POST', body: JSON.stringify({ name: '  New topic  ' }) })
    const result = await created.json() as { topic: { id: string; name: string } }
    expect(result.topic.name).toBe('New topic')
    const renamed = await call('/super-chat/api/topics/rename', {
      method: 'POST', body: JSON.stringify({ id: result.topic.id, name: 'Renamed' }),
    })
    expect((await renamed.json() as { topic: { name: string } }).topic.name).toBe('Renamed')
    const duplicate = await call('/super-chat/api/topics/rename', {
      method: 'POST', body: JSON.stringify({ id: result.topic.id, name: 'Design' }),
    })
    expect(duplicate.status).toBe(400)
    expect((await call('/super-chat/api/chat?topic=../bad')).status).toBe(400)
    expect((await call('/super-chat/api/chat?topic=tp-missing')).status).toBe(404)
  })

  it('stops the selected view and validates messages and bodies', async () => {
    const cancelled = await call('/super-chat/api/chat/cancel', { method: 'POST', body: JSON.stringify({}) })
    expect(await cancelled.json()).toMatchObject({ cancelled: true })
    expect(cancel).toHaveBeenCalledWith(undefined)

    expect((await call('/super-chat/api/chat', { method: 'POST', body: JSON.stringify({ text: '   ' }) })).status).toBe(400)
    expect((await call('/super-chat/api/chat', { method: 'POST', body: 'not json' })).status).toBe(400)
    expect((await call('/super-chat/api/chat', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(16_001) }) })).status).toBe(400)
    expect((await call('/super-chat/api/chat', { method: 'POST', body: JSON.stringify({ text: 'x', tags: 'bad' }) })).status).toBe(400)
    expect((await call('/super-chat/api/chat', { method: 'POST', body: JSON.stringify({ text: 'x', pad: 'y'.repeat(70_000) }) })).status).toBe(400)
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(base + '/super-chat/api/health', {
        headers: { host: 'evil.example:80', 'x-super-chat-request': '1' },
      }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    expect(badHostStatus).toBe(403)
    expect((await call('/super-chat/api/nope')).status).toBe(404)

    tag.mockRejectedValueOnce(new Error('Invalid downstream response from provider: model required retry'))
    const downstreamError = await call('/super-chat/api/chat/tag', { method: 'POST', body: '{}' })
    expect(downstreamError.status).toBe(500)
  })

  it('passes a worker-model directive to delivery and rejects an unknown model before storing', async () => {
    const directive = { provider: 'mccodex', model: 'gemini-4' }
    workerModel.mockResolvedValueOnce({ model: directive }).mockResolvedValueOnce({ error: 'Unknown model "nope".' })
    const before = deliver.mock.calls.length
    const ok = await call('/super-chat/api/chat', {
      method: 'POST', body: JSON.stringify({ text: '用 gemini4 模型启动一个新 worker 做 x', clientId: 'client-directive' }),
    })
    expect(ok.status).toBe(200)
    expect(workerModel).toHaveBeenCalledWith('用 gemini4 模型启动一个新 worker 做 x')
    expect(deliver.mock.calls[before]?.[2]).toEqual({ workerModel: directive })
    const failed = await call('/super-chat/api/chat', {
      method: 'POST', body: JSON.stringify({ text: '用 nope 模型启动一个新 worker 做 y', clientId: 'client-model-error' }),
    })
    expect(failed.status).toBe(400)
    expect(await failed.json()).toMatchObject({ error: expect.stringContaining('Unknown model') })
    expect(store.hasMessage('client-model-error')).toBe(false)
  })
})
