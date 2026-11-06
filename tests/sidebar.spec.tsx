// @vitest-environment jsdom
import { act, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { zh } from '../src/client/locales.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Entry = { options: { name: string; id?: string; key?: string }; component: ComponentType<Record<string, unknown>> }

function fixture() {
  const entries: Entry[] = []
  const selectPanel = vi.fn()
  const ctx = {
    slots: {
      inject: (_name: string, factory: () => void) => factory(),
      register: (options: Entry['options'], component: Entry['component']) => { entries.push({ options, component }); return () => {} },
    },
    locale: { register: () => () => {}, bind: () => (key: string) => zh[key as keyof typeof zh] ?? key },
    effect: (effect: () => unknown) => { effect() },
    layout: { selectPanel },
  }
  apply(ctx as never)
  return { entries, selectPanel }
}

afterEach(() => { document.body.replaceChildren() })

it('moves the Super Chat entry into the right side of the Superagent row', async () => {
  const hostRow = document.createElement('button')
  hostRow.setAttribute('aria-label', 'Superagent')
  const title = document.createElement('span')
  title.className = 'hashed_panelTitle'
  title.textContent = 'Superagent'
  hostRow.append(title)
  document.body.append(hostRow)
  const middleRow = document.createElement('button')
  middleRow.setAttribute('aria-label', '自动化任务')
  middleRow.textContent = '自动化任务'
  document.body.append(middleRow)
  const ownRow = document.createElement('button')
  const mount = document.createElement('span')
  ownRow.append(mount)
  document.body.append(ownRow)
  const rowClick = vi.fn()
  hostRow.addEventListener('click', rowClick)

  const { entries, selectPanel } = fixture()
  const entry = entries.find(item => item.options.name === 'sidebar.panellist')!
  const root = createRoot(mount)
  await act(async () => { root.render(<entry.component size={18} />) })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  const chip = hostRow.querySelector('[data-super-chat-shortcut]') as HTMLElement
  expect(chip).not.toBeNull()
  expect(chip.previousElementSibling).toBe(title)
  expect(chip.textContent).toContain(zh.panelEntry)
  expect(ownRow.style.display).toBe('none')

  await act(async () => { chip.click() })
  expect(selectPanel).toHaveBeenCalledWith('super-chat')
  expect(rowClick).not.toHaveBeenCalled()

  await act(async () => { root.unmount() })
  expect(hostRow.querySelector('[data-super-chat-shortcut]')).toBeNull()
  expect(ownRow.style.display).toBe('')
})

it('keeps the standalone entry when there is no Superagent row', async () => {
  const ownRow = document.createElement('button')
  const mount = document.createElement('span')
  ownRow.append(mount)
  document.body.append(ownRow)
  const { entries } = fixture()
  const entry = entries.find(item => item.options.name === 'sidebar.panellist')!
  const root = createRoot(mount)
  await act(async () => { root.render(<entry.component size={18} />) })
  expect(document.querySelector('[data-super-chat-shortcut]')).toBeNull()
  expect(ownRow.style.display).toBe('')
  await act(async () => { root.unmount() })
})
