/**
 * dsh-super-chat host half: a Super Chat surface for a DSH Web profile.
 *
 * The chat is one message stream with named topic tags, stored in SQLite. When
 * dsh-superagent-prototype is installed, the panel registers a super-chat Source on its public
 * orchestrator service: tagged messages use their first tag as a dispatch cue, untagged messages go
 * to the general thread. Without that service, one fallback DSH Session handles the general chat.
 * Two narrow patches remain: the Session-list filter in monkey.ts and the memory-only chat-only
 * Setup patch in superagent.ts.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { createApi } from './api.ts'
import { hideChatSessions } from './monkey.ts'
import { GeneralSession } from './session.ts'
import { ChatStore } from './store.ts'
import { SuperagentChat } from './superagent.ts'
import { AutoTagger } from './tagger.ts'
import { ChatTransportRouter } from './transport.ts'
import { WechatBridge } from './wechat-bridge.ts'

export const name = 'dsh-super-chat'
/** Services the host half needs before it can mount. */
export const inject = ['webServer', 'sessionController', 'agents', 'permissionPresets']

/** Profile configuration. Every field has a working default, so the bundle can be enabled with no config. */
export interface Config {
  /** Directory for chat.sqlite; defaults to <DSH home>/state/super-chat. */
  stateDir?: string
  /** Workspace directory the fallback Session works in; defaults to the DSH process's invoking directory. */
  cwd?: string
  /** Agent preset for the fallback Session; the deployment default when omitted. */
  agentPreset?: string
  /** Permission preset for the fallback Session; the profile default when omitted. */
  permissionPreset?: string
}

/** The DSH home used when the launcher did not export one. */
const dshHome = (): string => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')

/** Validate configuration without rejecting unknown keys, so a newer profile field cannot break boot. */
function optionsOf(ctx: Context, config: Config | undefined): { stateDir: string; cwd: string; agentPreset?: string; permissionPreset?: string } {
  const raw = (config ?? {}) as Record<string, unknown>
  const stateDir = typeof raw.stateDir === 'string' && raw.stateDir.trim()
    ? resolve(raw.stateDir.trim())
    : join(dshHome(), 'state', 'super-chat')
  const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? resolve(raw.cwd.trim()) : resolve(process.cwd())
  const agentPreset = typeof raw.agentPreset === 'string' && raw.agentPreset.trim() ? raw.agentPreset.trim() : undefined
  const permissionPreset = typeof raw.permissionPreset === 'string' && raw.permissionPreset.trim() ? raw.permissionPreset.trim() : undefined
  if (!ctx.webServer.port) throw new Error('Super Chat needs a listening DSH web server')
  return { stateDir, cwd, ...(agentPreset ? { agentPreset } : {}), ...(permissionPreset ? { permissionPreset } : {}) }
}

/** Mount the SQLite store, the core superagent Source, the fallback Session, the API and the list patch. */
export function apply(ctx: Context, config?: Config): void {
  const options = optionsOf(ctx, config)
  const store = new ChatStore(join(options.stateDir, 'chat.sqlite'))
  store.load()
  const superagent = new SuperagentChat(ctx, store, message => ctx.logger.warn('dsh-super-chat: %s', message))
  const session = new GeneralSession(ctx, store, {
    cwd: options.cwd,
    ...(options.agentPreset ? { agentPreset: options.agentPreset } : {}),
    ...(options.permissionPreset ? { permissionPreset: options.permissionPreset } : {}),
  })
  const transport = new ChatTransportRouter(superagent, session)
  const tagger = new AutoTagger(ctx, store, message => ctx.logger.warn('dsh-super-chat: %s', message))
  // The bridge is started on demand by the WeChat access dialog; it is never started at plugin load.
  const wechat = new WechatBridge({ stateDir: options.stateDir, panelPort: ctx.webServer.port! })

  ctx.effect(() => session.start(), 'super-chat: fallback session')
  ctx.effect(() => { superagent.start(); return () => superagent.stop() }, 'super-chat: superagent source')
  ctx.effect(() => hideChatSessions(ctx), 'super-chat: hidden sessions')
  ctx.effect(() => () => store.close(), 'super-chat: store')
  ctx.effect(() => () => { tagger.stop() }, 'super-chat: auto-tagger')
  ctx.effect(() => () => { void wechat.stop() }, 'super-chat: wechat bridge')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/super-chat',
    handler: createApi({ store, transport, tagger, wechat, port: ctx.webServer.port!, host: ctx.webServer.host }),
  }), 'super-chat: http api')

  ctx.logger.info('dsh-super-chat ready: panel at /super-chat, state %s, workspace %s',
    join(options.stateDir, 'chat.sqlite'), options.cwd)
}

export type { ChatMessage, ChatView, Topic } from './protocol.ts'
