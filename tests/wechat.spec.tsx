// @vitest-environment jsdom
import { act, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { zh, type SuperChatKey } from '../src/client/locales.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Entry = { options: { name: string; id?: string; key?: string }; component: ComponentType<Record<string, unknown>> }
const t = ((key: SuperChatKey) => zh[key] ?? key) as never

function fixture() {
  const entries: Entry[] = []
  const ctx = {
    slots: { inject: (_name: string, register: () => void) => register(), register: (options: Entry['options'], component: Entry['component']) => { entries.push({ options, component }); return () => {} } },
    locale: { register: () => () => {}, bind: () => t },
    effect: (effect: () => unknown) => { effect() },
  }
  apply(ctx as never)
  return entries.find(entry => entry.options.name === 'main' && entry.options.key === 'super-chat')!
}

async function render(entry: Entry, props: Record<string, unknown>): Promise<{ container: HTMLElement; dispose: () => void }> {
  Element.prototype.scrollIntoView = vi.fn()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<entry.component {...props} />) })
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, dispose: () => { act(() => { root.unmount() }); container.remove() } }
}

const chatView = (): Response => Response.json({ topics: [], messages: [], mode: 'session' })

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('opens the WeChat access window from the sidebar foot and shows the login QR code', async () => {
  type Wechat = { loggedIn: boolean; nick?: string; login: { phase: string; qr?: string; message?: string } }
  let wechat: Wechat = { loggedIn: false, login: { phase: 'idle' } }
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url))
    if (String(url).startsWith('http://127.0.0.1:8790')) {
      if (String(url).endsWith('/wechat/login')) wechat = { loggedIn: false, login: { phase: 'waiting', qr: 'data:image/jpeg;base64,AAAA' } }
      return Response.json(wechat)
    }
    return chatView()
  }))
  const view = await render(fixture(), { t })
  const entry = view.container.querySelector('.chat-wechat-entry') as HTMLButtonElement
  expect(entry.textContent).toContain(zh.chatWechat)
  // The entry carries the connection state, so it is visible without opening the window.
  expect(entry.textContent).toContain(zh.chatWechatStateLoggedOut)
  expect(entry.querySelector('.chat-wechat-entry-state')?.getAttribute('data-state')).toBe('logged-out')
  // The entry is the last thing in the conversation list.
  expect(view.container.querySelector('.chat-sidebar')!.lastElementChild?.className).toBe('chat-sidebar-foot')
  await act(async () => { entry.click() })
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const qr = document.querySelector('.chat-wechat-qr') as HTMLImageElement | null
  expect(qr?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA')
  expect(document.body.textContent).toContain(zh.chatWechatWaiting)
  // The window fetches one code on open; it does not keep requesting new ones.
  expect(calls.filter(item => item.endsWith('/wechat/login'))).toHaveLength(1)
  const dialog = document.querySelector<HTMLElement>('.chat-wechat-window')!
  dialog.focus()
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
  })
  expect(dialog.contains(document.activeElement)).toBe(true)
  const close = document.querySelector<HTMLButtonElement>('.chat-wechat-close')!
  await act(async () => { close.click() })
  expect(document.querySelector('.chat-wechat-dialog')).toBeNull()
  view.dispose()
})

it('shows the connected WeChat account and signs out from the window', async () => {
  type Wechat = { loggedIn: boolean; nick?: string; login: { phase: string; qr?: string; message?: string } }
  let wechat: Wechat = { loggedIn: true, nick: 'WeChat user', login: { phase: 'success' } }
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) })
    if (String(url).startsWith('http://127.0.0.1:8790')) {
      if (String(url).endsWith('/wechat/logout')) wechat = { loggedIn: false, login: { phase: 'idle' } }
      return Response.json(wechat)
    }
    return chatView()
  }))
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const view = await render(fixture(), { t })
  const entry = view.container.querySelector('.chat-wechat-entry') as HTMLButtonElement
  expect(entry.textContent).toContain(zh.chatWechatStateConnected)
  expect(entry.querySelector('.chat-wechat-entry-state')?.getAttribute('data-state')).toBe('connected')
  await act(async () => { entry.click() })
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(document.body.textContent).toContain('WeChat user')
  expect(document.body.textContent).toContain(zh.chatWechatConnected)
  // Signing out is confirmed, posted once, and leaves the idle scan action instead of a new code.
  const signOut = [...document.querySelectorAll<HTMLButtonElement>('.chat-wechat-connected button')]
    .find(item => item.textContent === zh.chatWechatLogout)!
  await act(async () => { signOut.click() })
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(calls.some(call => call.url.endsWith('/wechat/logout') && call.init?.method === 'POST')).toBe(true)
  expect(document.body.textContent).toContain(zh.chatWechatLoggedOut)
  expect([...document.querySelectorAll<HTMLButtonElement>('.chat-wechat-scan button')]
    .some(item => item.textContent === zh.chatWechatLogin)).toBe(true)
  confirm.mockRestore()
  view.dispose()
})

it('asks the plugin host to start the bridge when the dialog opens and it is not running', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  let started = false
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url))
    if (String(url).endsWith('/super-chat/api/wechat/start')) {
      started = true
      return Response.json({ ok: true, result: 'started' })
    }
    if (String(url).startsWith('http://127.0.0.1:8790')) {
      if (!started) throw new TypeError('Failed to fetch')
      if (String(url).endsWith('/wechat/login')) {
        return Response.json({ loggedIn: false, login: { phase: 'waiting', qr: 'data:image/jpeg;base64,AAAA' } })
      }
      return Response.json({ loggedIn: false, login: { phase: 'idle' } })
    }
    return chatView()
  }))
  const view = await render(fixture(), { t })
  const entry = view.container.querySelector('.chat-wechat-entry') as HTMLButtonElement
  expect(view.container.querySelector('.chat-wechat-entry-state')?.getAttribute('data-state')).toBe('unreachable')
  await act(async () => { entry.click() })
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(calls.some(url => url.endsWith('/super-chat/api/wechat/start'))).toBe(true)
  expect(document.querySelector('.chat-wechat-qr')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA')
  view.dispose()
})

it('shows when the WeChat access service is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('http://127.0.0.1:8790')) throw new TypeError('Failed to fetch')
    return chatView()
  }))
  const view = await render(fixture(), { t })
  const entry = view.container.querySelector('.chat-wechat-entry') as HTMLButtonElement
  expect(entry.textContent).toContain(zh.chatWechatStateUnreachable)
  expect(entry.querySelector('.chat-wechat-entry-state')?.getAttribute('data-state')).toBe('unreachable')
  view.dispose()
})
