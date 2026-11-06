import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatStore } from '../src/store.ts'
import { AutoTagger } from '../src/tagger.ts'

interface Chunk {
  type: string
  text?: string
  reason?: { kind: string; failure?: { message?: string } }
}

const opened: ChatStore[] = []
const dirs: string[] = []
const at = '2026-01-01T00:00:00.000Z'

function open(): ChatStore {
  const dir = mkdtempSync(join(tmpdir(), 'super-chat-tagger-'))
  const store = new ChatStore(join(dir, 'chat.sqlite'))
  store.load()
  opened.push(store)
  dirs.push(dir)
  return store
}

afterEach(() => {
  for (const store of opened.splice(0)) { try { store.close() } catch { /* already closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const reply = (text: string): Chunk[] => [
  { type: 'text-delta', text },
  { type: 'finish', reason: { kind: 'stop' } },
]

function fakeLlm(runs: Chunk[][]): {
  host: { get(name: string): unknown }
  prepare: Record<string, unknown>[]
  requests: Record<string, unknown>[]
} {
  const prepare: Record<string, unknown>[] = []
  const requests: Record<string, unknown>[] = []
  let call = 0
  const llm = {
    async prepareCall(config: Record<string, unknown>) {
      prepare.push(config)
      const chunks = runs[Math.min(call, runs.length - 1)] ?? []
      call += 1
      return {
        config: { provider: 'p', model: 'm', maxTokens: 4096, ...config },
        async *stream(options: Record<string, unknown>) {
          requests.push(options)
          yield* chunks
        },
      }
    },
  }
  const defaults = { currentSelection: () => ({ provider: 'p', model: 'm' }) }
  return {
    host: { get: (name: string) => name === 'llm' ? llm : name === 'agentDefaultModel' ? defaults : undefined },
    prepare,
    requests,
  }
}

const messagesOf = (options: Record<string, unknown> | undefined): string => {
  const messages = options?.messages as { content: { type: string; text: string }[] }[] | undefined
  return messages?.[0]?.content?.[0]?.text ?? ''
}

describe('auto-tagger', () => {
  it('classifies untagged user messages and inherits the tags into their replies', async () => {
    const store = open()
    const design = store.ensureTopic('Design', at)
    const urgent = store.ensureTopic('Urgent', at)
    store.appendUser({ id: 'u1', text: 'please fix the layout', at, tags: [], via: 'panel' })
    store.appendAgent({ id: 'a1', text: 'working on it', at, tags: [] })
    store.appendUser({ id: 'u2', text: 'urgent request', at, tags: [], via: 'wechat' })
    store.appendAgent({ id: 'a2', text: 'done', at, tags: [] })
    store.appendUser({ id: 'u3', text: 'already tagged', at, tags: [design.id], via: 'panel' })
    const harness = fakeLlm([reply(JSON.stringify({ assignments: [
      { id: 'u1', topics: ['Design'] },
      { id: 'u2', topics: ['urgent'] },
      { id: 'u3', topics: ['Urgent'] },
      { id: 'missing', topics: ['Design'] },
    ] }))])
    const tagger = new AutoTagger(harness.host, store)

    expect(await tagger.tag()).toEqual({ tagged: 4 })
    expect(store.messages().map(message => [message.id, message.tags])).toEqual([
      ['u1', [design.id]],
      ['a1', [design.id]],
      ['u2', [urgent.id]],
      ['a2', [urgent.id]],
      ['u3', [design.id]],
    ])
    expect(harness.prepare[0]).toMatchObject({ provider: 'p', model: 'm' })
    const prompt = messagesOf(harness.requests[0])
    expect(prompt).toContain('Design')
    expect(prompt).toContain('please fix the layout')
    const items = JSON.parse(prompt.slice(prompt.indexOf('['), prompt.indexOf('Return only'))) as { id: string; taggable: boolean }[]
    expect(items.map(item => [item.id, item.taggable])).toEqual([
      ['u1', true], ['a1', false], ['u2', true], ['a2', false], ['u3', false],
    ])
  })

  it('retries once when the model does not return JSON, then applies the answer', async () => {
    const store = open()
    const design = store.ensureTopic('Design', at)
    store.appendUser({ id: 'u1', text: 'fix it', at, tags: [] })
    const harness = fakeLlm([reply('not JSON at all'), reply('{"assignments":[{"id":"u1","topics":["Design"]}]}')])
    const tagger = new AutoTagger(harness.host, store)

    expect(await tagger.tag()).toEqual({ tagged: 1 })
    expect(harness.prepare).toHaveLength(2)
    expect(store.messages()[0]?.tags).toEqual([design.id])
  })

  it('rejects an unusable answer without changing tags', async () => {
    const store = open()
    store.ensureTopic('Design', at)
    store.appendUser({ id: 'u1', text: 'fix it', at, tags: [] })
    const tagger = new AutoTagger(fakeLlm([reply('still not JSON'), reply('still not JSON')]).host, store)

    await expect(tagger.tag()).rejects.toThrow('valid tag assignments')
    expect(store.messages()[0]?.tags).toEqual([])
  })

  it('requires at least one existing topic and a configured model', async () => {
    const empty = open()
    empty.appendUser({ id: 'u1', text: 'fix it', at, tags: [] })
    await expect(new AutoTagger(fakeLlm([]).host, empty).tag()).rejects.toThrow('at least one topic')

    const store = open()
    store.ensureTopic('Design', at)
    store.appendUser({ id: 'u1', text: 'fix it', at, tags: [] })
    await expect(new AutoTagger({ get: () => undefined }, store).tag()).rejects.toThrow('needs the DSH model service')
  })

  it('fills untagged replies without calling the model when no user message needs tags', async () => {
    const store = open()
    const design = store.ensureTopic('Design', at)
    store.appendUser({ id: 'u1', text: 'tagged request', at, tags: [design.id] })
    store.appendAgent({ id: 'a1', text: 'reply', at, tags: [] })
    const harness = fakeLlm([])
    const tagger = new AutoTagger(harness.host, store)

    expect(await tagger.tag()).toEqual({ tagged: 1 })
    expect(harness.prepare).toHaveLength(0)
    expect(store.messages().map(message => message.tags)).toEqual([[design.id], [design.id]])
  })

  it('reports a failed model call instead of retrying it as malformed JSON', async () => {
    const store = open()
    store.ensureTopic('Design', at)
    store.appendUser({ id: 'u1', text: 'fix it', at, tags: [] })
    const harness = fakeLlm([[{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider down' } } }]])
    const tagger = new AutoTagger(harness.host, store)

    await expect(tagger.tag()).rejects.toThrow('Automatic tagging failed')
    expect(harness.prepare).toHaveLength(1)
    expect(store.messages()[0]?.tags).toEqual([])
  })
})
