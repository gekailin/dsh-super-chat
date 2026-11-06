import { describe, expect, it } from 'vitest'
import {
  GENERAL_CHAT, capText, cleanTopicName, isChatSession, sameTopicName, sessionOfGeneral, threadOfSession, validMessageId, validTopicId,
} from '../src/protocol.ts'

describe('chat protocol', () => {
  it('caps text on code-point boundaries', () => {
    expect(capText('hello', 10)).toBe('hello')
    expect(capText('hello world', 8)).toBe('hello w…')
    expect(capText('你好世界', 3)).toBe('你好…')
  })

  it('cleans and compares topic names', () => {
    expect(cleanTopicName('  Design\n work  ')).toBe('Design work')
    expect(cleanTopicName('x'.repeat(100))).toHaveLength(60)
    expect(sameTopicName('Design', 'design')).toBe(true)
    expect(sameTopicName('Design', 'Desig n')).toBe(false)
  })

  it('validates ids accepted by the API and store', () => {
    expect(validTopicId('tp-1234_ab')).toBe(true)
    expect(validTopicId('../etc')).toBe(false)
    expect(validMessageId('a'.repeat(127))).toBe(true)
    expect(validMessageId('a'.repeat(129))).toBe(false)
  })

  it('keeps the fallback Session identity separate from topics', () => {
    expect(sessionOfGeneral()).toBe('super-chat-' + GENERAL_CHAT)
    expect(isChatSession('super-chat-general')).toBe(true)
    expect(isChatSession('worker-1')).toBe(false)
    expect(threadOfSession('super-chat-general')).toBe('general')
    expect(threadOfSession('worker-1')).toBeUndefined()
  })
})
