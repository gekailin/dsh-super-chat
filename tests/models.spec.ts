import { describe, expect, it } from 'vitest'
import { effortsOf, modelLabel, modelsOf, parseWorkerModelDirective, resolveModelRef, roleModelOf, sameRoleModel, type ModelGroup } from '../src/models.ts'

const groups: ModelGroup[] = [
  {
    id: 'mccodex',
    name: 'MCCODEX',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
      { id: 'ide/gemini-4-argon', name: 'Gemini 4', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
      { id: 'glm-5.3', name: 'GLM 5.3' },
      { id: 'shared-model', name: 'Shared One' },
    ],
  },
  {
    id: 'friday',
    name: 'FRIDAY',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'shared-model', name: 'Shared Two' },
    ],
  },
]

describe('role models', () => {
  it('accepts a provider/model pair and an optional reasoning effort', () => {
    expect(roleModelOf({ provider: ' mccodex ', model: 'deepseek-v4.1-flash', reasoningEffort: ' high ' }))
      .toEqual({ provider: 'mccodex', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' })
    expect(roleModelOf({ provider: 'mccodex', model: 'glm-5.3' })).toEqual({ provider: 'mccodex', model: 'glm-5.3' })
  })

  it('rejects absent, empty or malformed values', () => {
    expect(roleModelOf(null)).toBeNull()
    expect(roleModelOf({ provider: '', model: 'x' })).toBeNull()
    expect(roleModelOf({ provider: 'x', model: ' ' })).toBeNull()
    expect(roleModelOf({ provider: 'x', model: 'y', reasoningEffort: '' })).toBeNull()
    expect(roleModelOf('x')).toBeNull()
  })

  it('compares and labels selections', () => {
    const value = { provider: 'mccodex', model: 'glm-5.3', reasoningEffort: 'high' }
    expect(sameRoleModel(value, { ...value })).toBe(true)
    expect(sameRoleModel(value, { ...value, reasoningEffort: 'low' })).toBe(false)
    expect(sameRoleModel(null, null)).toBe(true)
    expect(sameRoleModel(null, value)).toBe(false)
    expect(modelLabel(value)).toBe('mccodex / glm-5.3 · high')
  })

  it('lists provider models and efforts', () => {
    expect(modelsOf(groups, 'mccodex').map(model => model.id)).toEqual(['deepseek-v4.1-flash', 'ide/gemini-4-argon', 'glm-5.3', 'shared-model'])
    expect(modelsOf(groups, 'missing')).toEqual([])
    expect(effortsOf(groups, 'mccodex', 'deepseek-v4.1-flash').map(effort => effort.id)).toEqual(['low', 'high'])
    expect(effortsOf(groups, 'mccodex', 'shared-model')).toEqual([])
  })
})

describe('worker model directives', () => {
  it('reads the model from a Chinese or English worker request', () => {
    expect(parseWorkerModelDirective('用 gemini4 模型启动一个新worker做 issue #2')).toBe('gemini4')
    expect(parseWorkerModelDirective('用“Gemini 4”模型新建一个工单处理这个')).toBe('Gemini 4')
    expect(parseWorkerModelDirective('use gemini4 model to start a new worker for issue #2')).toBe('gemini4')
    expect(parseWorkerModelDirective('Use "Gemini 4" model to launch a worker')).toBe('Gemini 4')
    expect(parseWorkerModelDirective('用 mccodex/ide/gemini-4-argon 模型起一个 worker 跑一下')).toBe('mccodex/ide/gemini-4-argon')
  })

  it('leaves ordinary chat alone', () => {
    expect(parseWorkerModelDirective('用 gemini4 模型解释一下')).toBeUndefined()
    expect(parseWorkerModelDirective('start a new worker for issue #2')).toBeUndefined()
    expect(parseWorkerModelDirective('用这个模型启动一个 worker')).toBeUndefined()
    expect(parseWorkerModelDirective('use this model to start a worker')).toBeUndefined()
    expect(parseWorkerModelDirective('use worker model to start a worker')).toBeUndefined()
  })
})

describe('model reference resolution', () => {
  it('resolves provider/model, model id and display name', () => {
    expect(resolveModelRef('mccodex/deepseek-v4.1-flash', groups)).toEqual({ model: { provider: 'mccodex', model: 'deepseek-v4.1-flash' } })
    expect(resolveModelRef('mccodex/ide/gemini-4-argon', groups)).toEqual({ model: { provider: 'mccodex', model: 'ide/gemini-4-argon' } })
    expect(resolveModelRef('ide/gemini-4-argon', groups)).toEqual({ model: { provider: 'mccodex', model: 'ide/gemini-4-argon' } })
    expect(resolveModelRef('gemini 4', groups)).toEqual({ model: { provider: 'mccodex', model: 'ide/gemini-4-argon' } })
    expect(resolveModelRef('mccodex:glm-5.3', groups)).toEqual({ model: { provider: 'mccodex', model: 'glm-5.3' } })
  })

  it('adds a valid reasoning effort and rejects an unsupported one', () => {
    expect(resolveModelRef('mccodex/deepseek-v4.1-flash@high', groups))
      .toEqual({ model: { provider: 'mccodex', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } })
    expect(resolveModelRef('ide/gemini-4-argon@low', groups)).toEqual(expect.objectContaining({
      error: expect.stringContaining('available: high'),
    }))
    expect(resolveModelRef('mccodex/glm-5.3@high', groups)).toEqual(expect.objectContaining({
      error: expect.stringContaining('does not support reasoning effort'),
    }))
  })

  it('rejects unknown and ambiguous references', () => {
    expect(resolveModelRef('nope', groups)).toEqual({ error: expect.stringContaining('Unknown model "nope"') })
    expect(resolveModelRef('shared-model', groups)).toEqual({ error: expect.stringContaining('ambiguous') })
    expect(resolveModelRef('shared-model', groups)).toEqual(expect.objectContaining({
      error: expect.stringContaining('mccodex, friday'),
    }))
  })
})
