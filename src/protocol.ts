/** Shared protocol vocabulary between the host and browser halves of Super Chat. */

/** Prefix of DSH Session ids owned by this plugin; the fallback Session uses it too. */
export const SESSION_PREFIX = 'super-chat-'
/** The single general chat; also the fallback Session's suffix. */
export const GENERAL_CHAT = 'general'
/** How many messages the single chat stream keeps. */
export const MESSAGE_LIMIT = 1000
/** How many messages one view returns; older messages stay on disk until the stream bound. */
export const VIEW_LIMIT = 200
/** How many named topics one deployment keeps. */
export const TOPIC_LIMIT = 200
/** Most tags one message may carry. */
export const MAX_TAGS = 8
/** Longest message the HTTP API accepts, in characters. */
export const MAX_TEXT = 16_000
/** Largest JSON request body the HTTP API reads, in bytes. */
export const MAX_BODY = 64 * 1024
/** Longest topic display name kept, in Unicode code points. */
export const TOPIC_NAME_MAX = 60

/** A named topic. Messages carry topic ids; topics are labels, not separate streams. */
export interface Topic {
  id: string
  name: string
  createdAt: string
  /** Latest message with this tag, or the creation time while empty. */
  updatedAt: string
  /** Number of messages carrying this tag, as computed at read time. */
  messageCount?: number
  /** Set while a superagent Ticket for this topic is still open. */
  busy?: boolean
}

/** One message in the single chat stream; tags are topic ids. */
export interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  at: string
  tags: string[]
  /** An inline delivery or turn failure rather than model output. */
  kind?: 'error'
  /** Where the message entered the chat. */
  via?: 'panel' | 'wechat'
}

/** The panel state returned by GET /chat. */
export interface ChatView {
  /** The selected topic, omitted for the general chat. */
  topic?: Topic
  topics: Topic[]
  messages: ChatMessage[]
  /** Whether messages are handled by superagent Tickets or by the fallback Session. */
  mode: 'superagent' | 'session'
  /** Whether the selected view has work in flight. */
  busy?: boolean
}

/** Whether a client-supplied topic id is safe as a store key and a URL segment. */
export const validTopicId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)

/** Whether a client-supplied message id is safe to use as a dedupe key. */
export const validMessageId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)

/** Whether a DSH Session id belongs to Super Chat. */
export const isChatSession = (sessionId: string): boolean => sessionId.startsWith(SESSION_PREFIX)

/** The fallback Session id used when superagent is unavailable. */
export const sessionOfGeneral = (): string => SESSION_PREFIX + GENERAL_CHAT

/** The conversation a Super Chat Session id backs, or undefined for any other Session. */
export const threadOfSession = (sessionId: string): string | undefined =>
  isChatSession(sessionId) ? sessionId.slice(SESSION_PREFIX.length) : undefined

/** Cap a string at a number of Unicode code points, appending an ellipsis when cut. */
export function capText(text: string, max: number): string {
  const points = [...text]
  return points.length <= max ? text : points.slice(0, Math.max(0, max - 1)).join('') + '…'
}

/** Collapse whitespace in a topic name and cap it at the display limit. */
export const cleanTopicName = (name: string): string =>
  capText(name.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim(), TOPIC_NAME_MAX)

/** Whether two topic names mean the same topic; topic names are case-insensitive. */
export const sameTopicName = (left: string, right: string): boolean =>
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()
