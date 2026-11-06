/** Super Chat panel: one general stream with named topic tags, plus optional WeChat access. */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { sameTopicName, type ChatMessage, type ChatView, type Topic } from '../protocol.ts'
import type { T } from './locales.ts'
import { when } from './text.ts'
import { mergeTagNames, messageTagNames, parseTagInput, splitTags } from './topics.ts'
import { WechatAccessButton, WechatAccessDialog } from './wechat.tsx'
import STYLES from './chat.css?raw'

const PREFIX = '/super-chat/api'
const ACTIVE_TOPIC = 'super-chat-topic'
const UNTAGGED = 'untagged'
const DRAFT_KEY = 'super-chat-draft'
const LAYOUT_KEY = 'super-chat-topic-width'
const DEFAULT_WIDTH = 248
const MIN_WIDTH = 180
const MAX_WIDTH = 420
const POLL_MS = 2500

class ChatError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function ask<T>(path: string, init?: RequestInit): Promise<T> {
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

const errorText = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure)
const isComposing = (event: KeyboardEvent): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229
const stored = (key: string): string | undefined => {
  try { return window.localStorage.getItem(key) ?? undefined } catch { return undefined }
}
const store = (key: string, value: string): void => {
  try { window.localStorage.setItem(key, value) } catch { /* storage disabled */ }
}
const forget = (key: string): void => {
  try { window.localStorage.removeItem(key) } catch { /* storage disabled */ }
}
const clampWidth = (value: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)))
const readWidth = (): number => {
  const raw = stored(LAYOUT_KEY), value = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(value) ? clampWidth(value) : DEFAULT_WIDTH
}

function Icon({ name, size = 16 }: { name: 'chat' | 'plus' | 'send' | 'stop' | 'tag' | 'tagOff' | 'x' | 'pencil'; size?: number }) {
  const path = name === 'chat'
    ? <><path d="M20 15a3 3 0 0 1-3 3H8l-4 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" /><path d="M8 9h8M8 13h5" /></>
    : name === 'plus'
      ? <><path d="M12 5v14M5 12h14" /></>
      : name === 'tag'
        ? <><path d="M4 4h7l9 9-7 7-9-9z" /><circle cx="8" cy="8" r="1.4" /></>
        : name === 'tagOff'
          ? <><path d="M4 4h7l9 9-7 7-9-9z" /><circle cx="8" cy="8" r="1.4" /><path d="m3 3 18 18" /></>
        : name === 'stop'
          ? <><rect x="6" y="6" width="12" height="12" rx="2" /></>
          : name === 'x'
            ? <><path d="m6 6 12 12M18 6 6 18" /></>
            : name === 'pencil'
              ? <><path d="M4 20h4L20 8l-4-4L4 16z" /><path d="m14 6 4 4" /></>
              : <><path d="m4 4 16 8-16 8 4-8z" /></>
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>{path}</svg>
}

