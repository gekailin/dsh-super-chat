import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatStore } from '../src/store.ts'
import { MESSAGE_LIMIT, TOPIC_LIMIT } from '../src/protocol.ts'

const opened: ChatStore[] = []
const dirs: string[] = []

function open(): { store: ChatStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'super-chat-store-'))
  const store = new ChatStore(join(dir, 'chat.sqlite'))
  store.load()
  opened.push(store)
  dirs.push(dir)
  return { store, dir }
}

afterEach(() => {
  for (const store of opened.splice(0)) { try { store.close() } catch { /* already closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SQLite chat store', () => {
  it('stores one stream, resolved topics and multiple tags', () => {
    const { store } = open()
    const at = '2026-01-01T00:00:00.000Z'
    const design = store.ensureTopic('Design', at)
    const urgent = store.ensureTopic('Urgent', at)
    expect(store.ensureTopic('design', at).id).toBe(design.id)

    expect(store.appendUser({ id: 'm1', text: 'hello', at, tags: [design.id, urgent.id], via: 'panel' }).created).toBe(true)
    expect(store.appendAgent({ id: 'm2', text: 'reply', at, tags: [design.id] })).toBe(true)
    expect(store.appendUser({ id: 'm1', text: 'hello again', at, tags: [] }).created).toBe(false)

    expect(store.messages().map(message => [message.id, message.role, message.tags])).toEqual([
      ['m1', 'user', [design.id, urgent.id]],
      ['m2', 'agent', [design.id]],
    ])
    expect(store.messages(design.id).map(message => message.id)).toEqual(['m1', 'm2'])
    expect(store.messages(urgent.id).map(message => message.id)).toEqual(['m1'])
    expect(store.topics()).toContainEqual(expect.objectContaining({ name: 'Design', messageCount: 2, updatedAt: at }))
    expect(store.stats()).toEqual({ messages: 2, topics: 2 })
  })

  it('pages the stream, a topic and the untagged filter backwards from the newest message', () => {
    const { store } = open()
    const at = '2026-01-01T00:00:00.000Z'
    const design = store.ensureTopic('Design', at)
    store.appendUser({ id: 'u1', text: 'one', at, tags: [] })
    store.appendAgent({ id: 'u2', text: 'two', at, tags: [design.id] })
    store.appendUser({ id: 'u3', text: 'three', at, tags: [] })
    store.appendAgent({ id: 'u4', text: 'four', at, tags: [design.id] })
    store.appendUser({ id: 'u5', text: 'five', at, tags: [] })

    const newest = store.page({ limit: 2 })
    expect(newest.messages.map(message => message.id)).toEqual(['u4', 'u5'])
    expect(newest.hasOlder).toBe(true)
    const middle = store.page({ limit: 2, before: 'u4' })
    expect(middle.messages.map(message => message.id)).toEqual(['u2', 'u3'])
    expect(middle.hasOlder).toBe(true)
    const oldest = store.page({ limit: 2, before: 'u2' })
    expect(oldest.messages.map(message => message.id)).toEqual(['u1'])
    expect(oldest.hasOlder).toBe(false)
    expect(store.page({ limit: 2, before: 'missing' }).messages).toEqual([])

    expect(store.page({ topicId: design.id, limit: 1 }).messages.map(message => message.id)).toEqual(['u4'])
    expect(store.page({ topicId: design.id, limit: 1, before: 'u4' }).messages.map(message => message.id)).toEqual(['u2'])
    expect(store.page({ untagged: true, limit: 2 }).messages.map(message => message.id)).toEqual(['u3', 'u5'])
    expect(store.page({ untagged: true, limit: 2, before: 'u3' }).messages.map(message => message.id)).toEqual(['u1'])
    expect(store.untaggedCount()).toBe(3)
  })

  it('resolves tag names, renames topics and rejects duplicate names', () => {
    const { store } = open()
    const at = '2026-01-01T00:00:00.000Z'
    const topics = store.resolveTags(['Design', ' design ', 'Urgent'], at)
    expect(topics.map(topic => topic.name)).toEqual(['Design', 'Urgent'])
    const design = topics[0]!
    expect(store.renameTopic(design.id, 'UI')).toBe(true)
    expect(store.topic(design.id)?.name).toBe('UI')
    expect(store.renameTopic(design.id, 'urgent')).toBe(false)
    expect(store.renameTopic('missing', 'x')).toBe(false)
  })

  it('imports a legacy chat.json once and keeps the messages', () => {
    const { store, dir } = open()
    store.close()
    opened.splice(opened.indexOf(store), 1)
    const at = '2026-01-01T00:00:00.000Z'
    writeFileSync(join(dir, 'chat.json'), JSON.stringify({
      version: 1,
      threads: [{ id: 'local', title: 'Old', createdAt: at, updatedAt: at }],
      messages: { local: [
        { id: 'u1', role: 'user', text: 'old request', at },
        { id: 'a1', role: 'agent', text: 'old reply', at },
      ] },
    }))
    const migrated = new ChatStore(join(dir, 'chat.sqlite'))
    migrated.load()
    opened.push(migrated)
    expect(migrated.messages().map(message => [message.id, message.tags])).toEqual([['u1', []], ['a1', []]])
    expect(readdirSync(dir).some(name => name.startsWith('chat.json.imported-'))).toBe(true)
  })

  it('quarantines an unreadable legacy file instead of failing startup', () => {
    const { store, dir } = open()
    store.close()
    opened.splice(opened.indexOf(store), 1)
    writeFileSync(join(dir, 'chat.json'), '{not json')
    const empty = new ChatStore(join(dir, 'chat.sqlite'))
    empty.load()
    opened.push(empty)
    expect(empty.messages()).toEqual([])
    expect(readdirSync(dir).some(name => name.startsWith('chat.json.corrupt-'))).toBe(true)
  })

  it('persists across close and reopen', () => {
    const { store, dir } = open()
    const at = '2026-01-01T00:00:00.000Z'
    const topic = store.ensureTopic('Persisted', at)
    store.appendUser({ id: 'p1', text: 'kept', at, tags: [topic.id] })
    store.close()
    opened.splice(opened.indexOf(store), 1)
    const reopened = new ChatStore(join(dir, 'chat.sqlite'))
    reopened.load()
    opened.push(reopened)
    expect(reopened.messages()).toContainEqual(expect.objectContaining({ id: 'p1', tags: [topic.id] }))
    expect(reopened.topicByName('persisted')?.id).toBe(topic.id)
  })

  it('bounds the single stream at MESSAGE_LIMIT', () => {
    const { store } = open()
    const at = '2026-01-01T00:00:00.000Z'
    for (let index = 0; index < MESSAGE_LIMIT + 3; index++) {
      store.appendAgent({ id: 'm' + index, text: 'message ' + index, at, tags: [] })
    }
    const messages = store.messages(undefined, MESSAGE_LIMIT)
    expect(messages).toHaveLength(MESSAGE_LIMIT)
    expect(messages[0]?.id).toBe('m3')
    expect(store.hasMessage('m0')).toBe(false)
  })

  it('replaces one message tags manually, creates names and can clear them', () => {
    const { store } = open()
    const at = '2026-01-01T00:00:00.000Z'
    const design = store.ensureTopic('Design', at)
    store.appendUser({ id: 'u1', text: 'old request', at, tags: [design.id] })
    store.appendAgent({ id: 'a1', text: 'reply', at, tags: [] })

    expect(store.setMessageTags('u1', ['Urgent', 'Design'], at)).toBe(true)
    const urgent = store.topicByName('Urgent')!
    expect(store.messages()[0]?.tags).toEqual([urgent.id, design.id])
    expect(store.setMessageTags('u1', [], at)).toBe(true)
    expect(store.messages()[0]?.tags).toEqual([])
    expect(store.setMessageTags('missing', ['Design'], at)).toBe(false)
    expect(store.topicByName('Design')?.id).toBe(design.id)
  })

  it('tags only untagged messages with existing topics and inherits agent replies', () => {
    const { store } = open()
    const at = '2026-01-01T00:00:00.000Z'
    const design = store.ensureTopic('Design', at)
    store.appendUser({ id: 'u1', text: 'design request', at, tags: [], via: 'panel' })
    store.appendAgent({ id: 'a1', text: 'working on it', at, tags: [] })
    store.appendAgent({ id: 'a2', text: 'done', at, tags: [] })
    store.appendUser({ id: 'u2', text: 'already tagged', at, tags: [design.id] })
    store.appendAgent({ id: 'a3', text: 'reply without tags', at, tags: [] })
    store.appendUser({ id: 'u3', text: 'hello', at, tags: [] })

    const tagged = store.applyTagAssignments([
      { id: 'u1', topics: ['Design'] },
      { id: 'u2', topics: ['Design'] },
      { id: 'u3', topics: ['Not a topic'] },
      { id: 'missing', topics: ['Design'] },
    ])

    expect(tagged).toBe(4)
    expect(store.messages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'u1', tags: [design.id] }),
      expect.objectContaining({ id: 'a1', tags: [design.id] }),
      expect.objectContaining({ id: 'a2', tags: [design.id] }),
      expect.objectContaining({ id: 'a3', tags: [design.id] }),
      expect.objectContaining({ id: 'u3', tags: [] }),
    ]))
    expect(store.topicByName('Not a topic')).toBeUndefined()
  })

  it('inherits tags for existing replies without a model answer', () => {
    const { store } = open()
    const at = '2026-01-01T00:00:00.000Z'
    const design = store.ensureTopic('Design', at)
    store.appendUser({ id: 'u1', text: 'tagged request', at, tags: [design.id] })
    store.appendAgent({ id: 'a1', text: 'reply', at, tags: [] })
    store.appendUser({ id: 'u2', text: 'second request', at, tags: [] })
    store.appendAgent({ id: 'a2', text: 'reply again', at, tags: [] })
    expect(store.applyTagAssignments([])).toBe(1)
    expect(store.messages().map(message => [message.id, message.tags])).toEqual([
      ['u1', [design.id]],
      ['a1', [design.id]],
      ['u2', []],
      ['a2', []],
    ])
  })

  it('evicts the oldest unused topic at TOPIC_LIMIT without dropping newly resolved tags in the same batch', () => {
    const { store } = open()
    const baseMs = Date.parse('2026-01-01T00:00:00.000Z')
    const freeOldest = store.ensureTopic('FreeOldest', new Date(baseMs).toISOString())
    const freeNewer = store.ensureTopic('FreeNewer', new Date(baseMs + 1000).toISOString())
    for (let i = 2; i < TOPIC_LIMIT; i++) {
      const t = store.ensureTopic('Used-' + i, new Date(baseMs + i * 1000).toISOString())
      store.appendUser({ id: 'u-' + i, text: 'msg', at: new Date(baseMs + i * 1000).toISOString(), tags: [t.id] })
    }
    expect(store.stats().topics).toBe(TOPIC_LIMIT)

    const resolved = store.resolveTags(['Alpha', 'Beta'], new Date(baseMs + 500_000).toISOString())
    expect(resolved.map(t => t.name)).toEqual(['Alpha', 'Beta'])
    expect(store.topic(freeOldest.id)).toBeUndefined()
    expect(store.topic(freeNewer.id)).toBeUndefined()
    expect(store.topic(resolved[0]!.id)?.name).toBe('Alpha')
    expect(store.topic(resolved[1]!.id)?.name).toBe('Beta')

    const { message } = store.appendUser({
      id: 'u-batch',
      text: 'both tags',
      at: new Date(baseMs + 500_000).toISOString(),
      tags: resolved.map(t => t.id),
    })
    expect(message.tags).toEqual([resolved[0]!.id, resolved[1]!.id])
    expect(() => store.ensureTopic('Overflow', new Date(baseMs + 600_000).toISOString())).toThrow('Too many topics')
  })

  it('quarantines a corrupt SQLite database or stale schema along with WAL/SHM sidecars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-chat-store-corrupt-'))
    dirs.push(dir)
    const file = join(dir, 'chat.sqlite')
    writeFileSync(file, 'not a sqlite file')
    writeFileSync(file + '-wal', 'stale wal')
    writeFileSync(file + '-shm', 'stale shm')

    const recovered = new ChatStore(file)
    opened.push(recovered)
    expect(recovered.topics()).toEqual([])
    const files = readdirSync(dir)
    expect(files.some(name => name.startsWith('chat.sqlite.corrupt-'))).toBe(true)
    expect(files.some(name => name.startsWith('chat.sqlite-wal.corrupt-'))).toBe(true)
    expect(files.some(name => name.startsWith('chat.sqlite-shm.corrupt-'))).toBe(true)
    recovered.close()

    const badSchemaDir = mkdtempSync(join(tmpdir(), 'super-chat-store-schema-'))
    dirs.push(badSchemaDir)
    const badSchemaFile = join(badSchemaDir, 'chat.sqlite')
    const rawDb = new DatabaseSync(badSchemaFile)
    rawDb.exec('CREATE TABLE topic (id TEXT PRIMARY KEY)')
    rawDb.close()

    const schemaRecovered = new ChatStore(badSchemaFile)
    opened.push(schemaRecovered)
    expect(schemaRecovered.ensureTopic('Works', '2026-01-01T00:00:00.000Z').name).toBe('Works')
    expect(readdirSync(badSchemaDir).some(name => name.startsWith('chat.sqlite.corrupt-'))).toBe(true)
  })
})
