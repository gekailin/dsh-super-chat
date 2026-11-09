/** Browser-side request helper for the same-origin Super Chat API. */
const PREFIX = '/super-chat/api'

export class ChatError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function ask<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(PREFIX + path, {
    ...init,
    headers: {
      'x-super-chat-request': '1',
      ...init?.body ? { 'content-type': 'application/json' } : {},
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new ChatError(body.error || 'Request failed (' + response.status + ')', response.status)
  }
  return response.json() as Promise<T>
}
