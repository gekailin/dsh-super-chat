import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApi } from '../src/api.ts'
import { ChatStore } from '../src/store.ts'
import type { ChatTransport } from '../src/transport.ts'

describe('Super Chat HTTP API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'super-chat-api-'))
  const store = new ChatStore(join(dir, 'chat.sqlite'))
  let server: Server
  let base = ''
  const deliver = vi.fn<(message: import('../src/protocol.ts').ChatMessage, topics: import('../src/protocol.ts').Topic[]) => Promise<void>>(async () => {})
  const busy = vi.fn<(topicId?: string) => boolean>(() => false)
  const cancel = vi.fn<(topicId?: string) => Promise<boolean>>(async () => true)
  const transport: ChatTransport = { mode: () => 'superagent', deliver, busy, cancel }
  const ensureBridge = vi.fn(async () => 'started')
  let deps: { store: ChatStore; transport: ChatTransport; wechat?: { ensure(): Promise<unknown> }; port: number; host: string }

  beforeAll(async () => {
    store.load()
    deps = { store, transport, wechat: { ensure: ensureBridge }, port: 0, host: '127.0.0.1' }
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

  it('reports health and an empty general chat', async () => {
    expect(await (await call('/super-chat/api/health')).json()).toEqual({ ok: true, messages: 0, topics: 0 })
    expect(await (await call('/super-chat/api/chat')).json()).toMatchObject({ topics: [], messages: [], mode: 'superagent' })
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
    expect((await call('/super-chat/api/nope')).status).toBe(404)
  })
})
