// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatPanel } from '../src/client/chat.tsx'
import { zh, type SuperChatKey } from '../src/client/locales.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = ((key: SuperChatKey, values?: Record<string, string | number>) => {
  const text = zh[key] ?? key
  return values ? text.replace(/\{(\w+)\}/gu, (_match, name: string) => String(values[name] ?? '')) : text
}) as never
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

afterEach(() => {
  vi.unstubAllGlobals()
  try { window.localStorage.clear() } catch { /* storage unavailable */ }
  document.body.replaceChildren()
})

async function render(initial: typeof general = general) {
  Element.prototype.scrollIntoView = vi.fn()
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) })
    if (String(url).endsWith('/chat/tag')) return Response.json({ tagged: 2, ...initial })
    if (String(url).endsWith('/chat/tags')) {
      const body = JSON.parse(String(init?.body)) as { id: string; tags: string[] }
      const byName: Record<string, { id: string }> = { Design: design, Urgent: urgent }
      const tags = body.tags.map(name => byName[name]?.id).filter((id): id is string => typeof id === 'string')
      return Response.json({
        result: 'updated', ...initial,
        messages: initial.messages.map(message => message.id === body.id ? { ...message, tags } : message),
      })
    }
    if (String(url).includes('/topics')) return Response.json({ topic: urgent, topics: [design, urgent] })
    if (init?.method === 'POST') return Response.json({ result: 'stored', ...initial })
    return Response.json(new URL(String(url), 'http://127.0.0.1').searchParams.get('topic') ? topic : initial)
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

it('auto-tags from the general view and shows the result count', async () => {
  const view = await render()
  const button = view.container.querySelector<HTMLButtonElement>('.chat-auto-tag')
  expect(button?.textContent).toContain(zh.autoTag)

  await act(async () => { button!.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  expect(view.calls.some(call => call.init?.method === 'POST' && call.url.endsWith('/chat/tag'))).toBe(true)
  expect(view.container.querySelector('.chat-note')?.textContent).toBe('已为 2 条消息打上标签')
  view.dispose()
})

it('disables auto-tagging while no topic exists', async () => {
  const view = await render({ ...general, topics: [] })
  const button = view.container.querySelector<HTMLButtonElement>('.chat-auto-tag')
  expect(button?.disabled).toBe(true)
  expect(button?.title).toBe(zh.autoTagNoTopics)
  view.dispose()
})

it('edits and saves tags on a past message', async () => {
  const view = await render()
  const edit = view.container.querySelector<HTMLButtonElement>('.chat-message-edit')
  expect(edit).not.toBeNull()
  await act(async () => { edit!.click() })

  const remove = view.container.querySelector<HTMLButtonElement>('.chat-message-tags .chat-tag-remove')
  expect(remove).not.toBeNull()
  await act(async () => { remove!.click() })

  const input = view.container.querySelector<HTMLInputElement>('.chat-tag-editor .chat-tag-input')!
  await type(input, 'Urgent')
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  const save = view.container.querySelector<HTMLButtonElement>('.chat-tag-editor button[type="submit"]')!
  await act(async () => { save.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  const post = view.calls.find(call => call.init?.method === 'POST' && call.url.endsWith('/chat/tags'))
  expect(JSON.parse(String(post?.init?.body))).toMatchObject({ id: 'm1', tags: ['Urgent'] })
  expect(view.container.querySelector('.chat-message-tags')?.textContent).toContain('Urgent')
  expect(view.container.querySelector('.chat-message-tags')?.textContent).not.toContain('Design')
  view.dispose()
})
