/** SQLite chat store: one bounded message stream, named topics, many-to-many tags, indexed reads. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MAX_TAGS, MESSAGE_LIMIT, TOPIC_LIMIT, VIEW_LIMIT, capText, cleanTopicName, sameTopicName, validTopicId,
  type ChatMessage, type Topic,
} from './protocol.ts'

interface TopicRow { id: string; name: string; created_at: string; updated_at: string; message_count: number }
interface MessageRow { id: string; role: 'user' | 'agent'; text: string; at: string; kind: string | null; via: string | null; tags: string | null }

/** One model-decided label set for a message; names resolve only to topics that already exist. */
export interface TagAssignment {
  id: string
  topics: readonly string[]
}

const SCHEMA = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'CREATE TABLE IF NOT EXISTS topic (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS message (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, kind TEXT, via TEXT)',
  'CREATE TABLE IF NOT EXISTS message_topic (message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE, topic_id TEXT NOT NULL REFERENCES topic(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, PRIMARY KEY (message_id, topic_id))',
  'CREATE INDEX IF NOT EXISTS message_at ON message(at)',
  'CREATE INDEX IF NOT EXISTS message_topic_topic ON message_topic(topic_id, message_id)',
].join(';')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value))

const tagsOf = (row: MessageRow): string[] =>
  row.tags ? row.tags.split(',').filter(validTopicId).slice(0, MAX_TAGS) : []

const messageOf = (row: MessageRow): ChatMessage => ({
  id: row.id,
  role: row.role,
  text: row.text,
  at: row.at,
  tags: tagsOf(row),
  ...(row.kind === 'error' ? { kind: 'error' as const } : {}),
  ...(row.via === 'panel' || row.via === 'wechat' ? { via: row.via } : {}),
})

const topicOf = (row: TopicRow): Topic => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at || row.created_at,
  messageCount: row.message_count,
})

