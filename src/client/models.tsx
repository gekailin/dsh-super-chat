/** Model settings entry: orchestrator and default worker role models, plus the per-worker chat hint. */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { effortsOf, modelLabel, modelsOf, sameRoleModel, type ModelGroup, type ModelRole, type ModelRolesView, type RoleModel } from '../models.ts'
import { ask } from './api.ts'
import type { T } from './locales.ts'
import { trapTab } from './wechat.tsx'

interface Draft {
  provider: string
  model: string
  effort: string
}

const draftOf = (value: RoleModel | null): Draft => value
  ? { provider: value.provider, model: value.model, effort: value.reasoningEffort ?? '' }
  : { provider: '', model: '', effort: '' }

const modelOf = (draft: Draft): RoleModel | null => draft.provider
  ? { provider: draft.provider, model: draft.model, ...(draft.effort ? { reasoningEffort: draft.effort } : {}) }
  : null

const complete = (draft: Draft): boolean => !draft.provider || !!draft.model

function ModelIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </svg>
}

export function ModelSettingsButton({ t, onClick }: { t: T; onClick: () => void }) {
  return <button type="button" className="chat-models-entry" onClick={onClick} title={t('modelsTitle')}>
    <span className="chat-models-entry-icon"><ModelIcon /></span>
    <span className="chat-models-entry-label">{t('models')}</span>
  </button>
}

function RoleField({ label, hint, value, groups, onChange, t }: {
  label: string
  hint: string
  value: Draft
  groups: readonly ModelGroup[]
  onChange: (next: Draft) => void
  t: T
}) {
  const models = modelsOf(groups, value.provider)
  const efforts = effortsOf(groups, value.provider, value.model)
  const providerMissing = !!value.provider && !groups.some(group => group.id === value.provider)
  const modelMissing = !!value.model && !models.some(model => model.id === value.model)
  const effortMissing = !!value.effort && !efforts.some(effort => effort.id === value.effort)
  return <fieldset className="chat-models-role">
    <legend>{label}</legend>
    <p className="chat-models-hint">{hint}</p>
    <label className="chat-models-field">
      <span>{t('modelProvider')}</span>
      <select value={value.provider} onChange={event => onChange({ provider: event.target.value, model: '', effort: '' })}>
        <option value="">{t('modelInherit')}</option>
        {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        {providerMissing && <option value={value.provider}>{value.provider}</option>}
      </select>
    </label>
    <label className="chat-models-field">
      <span>{t('modelName')}</span>
      <select value={value.model} disabled={!value.provider}
        onChange={event => onChange({ ...value, model: event.target.value, effort: '' })}>
        <option value="">{value.provider ? t('modelChoose') : t('modelInherit')}</option>
        {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        {modelMissing && <option value={value.model}>{value.model}</option>}
      </select>
    </label>
    <label className="chat-models-field">
      <span>{t('modelEffort')}</span>
      <select value={value.effort} disabled={!value.model} onChange={event => onChange({ ...value, effort: event.target.value })}>
        <option value="">{t('modelEffortDefault')}</option>
        {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name || effort.id}</option>)}
        {effortMissing && <option value={value.effort}>{value.effort}</option>}
      </select>
    </label>
  </fieldset>
}

/** The model settings window: role selectors backed by the prototype's settings and the profile catalog. */
export function ModelSettingsDialog({ t, onClose }: { t: T; onClose: () => void }) {
  const [view, setView] = useState<ModelRolesView>()
  const [draft, setDraft] = useState<Record<ModelRole, Draft>>({ orchestrator: draftOf(null), worker: draftOf(null) })
  const [error, setError] = useState<string>()
  const [note, setNote] = useState<string>()
  const [saving, setSaving] = useState(false)
  const windowRef = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  const load = async (): Promise<void> => {
    try {
      const result = await ask<ModelRolesView>('/models')
      setView(result)
      setDraft({ orchestrator: draftOf(result.orchestrator), worker: draftOf(result.worker) })
      setError(result.error)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  useEffect(() => {
    void load()
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    windowRef.current?.focus()
    const key = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') close.current()
      else if (event.key === 'Tab' && windowRef.current) trapTab(event, windowRef.current)
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); opener?.focus() }
  }, [])

  const available = view?.available === true
  const completeDraft = complete(draft.orchestrator) && complete(draft.worker)
  const dirty = !!view && (!sameRoleModel(modelOf(draft.orchestrator), view.orchestrator)
    || !sameRoleModel(modelOf(draft.worker), view.worker))
  const change = (role: ModelRole, next: Draft): void => {
    setDraft(previous => ({ ...previous, [role]: next }))
    setNote(undefined)
    setError(undefined)
  }

  const save = async (): Promise<void> => {
    if (!view || !available || saving || !completeDraft) return
    const roles: ModelRole[] = []
    if (!sameRoleModel(modelOf(draft.orchestrator), view.orchestrator)) roles.push('orchestrator')
    if (!sameRoleModel(modelOf(draft.worker), view.worker)) roles.push('worker')
    if (roles.length === 0) { close.current(); return }
    setSaving(true); setError(undefined); setNote(undefined)
    try {
      let latest = view
      for (const role of roles) {
        latest = await ask<ModelRolesView>('/models', {
          method: 'POST', body: JSON.stringify({ role, model: modelOf(draft[role]) }),
        })
      }
      setView(latest)
      setDraft({ orchestrator: draftOf(latest.orchestrator), worker: draftOf(latest.worker) })
      setNote(t('modelsSaved'))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }

  return createPortal(<div className="chat-models-modal" role="presentation">
    <div className="chat-models-mask" aria-hidden="true" onClick={() => close.current()} />
    <div ref={windowRef} className="chat-models-window" role="dialog" aria-modal="true" aria-label={t('modelsTitle')} tabIndex={-1}>
      <div className="chat-models-head">
        <h2>{t('modelsTitle')}</h2>
        <button type="button" className="chat-models-close" aria-label={t('close')} onClick={() => close.current()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <p className="chat-models-subtitle">{t('modelsSubtitle')}</p>
      {error && <p className="chat-models-error" role="alert">{error}</p>}
      {!view ? <p className="chat-models-hint">{t('loading')}</p>
        : !available ? <p className="chat-models-hint">{t('modelsUnavailable')}</p>
          : <>
            {view.default && <p className="chat-models-hint">{t('modelsDefault', { model: modelLabel(view.default) })}</p>}
            <RoleField label={t('modelOrchestrator')} hint={t('modelOrchestratorHint')}
              value={draft.orchestrator} groups={view.groups} t={t}
              onChange={next => change('orchestrator', next)} />
            <RoleField label={t('modelWorker')} hint={t('modelWorkerHint')}
              value={draft.worker} groups={view.groups} t={t}
              onChange={next => change('worker', next)} />
            <p className="chat-models-hint">{t('modelsDirectiveHint')}</p>
            {(view.failures ?? []).length > 0 && <p className="chat-models-hint">
              {t('modelsFailures', { names: view.failures.map(failure => failure.name).join(t('listSeparator')) })}
            </p>}
            {!completeDraft && <p className="chat-models-error" role="alert">{t('modelsInvalid')}</p>}
            {note && <p className="chat-models-note" role="status">{note}</p>}
            <div className="chat-models-actions">
              <button type="button" className="chat-button chat-button-small" onClick={() => close.current()}>{t('close')}</button>
              <button type="button" className="chat-button chat-button-small chat-primary" onClick={() => void save()}
                disabled={saving || !dirty || !completeDraft}>{t('save')}</button>
            </div>
          </>}
    </div>
  </div>, document.body)
}
