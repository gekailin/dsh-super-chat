// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatPanel } from '../src/client/chat.tsx'
import { zh, type SuperChatKey } from '../src/client/locales.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = ((key: SuperChatKey) => zh[key] ?? key) as never
const at = '2026-01-01T00:00:00.000Z'
const design = { id: 'tp-d', name: 'Design', createdAt: at, updatedAt: at, messageCount: 2, busy: false }
const urgent = { id: 'tp-u', name: 'Urgent', createdAt: at, updatedAt: at, messageCount: 1, busy: false }
const general = {
  topics: [design, urgent],
  messages: [{ id: 'm1', role: 'user', text: 'general request', at, tags: [design.id] }],
  mode: 'superagent',
  busy: false,
}
const topic = {
  topic: design,
  topics: [design, urgent],
  messages: [{ id: 'm2', role: 'agent', text: 'topic reply', at, tags: [design.id] }],
  mode: 'superagent',
  busy: false,
}

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

async function render() {
  Element.prototype.scrollIntoView = vi.fn()
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) })
    if (String(url).includes('/topics')) return Response.json({ topic: urgent, topics: [design, urgent] })
    if (init?.method === 'POST') return Response.json({ result: 'stored', ...general })
    return Response.json(new URL(String(url), 'http://127.0.0.1').searchParams.get('topic') ? topic : general)
  }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<ChatPanel t={t} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, calls, dispose: () => { act(() => root.unmount()); container.remove() } }
}

async function type(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  await act(async () => { element.dispatchEvent(new Event('input', { bubbles: true })) })
}

it('shows the general chat and topic views, and sends with the selected topic tag', async () => {
  const view = await render()
  const rows = () => [...view.container.querySelectorAll<HTMLButtonElement>('.chat-topic-row')]
  expect(rows().map(row => row.textContent)).toEqual(expect.arrayContaining([expect.stringContaining(zh.generalChat), expect.stringContaining('Design')]))
  expect(view.container.querySelector('.chat-title')?.textContent).toBe(zh.generalChat)
  expect(view.container.querySelector('.chat-message-tags')?.textContent).toContain('Design')

  await act(async () => { rows().find(row => row.textContent?.includes('Design'))!.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(view.container.querySelector('.chat-title')?.textContent).toBe('Design')
  expect(view.container.querySelector('.chat-message .chat-bubble')?.textContent).toBe('topic reply')
  expect(view.calls.at(-1)?.url).toContain('?topic=tp-d')

  const textarea = view.container.querySelector('.chat-input') as HTMLTextAreaElement
  await type(textarea, 'tagged follow-up')
  await act(async () => { (view.container.querySelector('button.chat-primary') as HTMLButtonElement).click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const post = view.calls.find(call => call.init?.method === 'POST' && call.url.endsWith('/chat'))
  expect(JSON.parse(String(post?.init?.body))).toMatchObject({ text: 'tagged follow-up', tags: ['Design'], topic: 'tp-d' })
  view.dispose()
})
