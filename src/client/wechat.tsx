/** Super Chat's WeChat remote-access entry and the scan/status dialog backed by the local bridge. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { T } from './locales.ts'

/** The bridge's default loopback port (wechat/run-superchat.sh); it runs on the same host as this panel. */
const BRIDGE = 'http://127.0.0.1:8790'
const START = '/super-chat/api/wechat/start'
const POLL_MS = 2000
const STATE_POLL_MS = 10_000
/** Fired when the dialog connects or disconnects, so the sidebar entry need not wait for its next poll. */
const WECHAT_CHANGE = 'super-chat-wechat-change'
type WechatIndicator = 'checking' | 'connected' | 'logged-out' | 'unreachable'

interface WechatLogin {
  phase: 'idle' | 'connecting' | 'waiting' | 'scanned' | 'starting' | 'success' | 'error'
  message?: string
  qr?: string
}
interface WechatStatus {
  ok?: boolean
  loggedIn: boolean
  nick?: string
  user?: string
  since?: string
  error?: string
  login?: WechatLogin
}

async function startBridge(): Promise<void> {
  const response = await fetch(START, { method: 'POST', headers: { 'x-super-chat-request': '1' } })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error || ('Could not start the WeChat bridge (' + response.status + ')'))
}

async function bridge<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.method === 'POST'
    ? { 'x-super-chat-request': '1', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers }
    : init?.headers
  const response = await fetch(BRIDGE + path, init ? { ...init, ...(headers ? { headers } : {}) } : undefined)
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body as T
}
const failureText = (t: T, failure: unknown): string =>
  failure instanceof TypeError ? t('chatWechatUnreachable') : failure instanceof Error ? failure.message : String(failure)

/** Keep Tab inside the dialog while it is open. */
function trapTab(event: globalThis.KeyboardEvent, container: HTMLElement): void {
  const focusable = [...container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )]
  if (focusable.length === 0) return
  const first = focusable[0]!, last = focusable[focusable.length - 1]!
  const active = document.activeElement
  const outside = !active || active === container || !container.contains(active)
  if (event.shiftKey && (active === first || outside)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (active === last || outside)) { event.preventDefault(); first.focus() }
}

/** The two speech bubbles of WeChat, drawn to match the panel's other 1.8px line icons. */
export function WechatIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.3 4.4c3.3 0 6 2.2 6 4.9 0 2.7-2.7 4.9-6 4.9-.7 0-1.4-.1-2-.3l-2.6 1.3.7-2.3c-1.2-.9-2-2.2-2-3.6 0-2.7 2.6-4.9 5.9-4.9z" />
    <path d="M20.6 12.4c0 2.2-2.1 4-4.7 4-.5 0-1.1-.1-1.5-.2l-2.2 1.1.5-1.9c-1-.7-1.7-1.8-1.7-3 0-2.2 2.1-4 4.8-4s4.8 1.8 4.8 4z" />
  </svg>
}

