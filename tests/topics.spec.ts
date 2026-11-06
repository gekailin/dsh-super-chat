import { describe, expect, it } from 'vitest'
import { messageTagNames, mergeTagNames, parseTagInput, splitTags, tagName } from '../src/client/topics.ts'
import type { Topic } from '../src/protocol.ts'

const topics: Topic[] = [
  { id: 'tp-a', name: 'Design', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'tp-b', name: 'Urgent', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

describe('topic helpers', () => {
  it('parses tag input and comma-separated tags', () => {
    expect(parseTagInput('  @Design  work ')).toBe('Design work')
    expect(splitTags('Design, Urgent， Later')).toEqual(['Design', 'Urgent', 'Later'])
  })

  it('merges the selected topic with extras, deduplicating case-insensitively', () => {
    expect(mergeTagNames('Design', ['Urgent', 'design', '  '])).toEqual(['Design', 'Urgent'])
    expect(mergeTagNames(undefined, ['A', 'B'])).toEqual(['A', 'B'])
  })

  it('maps message tag ids to display names', () => {
    expect(tagName('tp-a', topics)).toBe('Design')
    expect(tagName('missing', topics)).toBe('missing')
    expect(messageTagNames({ tags: ['tp-b', 'tp-a'] }, topics)).toEqual(['Urgent', 'Design'])
  })
})
