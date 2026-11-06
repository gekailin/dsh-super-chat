/** Browser half: register the main panel, its sidebar shortcut, and dictionaries through DSH client slots. */
import { useEffect, useRef } from 'react'
import { ChatPanel } from './chat.tsx'
import type { ClientContext, Translate } from './dsh.ts'
import { en, zh } from './locales.ts'

const NS = 'dshSuperChat'
const PANEL_ID = 'super-chat'
const SHORTCUT_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 15a3 3 0 0 1-3 3H8l-4 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z"/><path d="M8 9h8M8 13h5"/></svg>'

function ChatIcon({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 15a3 3 0 0 1-3 3H8l-4 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" />
    <path d="M8 9h8M8 13h5" />
  </svg>
}

/** Whether a sidebar row is the Superagent entry (its label is stable across both languages). */
function isSuperagentRow(row: Element | null): row is HTMLElement {
  if (!(row instanceof HTMLElement)) return false
  const label = (row.getAttribute('aria-label') ?? row.querySelector('[class*="panelTitle"]')?.textContent ?? '').trim().toLowerCase()
  return label.includes('superagent')
}

/** A compact shortcut mounted after the Superagent row's title; the standalone row is hidden while it exists. */
function SidebarShortcut({ ctx, label, text }: { ctx: ClientContext; label: string; text: string }) {
  const glyph = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const row = glyph.current?.closest('button') as HTMLButtonElement | null
    if (!row) return
    const list = row.closest('[class*="panelList"]') ?? row.parentElement
    if (!list) return
    const hostFor = (): HTMLElement | undefined => [...list.querySelectorAll<HTMLElement>('button[aria-label]')]
      .find(button => button !== row && isSuperagentRow(button) && !!button.querySelector('[class*="panelTitle"]'))
    const chip = document.createElement('span')
    chip.dataset.superChatShortcut = ''
    chip.setAttribute('role', 'button')
    chip.setAttribute('aria-label', label)
    chip.tabIndex = 0
    chip.innerHTML = SHORTCUT_ICON
    const name = document.createElement('span')
    name.textContent = text
    chip.append(name)
    chip.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;height:20px;padding:0 6px;margin-left:4px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap;cursor:pointer;transition:background .12s ease,color .12s ease;'
    const activate = (event: Event): void => {
      event.preventDefault()
      event.stopPropagation()
      ctx.layout.selectPanel(PANEL_ID)
    }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Enter' || event.key === ' ') activate(event) }
    const brighten = (): void => { chip.style.background = 'var(--dsw-alias-interactive-bg-hover)'; chip.style.color = 'var(--dsw-alias-label-primary)' }
    const dim = (): void => { chip.style.background = 'transparent'; chip.style.color = 'var(--dsw-alias-label-secondary)' }
    chip.addEventListener('click', activate)
    chip.addEventListener('keydown', key)
    chip.addEventListener('pointerenter', brighten)
    chip.addEventListener('pointerleave', dim)
    chip.addEventListener('focus', brighten)
    chip.addEventListener('blur', dim)
    const place = (): void => {
      const host = hostFor()
      const title = host?.querySelector('[class*="panelTitle"]')
      if (!host || !title) {
        chip.remove()
        row.style.display = ''
        return
      }
      row.style.display = 'none'
      if (chip.parentElement !== host) host.append(chip)
      if (chip.previousElementSibling !== title) title.after(chip)
    }
    const observer = new MutationObserver(place)
    observer.observe(list, { childList: true, subtree: true })
    place()
    return () => {
      observer.disconnect()
      chip.removeEventListener('click', activate)
      chip.removeEventListener('keydown', key)
      chip.removeEventListener('pointerenter', brighten)
      chip.removeEventListener('pointerleave', dim)
      chip.removeEventListener('focus', brighten)
      chip.removeEventListener('blur', dim)
      chip.remove()
      row.style.display = ''
    }
  }, [ctx, label, text])
  return <span ref={glyph} style={{ display: 'inline-flex' }}><ChatIcon size={16} /></span>
}

export const inject = ['slots', 'locale', 'layout']

/** Register the panel, the sidebar shortcut and this plugin's dictionaries. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-super-chat: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register<{ t: Translate }>(
    { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    props => <ChatPanel t={props.t} />,
  ))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register<{ size: number }>(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 11, label: () => t('panelEntry'), locale: NS },
    () => <SidebarShortcut ctx={ctx} label={t('panelEntry')} text={t('panelEntry')} />,
  ))
}