/** The chat panel: general stream, topic filters, tagged composer and WeChat access. */
export function ChatPanel({ t }: { t: T }) {
  const [topicId, setTopicId] = useState<string | undefined>(() => stored(ACTIVE_TOPIC) || undefined)
  const [view, setView] = useState<ChatView>({ topics: [], messages: [], mode: 'session' })
  const [width, setWidth] = useState(readWidth)
  const [wechatOpen, setWechatOpen] = useState(false)
  const [draft, setDraft] = useState(() => stored(DRAFT_KEY) ?? '')
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const [newTopic, setNewTopic] = useState<string>()
  const [error, setError] = useState<string>()
  const [tagging, setTagging] = useState(false)
  const [tagNote, setTagNote] = useState<string>()
  const [offline, setOffline] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [sending, setSending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [editing, setEditing] = useState<{ id: string; tags: string[]; draft: string }>()
  const [savingTags, setSavingTags] = useState(false)
  const drag = useRef<{ x: number; width: number }>()
  const end = useRef<HTMLDivElement>(null)
  const latest = useRef(0)
  const topicRef = useRef(topicId)
  const lastMessage = useRef<string>()

  const selectedTopic = view.topic
  const untaggedView = topicId === UNTAGGED
  const shownMessages = untaggedView ? view.messages.filter(message => message.tags.length === 0) : view.messages
  const title = untaggedView ? t('untagged') : selectedTopic?.name || t('generalChat')
  const extraTags = tags.filter(name => !selectedTopic || !sameTopicName(name, selectedTopic.name))
  const autoTagAllowed = (value: string | undefined): boolean => value === undefined || value === UNTAGGED

  const load = useCallback(async (topic = topicId) => {
    const request = ++latest.current
    const untagged = topic === UNTAGGED
    try {
      const result = await ask<ChatView>('/chat' + (!untagged && topic ? '?topic=' + encodeURIComponent(topic) : ''))
      if (request !== latest.current) return
      const active = untagged ? UNTAGGED : result.topic?.id
      topicRef.current = active
      setTopicId(active)
      setView(result)
      setLoaded(true)
      setOffline(false)
      if (active) store(ACTIVE_TOPIC, active)
      else forget(ACTIVE_TOPIC)
    } catch (failure) {
      if (request !== latest.current) return
      if (failure instanceof ChatError && failure.status === 404 && topic && topic !== UNTAGGED) {
        forget(ACTIVE_TOPIC)
        topicRef.current = undefined
        setTopicId(undefined)
        return
      }
      setOffline(true)
      throw failure
    }
  }, [topicId])

  useEffect(() => {
    load().catch(failure => { if (!(failure instanceof ChatError)) setError(errorText(failure)) })
    const timer = setInterval(() => { load().catch(() => {}) }, POLL_MS)
    return () => clearInterval(timer)
  }, [load])
  useEffect(() => { store(LAYOUT_KEY, String(width)) }, [width])
  useEffect(() => { store(DRAFT_KEY, draft) }, [draft])
  useEffect(() => {
    const newest = view.messages.at(-1)?.id
    if (newest === lastMessage.current) return
    lastMessage.current = newest
    end.current?.scrollIntoView({ block: 'end' })
  }, [view.messages])

  const selectTopic = (next?: string) => {
    if (next === topicId) return
    setLoaded(false)
    setError(undefined)
    setTagNote(undefined)
    setEditing(undefined)
    setTags([])
    setTagDraft('')
    setNewTopic(undefined)
    topicRef.current = next
    setTopicId(next)
    if (next) store(ACTIVE_TOPIC, next)
    else forget(ACTIVE_TOPIC)
  }
  const addTags = (value: string) => {
    const names = splitTags(value)
    if (names.length === 0) return
    setTags(previous => mergeTagNames(selectedTopic?.name, [...previous, ...names])
      .filter(name => !selectedTopic || !sameTopicName(name, selectedTopic.name)))
    setTagDraft('')
  }
  const removeTag = (name: string) => {
    setTags(previous => previous.filter(item => !sameTopicName(item, name)))
  }
  const tagKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event)) return
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      event.preventDefault()
      addTags(tagDraft)
    }
    if (event.key === 'Backspace' && !tagDraft && extraTags.length) {
      setTags(previous => previous.slice(0, -1))
    }
    if (event.key === 'Escape') setTagDraft('')
  }
  const createTopic = async (event: FormEvent) => {
    event.preventDefault()
    const name = parseTagInput(newTopic ?? '')
    if (!name) return
    try {
      const result = await ask<{ topic: Topic; topics: Topic[] }>('/topics', {
        method: 'POST', body: JSON.stringify({ name }),
      })
      setView(previous => ({ ...previous, topics: result.topics }))
      setNewTopic(undefined)
      selectTopic(result.topic.id)
    } catch (failure) { setError(errorText(failure)) }
  }
  const send = async (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    setSending(true); setError(undefined); setTagNote(undefined)
    // Include a tag the user typed but has not yet committed with Enter.
    const tagsToSend = mergeTagNames(selectedTopic?.name, [...extraTags, ...splitTags(tagDraft)])
    const viewAtStart = topicRef.current
    const request = ++latest.current
    try {
      const result = await ask<ChatView & { result: string }>('/chat', {
        method: 'POST',
        body: JSON.stringify({
          text,
          tags: tagsToSend,
          clientId: globalThis.crypto?.randomUUID?.(),
          ...(viewAtStart && viewAtStart !== UNTAGGED ? { topic: viewAtStart } : {}),
          via: 'panel',
        }),
      })
      setDraft(''); setTags([]); setTagDraft(''); forget(DRAFT_KEY)
      setOffline(false)
      if (request !== latest.current || topicRef.current !== viewAtStart) return
      // The server returns the first tag's topic view; the untagged view needs the whole stream.
      if (viewAtStart === UNTAGGED) {
        await load(UNTAGGED)
        return
      }
      const active = result.topic?.id
      topicRef.current = active
      setTopicId(active)
      setView(result)
      setLoaded(true)
      if (active) store(ACTIVE_TOPIC, active)
      else forget(ACTIVE_TOPIC)
    } catch (failure) { setError(errorText(failure)) } finally { setSending(false) }
  }
  const autoTag = async () => {
    if (tagging || !autoTagAllowed(topicRef.current)) return
    setEditing(undefined)
    setTagging(true); setError(undefined); setTagNote(undefined)
    const request = ++latest.current
    try {
      const result = await ask<ChatView & { tagged: number }>('/chat/tag', { method: 'POST', body: '{}' })
      // A topic selected while the model was running owns the view now; polling will refresh it.
      if (request !== latest.current || !autoTagAllowed(topicRef.current)) return
      setView(result)
      setLoaded(true)
      setOffline(false)
      setTagNote(result.tagged > 0 ? t('autoTagDone', { count: result.tagged }) : t('autoTagNone'))
    } catch (failure) { if (autoTagAllowed(topicRef.current)) setError(errorText(failure)) } finally { setTagging(false) }
  }
  const startEdit = (message: ChatMessage) => {
    setError(undefined)
    setEditing({ id: message.id, tags: messageTagNames(message, view.topics), draft: '' })
  }
  const cancelEdit = () => setEditing(undefined)
  const addEditTags = (value: string) => {
    const names = splitTags(value)
    if (names.length === 0) return
    setEditing(current => current
      ? { ...current, tags: mergeTagNames(undefined, [...current.tags, ...names]), draft: '' }
      : current)
  }
  const removeEditTag = (name: string) => {
    setEditing(current => current
      ? { ...current, tags: current.tags.filter(item => !sameTopicName(item, name)) }
      : current)
  }
  const editKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event)) return
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      event.preventDefault()
      addEditTags(editing?.draft ?? '')
    }
    if (event.key === 'Backspace' && !editing?.draft && editing?.tags.length) {
      setEditing(current => current ? { ...current, tags: current.tags.slice(0, -1) } : current)
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelEdit()
    }
  }
  const saveEdit = async (event: FormEvent) => {
    event.preventDefault()
    if (!editing || savingTags) return
    setSavingTags(true); setError(undefined)
    const names = mergeTagNames(undefined, [...editing.tags, ...splitTags(editing.draft)])
    const viewAtStart = topicRef.current
    const topicField = viewAtStart && viewAtStart !== UNTAGGED ? { topic: viewAtStart } : {}
    const request = ++latest.current
    try {
      const result = await ask<ChatView & { result: string }>('/chat/tags', {
        method: 'POST',
        body: JSON.stringify({ id: editing.id, tags: names, ...topicField }),
      })
      // A topic selected while the save was in flight owns the view now; polling will refresh it.
      if (request !== latest.current || topicRef.current !== viewAtStart) return
      setView(result)
      setEditing(current => current && current.id === editing.id ? undefined : current)
      setOffline(false)
    } catch (failure) {
      if (topicRef.current === viewAtStart) setError(errorText(failure))
    } finally { setSavingTags(false) }
  }
  const stop = async () => {
    if (cancelling) return
    setCancelling(true); setError(undefined)
    const viewAtStart = topicRef.current
    const request = ++latest.current
    try {
      const result = await ask<ChatView & { cancelled: boolean }>('/chat/cancel', {
        method: 'POST', body: JSON.stringify(viewAtStart && viewAtStart !== UNTAGGED ? { topic: viewAtStart } : {}),
      })
      if (request !== latest.current || topicRef.current !== viewAtStart) return
      setView(result)
    } catch (failure) { if (topicRef.current === viewAtStart) setError(errorText(failure)) } finally { setCancelling(false) }
  }
  const sendKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(event)) return
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
  }

  const topicRow = (topic: Topic) => <button key={topic.id} type="button" className="chat-topic-row"
    data-active={topic.id === topicId || undefined} onClick={() => selectTopic(topic.id)}
    title={topic.name} aria-current={topic.id === topicId ? 'page' : undefined}>
    <span className="chat-topic-icon"><Icon name="tag" size={14} /></span>
    <span className="chat-topic-name">{topic.name}</span>
    <span className="chat-topic-count">{topic.messageCount ?? 0}</span>
    {topic.busy && <span className="chat-busy" data-on role="img" aria-label={t('busy')} title={t('busy')} />}
  </button>

  return <div className="chat-page">
    <style>{STYLES}</style>
    <aside className="chat-sidebar" style={{ width }}>
      <div className="chat-sidebar-head"><span className="chat-sidebar-title">{t('topics')}</span></div>
      <button type="button" className="chat-new" onClick={() => setNewTopic(newTopic === undefined ? '' : undefined)} title={t('newTopic')}>
        <Icon name="plus" size={14} /> {t('newTopic')}
      </button>
      {newTopic !== undefined && <form className="chat-topic-create" onSubmit={event => void createTopic(event)}>
        <input className="chat-topic-input" autoFocus maxLength={60} value={newTopic} onChange={event => setNewTopic(event.target.value)}
          onKeyDown={event => { if (!isComposing(event) && event.key === 'Escape') { event.preventDefault(); setNewTopic(undefined) } }}
          placeholder={t('topicPlaceholder')} aria-label={t('topicPlaceholder')} />
      </form>}
      <nav className="chat-topic-list" aria-label={t('topics')}>
        <button type="button" className="chat-topic-row" data-active={!topicId || undefined} onClick={() => selectTopic(undefined)}>
          <span className="chat-topic-icon"><Icon name="chat" size={14} /></span>
          <span className="chat-topic-name">{t('generalChat')}</span>
          {view.busy && topicId === undefined && <span className="chat-busy" data-on role="img" aria-label={t('busy')} title={t('busy')} />}
        </button>
        <button type="button" className="chat-topic-row" data-active={topicId === UNTAGGED || undefined}
          onClick={() => selectTopic(UNTAGGED)} title={t('untagged')}>
          <span className="chat-topic-icon"><Icon name="tagOff" size={14} /></span>
          <span className="chat-topic-name">{t('untagged')}</span>
          {view.busy && topicId === UNTAGGED && <span className="chat-busy" data-on role="img" aria-label={t('busy')} title={t('busy')} />}
        </button>
        {view.topics.map(topicRow)}
      </nav>
      <div className="chat-sidebar-foot"><WechatAccessButton t={t} onClick={() => setWechatOpen(true)} /></div>
    </aside>
    <div className="chat-resizer" role="separator" aria-orientation="vertical" aria-label={t('resize')}
      aria-valuenow={width} aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} tabIndex={0}
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width } }}
      onPointerMove={event => {
        if (!drag.current) return
        const next = clampWidth(drag.current.width + event.clientX - drag.current.x)
        if (next !== width) setWidth(next)
      }}
      onPointerUp={event => { drag.current = undefined
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
      onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); setWidth(previous => clampWidth(previous - 16)) }
        if (event.key === 'ArrowRight') { event.preventDefault(); setWidth(previous => clampWidth(previous + 16)) }
        if (event.key === 'Home') { event.preventDefault(); setWidth(DEFAULT_WIDTH) }
      }} />
    <section className="chat-main">
      <header className="chat-head">
        <div className="chat-head-text">
          <h1 className="chat-title">{title}</h1>
          <p className="chat-subtitle">{view.mode === 'superagent' ? t('modeSuperagent') : t('modeSession')}</p>
        </div>
        <div className="chat-head-actions">
          {!selectedTopic && <button type="button" className="chat-button chat-auto-tag" onClick={() => void autoTag()}
            disabled={tagging || view.topics.length === 0}
            aria-label={tagging ? t('autoTagRunning') : t('autoTag')}
            aria-busy={tagging || undefined}
            title={view.topics.length === 0 ? t('autoTagNoTopics') : t('autoTagHint')}>
            <Icon name="tag" size={14} /> <span className="chat-auto-tag-label">{tagging ? t('autoTagRunning') : t('autoTag')}</span>
          </button>}
          {view.busy && <button type="button" className="chat-button chat-stop" onClick={() => void stop()} disabled={cancelling}
            title={t('stopHint')}><Icon name="stop" size={14} /> {t('stop')}</button>}
        </div>
      </header>
      {offline && <p className="chat-error" role="status">{t('connectionFailed')}</p>}
      {error && <p className="chat-error" role="alert">{error}</p>}
      {tagNote && <p className="chat-note" role="status">{tagNote}</p>}
      <div className="chat-messages" role="log" aria-live="polite">
        {!loaded ? <p className="chat-hint">{t('loading')}</p>
          : shownMessages.length === 0
            ? <p className="chat-hint">{untaggedView ? t('emptyUntagged') : selectedTopic ? t('emptyTopic') : t('emptyGeneral')}</p>
            : shownMessages.map(message => {
              const editingThis = editing !== undefined && editing.id === message.id
              return <article key={message.id} className="chat-message" data-role={message.role}
                data-kind={message.kind || undefined}>
                <div className="chat-bubble">{message.text}</div>
                <div className="chat-message-foot">
                  {editingThis && editing
                    ? <div className="chat-message-tags">
                      {editing.tags.map(name => <span key={name} className="chat-tag">{name}
                        <button type="button" className="chat-tag-remove" aria-label={t('removeTag')} title={t('removeTag')}
                          onClick={() => removeEditTag(name)}><Icon name="x" size={11} /></button>
                      </span>)}
                    </div>
                    : <div className="chat-message-tags">
                      {messageTagNames(message, view.topics).map(name => <button key={name} type="button" className="chat-tag"
                        onClick={() => { const topic = view.topics.find(item => sameTopicName(item.name, name)); if (topic) selectTopic(topic.id) }}
                        title={t('openTopic')}>{name}</button>)}
                    </div>}
                  {!editingThis && <button type="button" className="chat-message-edit" aria-label={t('editTags')} title={t('editTags')}
                    onClick={() => startEdit(message)}><Icon name="pencil" size={12} /></button>}
                  <span className="chat-meta">{message.role === 'user' ? t('you') : t('agent')} · {when(message.at, t('lang'))}</span>
                </div>
                {editingThis && editing && <form className="chat-tag-editor" onSubmit={event => void saveEdit(event)}>
                  <input className="chat-tag-input" autoFocus value={editing.draft}
                    onChange={event => setEditing(current => current ? { ...current, draft: event.target.value } : current)}
                    onKeyDown={editKey} placeholder={t('tagPlaceholder')} aria-label={t('tagPlaceholder')}
                    list="super-chat-topic-options" />
                  <div className="chat-tag-editor-actions">
                    <button type="button" className="chat-button chat-button-small" onClick={cancelEdit}>{t('cancel')}</button>
                    <button type="submit" className="chat-button chat-button-small chat-primary" disabled={savingTags}>{t('save')}</button>
                  </div>
                </form>}
              </article>
            })}
        <div ref={end} />
      </div>
      <div className="chat-foot">
        <form className="chat-composer" onSubmit={send}>
          <div className="chat-tags">
            {selectedTopic && <span className="chat-tag chat-tag-fixed"><Icon name="tag" size={12} /> {selectedTopic.name}</span>}
            {extraTags.map(name => <span key={name} className="chat-tag">{name}
              <button type="button" className="chat-tag-remove" aria-label={t('removeTopic')} title={t('removeTopic')}
                onClick={() => removeTag(name)}><Icon name="x" size={11} /></button>
            </span>)}
            <input className="chat-tag-input" value={tagDraft} onChange={event => setTagDraft(event.target.value)}
              onKeyDown={tagKey} onBlur={() => { if (tagDraft.trim()) addTags(tagDraft) }}
              placeholder={t('tagPlaceholder')} aria-label={t('tagPlaceholder')} list="super-chat-topic-options" />
            <datalist id="super-chat-topic-options">
              {view.topics.map(topic => <option key={topic.id} value={topic.name} />)}
            </datalist>
          </div>
          <textarea className="chat-input" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={sendKey}
            placeholder={t('placeholder')} aria-label={t('placeholder')} rows={3} disabled={sending} />
          <div className="chat-composer-foot"><span className="chat-hint">{t('sendHint')}</span>
            <button type="submit" className="chat-button chat-primary" disabled={!draft.trim() || sending}><Icon name="send" /> {t('send')}</button></div>
        </form>
      </div>
    </section>
    {wechatOpen && <WechatAccessDialog t={t} onClose={() => setWechatOpen(false)} />}
  </div>
}
