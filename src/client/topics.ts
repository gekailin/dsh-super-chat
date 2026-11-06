/** Pure helpers for the topic list and tag chips. */
import { MAX_TAGS, sameTopicName, type ChatMessage, type Topic } from '../protocol.ts'

/** The display name of a topic id, falling back to the id when the topic was removed. */
export const tagName = (id: string, topics: readonly Topic[]): string =>
  topics.find(topic => topic.id === id)?.name ?? id

/** The names of a message's tags, in tag order. */
export const messageTagNames = (message: Pick<ChatMessage, 'tags'>, topics: readonly Topic[]): string[] =>
  message.tags.map(id => tagName(id, topics))

/** Remove surrounding whitespace and a leading @, then collapse inner whitespace. */
export const parseTagInput = (value: string): string =>
  value.replace(/^\s*@+/u, '').replace(/\s+/gu, ' ').trim()

/** Merge the selected topic with extra tag names, preserving order, ignoring duplicates and empty names. */
export function mergeTagNames(selected: string | undefined, extras: readonly string[]): string[] {
  const names: string[] = []
  for (const raw of [selected ?? '', ...extras]) {
    const name = parseTagInput(raw)
    if (!name || names.some(item => sameTopicName(item, name))) continue
    names.push(name)
    if (names.length >= MAX_TAGS) break
  }
  return names
}

/** Split a comma-separated tag input; each part is trimmed and empty parts are dropped. */
export const splitTags = (value: string): string[] =>
  value.split(/[,，]/u).map(part => parseTagInput(part)).filter(Boolean)
