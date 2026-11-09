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
  messages: [
    { id: 'm1', role: 'user', text: 'general request', at, tags: [design.id] },
    { id: 'm3', role: 'user', text: 'untagged question', at, tags: [] },
  ],
  untaggedCount: 1,
  mode: 'superagent',
  busy: false,
}
const topic = {
  topic: design,
  topics: [design, urgent],
  messages: [{ id: 'm2', role: 'agent', text: 'topic reply', at, tags: [design.id] }],
  untaggedCount: 1,
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
    const params = new URL(String(url), 'http://127.0.0.1').searchParams
    if (params.get('untagged') === '1') {
      const messages = initial.messages.filter(message => message.tags.length === 0)
      return Response.json({ ...initial, messages, untaggedCount: messages.length })
    }
    return Response.json(params.get('topic') ? topic : initial)
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
  expect(view.container.querySelector('.chat-message .chat-bubble-text')?.textContent).toBe('topic reply')
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

it('shows All messages and a No topic view for untagged messages', async () => {
  const view = await render()
  const rows = [...view.container.querySelectorAll<HTMLButtonElement>('.chat-topic-row')]
  expect(rows.map(row => row.textContent)).toEqual(expect.arrayContaining([
    expect.stringContaining(zh.generalChat), expect.stringContaining(zh.untagged),
  ]))
  expect(view.container.querySelector('.chat-title')?.textContent).toBe(zh.generalChat)

  const untaggedRow = rows.find(row => row.textContent?.includes(zh.untagged))!
  await act(async () => { untaggedRow.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  expect(view.container.querySelector('.chat-title')?.textContent).toBe(zh.untagged)
  expect([...view.container.querySelectorAll('.chat-bubble-text')].map(node => node.textContent)).toEqual(['untagged question'])
  expect(view.calls.at(-1)?.url).not.toContain('?topic=')
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

it('syncs topicId when sending a tagged message from All messages and ignores IME composition Enter', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) })
    if (init?.method === 'POST' && String(url).endsWith('/chat')) {
      return Response.json({ result: 'stored', ...topic })
    }
    return Response.json(new URL(String(url), 'http://127.0.0.1').searchParams.get('topic') ? topic : general)
  }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<ChatPanel t={t} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  const textarea = container.querySelector('.chat-input') as HTMLTextAreaElement
  await type(textarea, 'composing text')
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
  })
  expect(calls.some(call => call.init?.method === 'POST' && call.url.endsWith('/chat'))).toBe(false)

  const tagInput = container.querySelector('.chat-tags .chat-tag-input') as HTMLInputElement
  await type(tagInput, 'Design')
  await act(async () => {
    tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
  })
  expect(tagInput.value).toBe('Design')

  await act(async () => {
    tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: false, bubbles: true }))
  })
  expect(tagInput.value).toBe('')

  await act(async () => { (container.querySelector('button.chat-primary') as HTMLButtonElement).click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  expect(container.querySelector('.chat-title')?.textContent).toBe('Design')
  const designRow = [...container.querySelectorAll<HTMLButtonElement>('.chat-topic-row')]
    .find(row => row.textContent?.includes('Design'))!
  expect(designRow.getAttribute('data-active')).toBe('true')
  expect(designRow.getAttribute('aria-current')).toBe('page')

  act(() => root.unmount())
  container.remove()
})

it('shows the untagged count and loads older messages when the list is scrolled to the top', async () => {
  const newest = [
    { id: 'n3', role: 'user', text: 'newest question', at, tags: [] },
    { id: 'n4', role: 'agent', text: 'newest reply', at, tags: [] },
  ]
  const older = [
    { id: 'n1', role: 'user', text: 'older question', at, tags: [] },
    { id: 'n2', role: 'agent', text: 'older reply', at, tags: [] },
  ]
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url))
    if (String(url).includes('before=n3')) {
      return Response.json({ topics: [], messages: older, hasOlder: false, untaggedCount: 4, mode: 'superagent' })
    }
    return Response.json({ topics: [], messages: newest, hasOlder: true, olderCursor: 'n3', untaggedCount: 4, mode: 'superagent' })
  }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<ChatPanel t={t} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  const untaggedRow = [...container.querySelectorAll<HTMLButtonElement>('.chat-topic-row')]
    .find(row => row.textContent?.includes(zh.untagged))!
  expect(untaggedRow.textContent).toContain('4')
  expect([...container.querySelectorAll('.chat-bubble-text')].map(node => node.textContent)).toEqual(['newest question', 'newest reply'])
  expect(container.querySelector('.chat-older-hint')?.textContent).toBe(zh.olderHint)

  const messages = container.querySelector('.chat-messages')!
  messages.scrollTop = 0
  await act(async () => { messages.dispatchEvent(new Event('scroll', { bubbles: true })) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  expect(calls.some(url => url.includes('before=n3'))).toBe(true)
  expect([...container.querySelectorAll('.chat-bubble-text')].map(node => node.textContent)).toEqual([
    'older question', 'older reply', 'newest question', 'newest reply',
  ])
  expect(container.querySelector('.chat-older-hint')).toBeNull()
  act(() => root.unmount())
  container.remove()
})