/** Reads and writes one Super Chat deployment's single chat stream. */
export class ChatStore {
  private readonly db: DatabaseSync
  private readonly legacy: string

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.legacy = join(dirname(file), 'chat.json')
    this.db = this.open()
  }

  /** Open the database, quarantining an unreadable file instead of failing startup. */
  private open(): DatabaseSync {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(this.file)
      db.exec(SCHEMA)
      return db
    } catch {
      try { db?.close() } catch { /* ignore */ }
      try { renameSync(this.file, this.file + '.corrupt-' + Date.now()) } catch { /* replace it below */ }
      const fresh = new DatabaseSync(this.file)
      fresh.exec(SCHEMA)
      return fresh
    }
  }

  /** Import an old chat.json once, after creating the schema. */
  load(): void {
    if (!this.isEmpty()) return
    let raw: string
    try { raw = readFileSync(this.legacy, 'utf8') } catch { return }
    try {
      const parsed = JSON.parse(raw) as unknown
      this.importLegacy(parsed)
      try { renameSync(this.legacy, this.legacy + '.imported-' + Date.now()) } catch { /* leave the old file */ }
    } catch {
      try { renameSync(this.legacy, this.legacy + '.corrupt-' + Date.now()) } catch { /* leave the old file */ }
    }
  }

  close(): void {
    this.db.close()
  }

  private isEmpty(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM message').get() as unknown as { count: number }
    return row.count === 0
  }

  /** Flatten v1 conversations, or read v2 messages, into the SQLite stream. */
  private importLegacy(value: unknown): void {
    if (!isRecord(value)) return
    const topics: { id: string; name: string; createdAt: string }[] = []
    const messages: { id: string; role: 'user' | 'agent'; text: string; at: string; tags: string[]; kind?: 'error'; via?: 'panel' | 'wechat' }[] = []
    const seen = new Set<string>()
    const add = (raw: unknown): void => {
      if (!isRecord(raw) || typeof raw.id !== 'string' || (raw.role !== 'user' && raw.role !== 'agent')) return
      if (typeof raw.text !== 'string' || !isTime(raw.at) || seen.has(raw.id)) return
      seen.add(raw.id)
      const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string' && validTopicId(tag)) : []
      messages.push({
        id: raw.id, role: raw.role, text: capText(raw.text, 200_000), at: raw.at, tags,
        ...(raw.kind === 'error' ? { kind: 'error' as const } : {}),
        ...(raw.via === 'panel' || raw.via === 'wechat' ? { via: raw.via } : {}),
      })
    }
    if (value.version === 2) {
      for (const raw of Array.isArray(value.topics) ? value.topics : []) {
        if (!isRecord(raw) || typeof raw.id !== 'string' || !validTopicId(raw.id) || !isTime(raw.createdAt)) continue
        const name = typeof raw.name === 'string' ? cleanTopicName(raw.name) : ''
        if (name && !topics.some(item => item.id === raw.id)) topics.push({ id: raw.id, name, createdAt: raw.createdAt })
      }
      for (const raw of Array.isArray(value.messages) ? value.messages : []) add(raw)
    } else {
      for (const bucket of isRecord(value.messages) ? Object.values(value.messages) : []) {
        for (const raw of Array.isArray(bucket) ? bucket : []) add({ ...(isRecord(raw) ? raw : {}), tags: [] })
      }
    }
    messages.sort((left, right) => left.at.localeCompare(right.at))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const topic of topics) this.insertTopic(topic)
      for (const message of messages.slice(-MESSAGE_LIMIT)) this.insertMessage(message, false)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** All topics with latest activity and message count, newest first. */
  topics(): Topic[] {
    const rows = this.db.prepare([
      'SELECT t.id, t.name, t.created_at,',
      'COALESCE((SELECT MAX(m.at) FROM message_topic mt JOIN message m ON m.id = mt.message_id WHERE mt.topic_id = t.id), t.created_at) AS updated_at,',
      '(SELECT COUNT(*) FROM message_topic mt WHERE mt.topic_id = t.id) AS message_count',
      'FROM topic t ORDER BY updated_at DESC',
    ].join(' ')).all() as unknown as TopicRow[]
    return rows.map(topicOf)
  }

  /** One topic by id. */
  topic(id: string): Topic | undefined {
    return this.topics().find(topic => topic.id === id)
  }

  /** One topic by display name, case-insensitively. */
  topicByName(name: string): Topic | undefined {
    const clean = cleanTopicName(name)
    if (!clean) return undefined
    const row = this.db.prepare('SELECT id FROM topic WHERE name_key = ?').get(clean.toLocaleLowerCase()) as unknown as { id: string } | undefined
    return row ? this.topic(row.id) : undefined
  }

  /** Find a topic by name, creating it when needed. */
  ensureTopic(name: string, at: string): Topic {
    const clean = cleanTopicName(name)
    if (!clean) throw new Error('A topic name is required')
    const found = this.topicByName(clean)
    if (found) return found
    const count = (this.db.prepare('SELECT COUNT(*) AS count FROM topic').get() as unknown as { count: number }).count
    if (count >= TOPIC_LIMIT) {
      const used = this.db.prepare('SELECT DISTINCT topic_id FROM message_topic').all() as unknown as { topic_id: string }[]
      const usedIds = new Set(used.map(row => row.topic_id))
      const free = this.topics().find(topic => !usedIds.has(topic.id))
      if (!free) throw new Error('Too many topics')
      this.db.prepare('DELETE FROM topic WHERE id = ?').run(free.id)
    }
    const topic = { id: 'tp-' + randomUUID(), name: clean, createdAt: at }
    this.insertTopic(topic)
    return { ...topic, updatedAt: at, messageCount: 0 }
  }

  /** Resolve tag names to topics, creating missing topics in input order. */
  resolveTags(names: readonly string[], at: string): Topic[] {
    const resolved: Topic[] = []
    for (const name of names) {
      if (resolved.length >= MAX_TAGS) break
      const clean = cleanTopicName(name)
      if (!clean) continue
      const topic = this.ensureTopic(clean, at)
      if (!resolved.some(item => item.id === topic.id)) resolved.push(topic)
    }
    return resolved
  }

  /** Rename a topic; returns false for an unknown id, an empty name or a duplicate name. */
  renameTopic(id: string, name: string): boolean {
    const clean = cleanTopicName(name)
    const topic = this.db.prepare('SELECT id FROM topic WHERE id = ?').get(id) as unknown as { id: string } | undefined
    if (!topic || !clean) return false
    try {
      this.db.prepare('UPDATE topic SET name = ?, name_key = ? WHERE id = ?').run(clean, clean.toLocaleLowerCase(), id)
      return true
    } catch {
      return false
    }
  }

  /** Messages in the general chat, or those carrying one topic, oldest first and bounded by the view limit. */
  messages(topicId?: string, limit = VIEW_LIMIT): ChatMessage[] {
    const rows = topicId
      ? this.db.prepare([
        'SELECT m.id, m.role, m.text, m.at, m.kind, m.via,',
        '(SELECT GROUP_CONCAT(topic_id, \',\') FROM (SELECT topic_id FROM message_topic WHERE message_id = m.id ORDER BY ordinal)) AS tags',
        'FROM message m JOIN message_topic mt ON mt.message_id = m.id',
        'WHERE mt.topic_id = ? ORDER BY m.seq DESC LIMIT ?',
      ].join(' ')).all(topicId, limit) as unknown as MessageRow[]
      : this.db.prepare([
        'SELECT m.id, m.role, m.text, m.at, m.kind, m.via,',
        '(SELECT GROUP_CONCAT(topic_id, \',\') FROM (SELECT topic_id FROM message_topic WHERE message_id = m.id ORDER BY ordinal)) AS tags',
        'FROM message m ORDER BY m.seq DESC LIMIT ?',
      ].join(' ')).all(limit) as unknown as MessageRow[]
    return rows.reverse().map(messageOf)
  }

  /** Counts for the health endpoint. */
  stats(): { messages: number; topics: number } {
    return {
      messages: (this.db.prepare('SELECT COUNT(*) AS count FROM message').get() as unknown as { count: number }).count,
      topics: (this.db.prepare('SELECT COUNT(*) AS count FROM topic').get() as unknown as { count: number }).count,
    }
  }

  /** Whether a message id already exists in the stream. */
  hasMessage(id: string): boolean {
    return this.db.prepare('SELECT 1 AS found FROM message WHERE id = ?').get(id) !== undefined
  }

  /** Append a user message once by id; returns whether it was new. */
  appendUser(input: { id: string; text: string; at: string; tags: string[]; via?: 'panel' | 'wechat' }): { message: ChatMessage; created: boolean } {
    if (this.hasMessage(input.id)) {
      const row = this.db.prepare([
        'SELECT m.id, m.role, m.text, m.at, m.kind, m.via,',
        '(SELECT GROUP_CONCAT(topic_id, \',\') FROM (SELECT topic_id FROM message_topic WHERE message_id = m.id ORDER BY ordinal)) AS tags',
        'FROM message m WHERE m.id = ?',
      ].join(' ')).get(input.id) as unknown as MessageRow
      return { message: messageOf(row), created: false }
    }
    const message: ChatMessage = {
      id: input.id,
      role: 'user',
      text: capText(input.text, 200_000),
      at: input.at,
      tags: [...new Set(input.tags.filter(validTopicId))].slice(0, MAX_TAGS),
      ...(input.via ? { via: input.via } : {}),
    }
    this.insertMessage(message)
    return { message, created: true }
  }

  /** Append an agent message once by id; returns whether it was new. */
  appendAgent(input: { id: string; text: string; at: string; tags: string[]; kind?: 'error' }): boolean {
    if (this.hasMessage(input.id)) return false
    this.insertMessage({
      id: input.id,
      role: 'agent',
      text: capText(input.text, 200_000),
      at: input.at,
      tags: [...new Set(input.tags.filter(validTopicId))].slice(0, MAX_TAGS),
      ...(input.kind ? { kind: input.kind } : {}),
    })
    return true
  }

  /**
   * Apply model-chosen topic names to messages that still have no tags. Unknown names and unknown
   * messages are ignored, so a stale or hallucinated answer cannot create topics or overwrite labels.
   * Untagged agent replies then inherit the tags of the nearest preceding user message, mirroring the
   * delivery rule for live replies. Returns how many messages gained tags.
   */
  applyTagAssignments(assignments: readonly TagAssignment[]): number {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const topicIds = new Map<string, string>()
      for (const row of this.db.prepare('SELECT id, name_key FROM topic').all() as unknown as { id: string; name_key: string }[]) {
        topicIds.set(row.name_key, row.id)
      }
      const exists = this.db.prepare('SELECT 1 AS found FROM message WHERE id = ?')
      const tagged = this.db.prepare('SELECT 1 AS found FROM message_topic WHERE message_id = ?')
      const insert = this.db.prepare('INSERT OR IGNORE INTO message_topic (message_id, topic_id, ordinal) VALUES (?, ?, ?)')
      let count = 0
      for (const assignment of assignments) {
        if (exists.get(assignment.id) === undefined || tagged.get(assignment.id) !== undefined) continue
        const ids: string[] = []
        for (const name of assignment.topics) {
          if (ids.length >= MAX_TAGS) break
          const id = topicIds.get(cleanTopicName(name).toLocaleLowerCase())
          if (id && !ids.includes(id)) ids.push(id)
        }
        if (ids.length === 0) continue
        ids.forEach((topicId, ordinal) => insert.run(assignment.id, topicId, ordinal))
        count += 1
      }
      count += this.inheritAgentTags()
      this.db.exec('COMMIT')
      return count
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Copy tags from each user message to the untagged agent messages that follow it. */
  private inheritAgentTags(): number {
    const rows = this.db.prepare([
      'SELECT m.id, m.role,',
      '(SELECT GROUP_CONCAT(topic_id, \',\') FROM (SELECT topic_id FROM message_topic WHERE message_id = m.id ORDER BY ordinal)) AS tags',
      'FROM message m ORDER BY m.seq',
    ].join(' ')).all() as unknown as { id: string; role: 'user' | 'agent'; tags: string | null }[]
    const insert = this.db.prepare('INSERT OR IGNORE INTO message_topic (message_id, topic_id, ordinal) VALUES (?, ?, ?)')
    let inheritedFrom: string[] = []
    let count = 0
    for (const row of rows) {
      const tags = row.tags ? row.tags.split(',').filter(validTopicId).slice(0, MAX_TAGS) : []
      if (row.role === 'user') {
        inheritedFrom = tags
        continue
      }
      if (tags.length > 0 || inheritedFrom.length === 0) continue
      inheritedFrom.forEach((topicId, ordinal) => insert.run(row.id, topicId, ordinal))
      count += 1
    }
    return count
  }

  /** Insert a topic, ignoring an existing id or name. */
  private insertTopic(topic: { id: string; name: string; createdAt: string }): void {
    this.db.prepare('INSERT OR IGNORE INTO topic (id, name, name_key, created_at) VALUES (?, ?, ?, ?)')
      .run(topic.id, topic.name, topic.name.toLocaleLowerCase(), topic.createdAt)
  }

  /** Insert one message and its tags in a transaction, then trim the stream. */
  private insertMessage(message: ChatMessage, ownTransaction = true): void {
    if (ownTransaction) this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO message (id, role, text, at, kind, via) VALUES (?, ?, ?, ?, ?, ?)')
        .run(message.id, message.role, message.text, message.at, message.kind ?? null, message.via ?? null)
      const tag = this.db.prepare('INSERT OR IGNORE INTO message_topic (message_id, topic_id, ordinal) VALUES (?, ?, ?)')
      message.tags.forEach((topicId, index) => {
        if (this.db.prepare('SELECT 1 AS found FROM topic WHERE id = ?').get(topicId) !== undefined) tag.run(message.id, topicId, index)
      })
      this.db.prepare('DELETE FROM message WHERE seq <= (SELECT seq FROM message ORDER BY seq DESC LIMIT 1 OFFSET ?)').run(MESSAGE_LIMIT)
      if (ownTransaction) this.db.exec('COMMIT')
    } catch (error) {
      if (ownTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
}