export function WechatAccessButton({ t, onClick }: { t: T; onClick: () => void }) {
  const [indicator, setIndicator] = useState<WechatIndicator>('checking')
  const hadBridge = useRef(false)
  const startingBridge = useRef(false)

  useEffect(() => {
    let live = true
    const tick = async (): Promise<void> => {
      if (document.hidden) return
      try {
        const next = await bridge<WechatStatus>('/wechat/status')
        hadBridge.current = true
        if (live) setIndicator(next.loggedIn ? 'connected' : 'logged-out')
      } catch {
        // Recover a previously running bridge automatically without spawning one on a cold page load.
        if (hadBridge.current && !startingBridge.current) {
          startingBridge.current = true
          try {
            await startBridge()
            const next = await bridge<WechatStatus>('/wechat/status')
            if (live) setIndicator(next.loggedIn ? 'connected' : 'logged-out')
            return
          } catch {
            // Fall through and mark unreachable until the next poll or click.
          } finally {
            startingBridge.current = false
          }
        }
        if (live) setIndicator('unreachable')
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, STATE_POLL_MS)
    const refresh = (): void => { void tick() }
    const onVisibility = (): void => { if (!document.hidden) void tick() }
    window.addEventListener(WECHAT_CHANGE, refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener(WECHAT_CHANGE, refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const stateText = indicator === 'connected' ? t('chatWechatStateConnected')
    : indicator === 'logged-out' ? t('chatWechatStateLoggedOut')
      : indicator === 'unreachable' ? t('chatWechatStateUnreachable') : ''
  return <button type="button" className="chat-wechat-entry" onClick={onClick}
    title={stateText ? `${t('chatWechat')} · ${stateText}` : t('chatWechat')}>
    <span className="chat-wechat-entry-icon"><WechatIcon size={15} /></span>
    <span className="chat-wechat-entry-label">{t('chatWechat')}</span>
    {stateText && <span className="chat-wechat-entry-state" data-state={indicator}>
      <span className="chat-wechat-entry-dot" aria-hidden="true" />
      <span className="chat-wechat-entry-state-text">{stateText}</span>
    </span>}
  </button>
}

/**
 * The WeChat file-transfer window: an unconnected bridge shows its scan code and login phase,
 * a connected one shows the account and a sign-out action. Status is polled while the dialog is open.
 */
export function WechatAccessDialog({ t, onClose }: { t: T; onClose: () => void }) {
  const [status, setStatus] = useState<WechatStatus>()
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const autoStarted = useRef(false)
  const startingBridge = useRef(false)
  const live = useRef(true)
  const windowRef = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  // Tell the sidebar entry as soon as the login state changes, rather than waiting for its slower poll.
  const connected = status?.loggedIn
  useEffect(() => { window.dispatchEvent(new Event(WECHAT_CHANGE)) }, [connected])

  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    windowRef.current?.focus()
    const key = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') close.current()
      else if (event.key === 'Tab' && windowRef.current) trapTab(event, windowRef.current)
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); opener?.focus() }
  }, [])

  const tick = useCallback(async () => {
    try {
      const next = await bridge<WechatStatus>('/wechat/status')
      if (!live.current) return
      setStatus(next); setFailure(undefined)
    } catch (reason) {
      if (!live.current || startingBridge.current) return
      // The dialog is the on-demand trigger: ask the host to start the bridge, then retry once.
      startingBridge.current = true
      try {
        await startBridge()
        const next = await bridge<WechatStatus>('/wechat/status')
        if (!live.current) return
        setStatus(next); setFailure(undefined)
      } catch (failure) {
        if (live.current) setFailure(failureText(t, failure))
      } finally {
        startingBridge.current = false
      }
    }
  }, [t])

  useEffect(() => {
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [tick])

  const login = useCallback(async () => {
    setBusy(true)
    try {
      await startBridge()
      const next = await bridge<WechatStatus>('/wechat/login', { method: 'POST' })
      if (!live.current) return
      setStatus(next); setFailure(undefined)
    } catch (reason) {
      if (live.current) setFailure(failureText(t, reason))
    } finally {
      if (live.current) setBusy(false)
    }
  }, [t])

  // Opening the window on an unconnected bridge fetches a code once; after that, retries are explicit.
  useEffect(() => {
    if (!status || status.loggedIn || autoStarted.current) return
    if ((status.login?.phase ?? 'idle') !== 'idle') return
    autoStarted.current = true
    void login()
  }, [status, login])

  const logout = useCallback(async () => {
    if (!window.confirm(t('chatWechatLogoutConfirm'))) return
    // Signing out is deliberate: show the idle "scan to sign in" action instead of another code right away.
    autoStarted.current = true
    setBusy(true)
    try {
      const next = await bridge<WechatStatus>('/wechat/logout', { method: 'POST' })
      if (!live.current) return
      setStatus(next); setFailure(undefined)
    } catch (reason) {
      if (live.current) setFailure(failureText(t, reason))
    } finally {
      if (live.current) setBusy(false)
    }
  }, [t])

  const phase = status?.login?.phase ?? 'idle'
  const phaseText = phase === 'connecting' ? t('chatWechatConnecting')
    : phase === 'waiting' ? t('chatWechatWaiting')
      : phase === 'scanned' ? t('chatWechatScanned')
        : phase === 'starting' ? t('chatWechatStarting')
          : phase === 'error' ? status?.login?.message || t('chatWechatError')
            : status?.login?.message || t('chatWechatLoggedOut')
  const retry = !busy && (phase === 'idle' || phase === 'error')

  return createPortal(<div className="chat-wechat-modal" role="presentation">
    <div className="chat-wechat-mask" aria-hidden="true" onClick={() => close.current()} />
    <div ref={windowRef} className="chat-wechat-window" role="dialog" aria-modal="true" aria-label={t('chatWechatTitle')} tabIndex={-1}>
      <div className="chat-wechat-head">
        <h2>{t('chatWechatTitle')}</h2>
        <button type="button" className="chat-wechat-close" aria-label={t('close')} onClick={() => close.current()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <p className="chat-wechat-subtitle">{t('chatWechatSubtitle')}</p>
      <div className="chat-wechat-dialog">
        {failure && <p className="chat-wechat-error" role="alert">{failure}</p>}
        {!status ? <div className="chat-wechat-scan">
          <p className="chat-wechat-hint">{t('loading')}</p>
          {failure && <button type="button" className="chat-button chat-primary" onClick={() => void tick()}>
            {t('chatWechatRetry')}
          </button>}
        </div>
          : status.loggedIn ? <div className="chat-wechat-connected">
            <div className="chat-wechat-account">
              <span className="chat-wechat-avatar" aria-hidden="true"><WechatIcon size={18} /></span>
              <span className="chat-wechat-names">
                <span className="chat-wechat-name">{status.nick || t('chatWechatAccount')}</span>
                <span className="chat-wechat-state-text"><span className="chat-wechat-dot" />{t('chatWechatConnected')}</span>
              </span>
            </div>
            <p className="chat-wechat-hint">{t('chatWechatConnectedHint')}</p>
            <button type="button" className="chat-button chat-wechat-logout" onClick={() => void logout()} disabled={busy}>
              {t('chatWechatLogout')}
            </button>
          </div>
          : <div className="chat-wechat-scan">
            <div className="chat-wechat-qr-wrap">
              {status.login?.qr
                ? <img className="chat-wechat-qr" src={status.login.qr} width={240} height={240} alt={t('chatWechatQrAlt')} />
                : <span className="chat-wechat-qr chat-wechat-qr-empty" role="img" aria-label={t('chatWechatQrAlt')}>
                  {phase === 'connecting' ? t('chatWechatConnecting') : t('chatWechatNoQr')}
                </span>}
            </div>
            <p className="chat-wechat-phase" role="status">{phaseText}</p>
            {retry && <button type="button" className="chat-button chat-primary" onClick={() => void login()} disabled={busy}>
              {phase === 'error' ? t('chatWechatRetry') : t('chatWechatLogin')}
            </button>}
            <p className="chat-wechat-hint">{t('chatWechatScanHint')}</p>
          </div>}
      </div>
    </div>
  </div>, document.body)
}