it('renders agent Markdown and toggles a reply back to its raw text', async () => {
  const text = '**bold** and `code`\n\n```ts\nconst x = 1\n```\n\n[details](https://example.com)'
  const view = await render({ ...general, messages: [
    ...general.messages,
    { id: 'm4', role: 'agent', text, at, tags: [] },
  ] })
  const message = view.container.querySelector('[data-message-id="m4"]')!
  expect(message.querySelector('.chat-markdown strong')?.textContent).toBe('bold')
  expect(message.querySelector('.chat-md-pre code')?.textContent).toBe('const x = 1')
  expect(message.querySelector('.chat-markdown a')?.getAttribute('href')).toBe('https://example.com')

  const toggle = message.querySelector<HTMLButtonElement>('.chat-message-raw')!
  expect(toggle.parentElement?.closest('.chat-bubble')).toBe(message.querySelector('.chat-bubble'))
  expect(toggle.closest('.chat-message-foot')).toBeNull()
  expect(toggle.textContent).toBe(zh.showRaw)
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  await act(async () => { toggle.click() })

  expect(message.querySelector('.chat-markdown')).toBeNull()
  expect(message.querySelector('.chat-bubble-text')?.textContent).toBe(text)
  const back = message.querySelector<HTMLButtonElement>('.chat-message-raw')!
  expect(back.textContent).toBe(zh.showRendered)
  expect(back.getAttribute('aria-pressed')).toBe('true')

  await act(async () => { back.click() })
  expect(message.querySelector('.chat-markdown strong')?.textContent).toBe('bold')
  view.dispose()
})

it('leaves user text raw and offers no render toggle on it', async () => {
  const view = await render({ ...general, messages: [
    { id: 'm5', role: 'user', text: '**not rendered**', at, tags: [] },
  ] })
  const message = view.container.querySelector('[data-message-id="m5"]')!
  expect(message.querySelector('.chat-markdown')).toBeNull()
  expect(message.querySelector('.chat-bubble-text')?.textContent).toBe('**not rendered**')
  expect(message.querySelector('.chat-message-raw')).toBeNull()
  view.dispose()
})

it('opens model settings from the sidebar and saves the orchestrator model', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const modelView = {
    available: true,
    default: { provider: 'mccodex', model: 'deepseek-v4.1-flash' },
    orchestrator: null,
    worker: null,
    groups: [{
      id: 'mccodex',
      name: 'MCCODEX',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
        { id: 'glm-5.3', name: 'GLM 5.3' },
      ],
    }],
    failures: [],
  }
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) })
    if (String(url).endsWith('/models') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { role: string; model: typeof modelView.orchestrator }
      return Response.json({ ...modelView, [body.role]: body.model })
    }
    if (String(url).endsWith('/models')) return Response.json(modelView)
    return Response.json(general)
  }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<ChatPanel t={t} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  await act(async () => { (container.querySelector('.chat-models-entry') as HTMLButtonElement).click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const dialog = document.querySelector<HTMLElement>('.chat-models-window')!
  expect(dialog.textContent).toContain(zh.modelsTitle)
  expect(dialog.textContent).toContain('mccodex / deepseek-v4.1-flash')

  const selects = [...dialog.querySelectorAll<HTMLSelectElement>('.chat-models-role select')]
  const choose = async (select: HTMLSelectElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
    await act(async () => { select.dispatchEvent(new Event('change', { bubbles: true })) })
  }
  await choose(selects[0]!, 'mccodex')
  await choose(selects[1]!, 'glm-5.3')
  const save = dialog.querySelector<HTMLButtonElement>('.chat-models-actions .chat-primary')!
  await act(async () => { save.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  const post = calls.find(call => call.url.endsWith('/models') && call.init?.method === 'POST')
  expect(JSON.parse(String(post?.init?.body))).toEqual({ role: 'orchestrator', model: { provider: 'mccodex', model: 'glm-5.3' } })
  expect(document.querySelector('.chat-models-note')?.textContent).toBe(zh.modelsSaved)
  act(() => root.unmount())
  container.remove()
})
