/** On-demand lifecycle for the optional WeChat bridge process. */
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_PORT = 8790
const START_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 3_000
const PROBE_TIMEOUT_MS = 1_000

const delay = (ms: number): Promise<void> => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })

const defaultProbe = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return response.ok
  } catch {
    return false
  }
}

export interface WechatBridgeOptions {
  /** Plugin state directory; bridge credentials and state live in its wechat/ subdirectory. */
  stateDir: string
  /** DSH Web port the bridge should talk to. */
  panelPort: number
  /** Package root containing the wechat/ directory; inferred from this module when omitted. */
  packageRoot?: string
  port?: number
  /** Test seams. */
  spawn?: typeof spawn
  probe?: (url: string) => Promise<boolean>
}

export type BridgeStart = 'running' | 'started'

/**
 * Starts the bridge when needed, reuses an already-running bridge (manual or from a previous plugin
 * instance), and stops only the process this manager spawned when requested. Credentials and state
 * live under stateDir so a plugin restart does not require another scan.
 */
export class WechatBridge {
  readonly port: number
  private readonly dir: string
  private readonly packageRoot: string
  private readonly spawnProcess: typeof spawn
  private readonly probe: (url: string) => Promise<boolean>
  private child?: ChildProcess
  private starting?: Promise<void>
  private keepTimer?: ReturnType<typeof setInterval>
  private stopped = false

  constructor(private readonly options: WechatBridgeOptions) {
    this.port = options.port ?? DEFAULT_PORT
    this.dir = join(options.stateDir, 'wechat')
    this.packageRoot = options.packageRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..')
    this.spawnProcess = options.spawn ?? spawn
    this.probe = options.probe ?? defaultProbe
  }

  /** Whether saved WeChat login credentials exist in the state directory or legacy checkout. */
  hasCredentials(): boolean {
    return existsSync(join(this.dir, 'creds.json')) || existsSync(join(this.packageRoot, 'wechat', 'creds.json'))
  }

  /** Ensure the bridge is ready; an already healthy bridge is reported as running. */
  async ensure(): Promise<BridgeStart> {
    if (await this.healthy()) return 'running'
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = undefined })
    await this.starting
    return 'started'
  }

  /**
   * Keep the bridge alive in the background while saved credentials exist, so profile restarts or
   * unexpected bridge exits do not drop WeChat access until the user clicks the panel entry again.
   */
  keepAlive(intervalMs = 15_000): () => void {
    this.stopped = false
    const check = (): void => {
      if (this.stopped || !this.hasCredentials()) return
      void this.ensure().catch(() => { /* retried on next tick or explicit panel action */ })
    }
    check()
    const timer = setInterval(check, intervalMs)
    timer.unref?.()
    this.keepTimer = timer
    return () => {
      this.stopped = true
      if (this.keepTimer === timer) this.keepTimer = undefined
      clearInterval(timer)
    }
  }

  /** Stop only the bridge process this manager started; an externally running bridge is reused, not killed. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.keepTimer) { clearInterval(this.keepTimer); this.keepTimer = undefined }
    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null) return
    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => { if (settled) return; settled = true; clearTimeout(timer); resolve() }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } finish() }, STOP_TIMEOUT_MS)
      child.once('exit', finish)
      try { child.kill('SIGTERM') } catch { finish() }
    })
  }

  /** Whether /health answers on the bridge port. */
  async healthy(): Promise<boolean> {
    return this.probe('http://127.0.0.1:' + this.port + '/health')
  }

  private async start(): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.copyLegacy()
    const script = join(this.packageRoot, 'wechat', 'src', 'service.mjs')
    if (!existsSync(script)) throw new Error('WeChat bridge not found at ' + script)
    const child = this.spawnProcess(process.execPath, [
      script, '--creds', join(this.dir, 'creds.json'), '--port', String(this.port),
    ], {
      cwd: join(this.packageRoot, 'wechat'),
      env: {
        ...process.env,
        AGENT_MODE: 'superchat',
        SUPERCHAT_URL: 'http://127.0.0.1:' + this.options.panelPort,
        SUPERCHAT_PATH: '/super-chat/api',
        SUPERCHAT_HEADER: 'x-super-chat-request',
        STATE_FILE: join(this.dir, 'state.json'),
        PORT: String(this.port),
      },
      detached: true,
      stdio: 'ignore',
    })
    child.unref?.()
    this.child = child
    child.once('exit', () => {
      if (this.child === child) this.child = undefined
      if (!this.stopped && this.hasCredentials()) {
        const timer = setTimeout(() => {
          if (!this.stopped && this.hasCredentials()) void this.ensure().catch(() => {})
        }, 1_000)
        timer.unref?.()
      }
    })
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.healthy()) return
      if (child.exitCode !== null) throw new Error('WeChat bridge exited before it was ready')
      await delay(200)
    }
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    throw new Error('WeChat bridge did not become ready')
  }

  /** Bring a scan from the old manual bridge (wechat/creds.json) into the plugin state directory once. */
  private copyLegacy(): void {
    for (const name of ['creds.json', 'state.json']) {
      const from = join(this.packageRoot, 'wechat', name)
      const to = join(this.dir, name)
      if (!existsSync(from) || existsSync(to)) continue
      try { copyFileSync(from, to); chmodSync(to, 0o600) } catch { /* keep the old file in place */ }
    }
  }
}
