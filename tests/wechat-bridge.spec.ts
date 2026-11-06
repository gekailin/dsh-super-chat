import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WechatBridge } from '../src/wechat-bridge.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const packageRoot = mkdtempSync(join(tmpdir(), 'super-chat-wechat-pkg-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'super-chat-wechat-state-'))
  dirs.push(packageRoot, stateDir)
  mkdirSync(join(packageRoot, 'wechat', 'src'), { recursive: true })
  writeFileSync(join(packageRoot, 'wechat', 'src', 'service.mjs'), '// stub')
  return { packageRoot, stateDir }
}

function fakeChild() {
  let exit: (() => void) | undefined
  const child = {
    exitCode: null as number | null,
    kill: vi.fn((signal?: string) => { child.exitCode = signal === 'SIGKILL' ? 1 : 0; exit?.(); return true }),
    once: vi.fn((_event: string, listener: () => void) => { exit = listener; return child }),
  }
  return child as unknown as ChildProcess & typeof child
}

describe('WechatBridge', () => {
  it('starts on demand with the panel URL and stops its own child', async () => {
    const { packageRoot, stateDir } = fixture()
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const bridge = new WechatBridge({ stateDir, panelPort: 3099, packageRoot, port: 9876, spawn: spawn as never, probe })
    expect(await bridge.ensure()).toBe('started')
    expect(spawn).toHaveBeenCalledTimes(1)
    const [, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }]
    expect(args).toContain('--port')
    expect(options.env).toMatchObject({
      AGENT_MODE: 'superchat',
      SUPERCHAT_URL: 'http://127.0.0.1:3099',
      SUPERCHAT_PATH: '/super-chat/api',
      SUPERCHAT_HEADER: 'x-super-chat-request',
      STATE_FILE: join(stateDir, 'wechat', 'state.json'),
    })
    expect(await bridge.ensure()).toBe('running')
    expect(spawn).toHaveBeenCalledTimes(1)
    await bridge.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('reuses an already running bridge without spawning or stopping it', async () => {
    const { packageRoot, stateDir } = fixture()
    const spawn = vi.fn()
    const bridge = new WechatBridge({ stateDir, panelPort: 3099, packageRoot, port: 9876, spawn: spawn as never, probe: async () => true })
    expect(await bridge.ensure()).toBe('running')
    expect(spawn).not.toHaveBeenCalled()
    await bridge.stop()
  })

  it('imports legacy credentials and reports a missing bridge checkout', async () => {
    const { packageRoot, stateDir } = fixture()
    writeFileSync(join(packageRoot, 'wechat', 'creds.json'), '{"cookie":"legacy"}')
    const child = fakeChild()
    const bridge = new WechatBridge({ stateDir, panelPort: 3099, packageRoot, port: 9876,
      spawn: (() => child) as never, probe: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true) })
    await bridge.ensure()
    expect(existsSync(join(stateDir, 'wechat', 'creds.json'))).toBe(true)
    await bridge.stop()

    const emptyRoot = mkdtempSync(join(tmpdir(), 'super-chat-wechat-missing-'))
    dirs.push(emptyRoot)
    const missing = new WechatBridge({ stateDir, panelPort: 3099, packageRoot: emptyRoot, port: 9876, spawn: (() => child) as never, probe: async () => false })
    await expect(missing.ensure()).rejects.toThrow('WeChat bridge not found')
  })

  it('keeps the bridge alive only when saved credentials exist and restarts after unexpected exit', async () => {
    const { packageRoot, stateDir } = fixture()
    let healthy = false
    const children: ReturnType<typeof fakeChild>[] = []
    const spawn = vi.fn(() => {
      const child = fakeChild()
      healthy = true
      children.push(child)
      return child
    })
    const probe = vi.fn(async () => healthy)
    const bridge = new WechatBridge({ stateDir, panelPort: 3099, packageRoot, port: 9876, spawn: spawn as never, probe })

    // Without credentials, keepAlive remains idle so a fresh install does not spawn the bridge at boot.
    let dispose = bridge.keepAlive(30)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(spawn).not.toHaveBeenCalled()
    dispose()

    // Once credentials exist, keepAlive starts the bridge and recovers it if it exits unexpectedly.
    mkdirSync(join(stateDir, 'wechat'), { recursive: true })
    writeFileSync(join(stateDir, 'wechat', 'creds.json'), '{"uin":1000,"sid":"SID","passTicket":"TICKET"}')
    dispose = bridge.keepAlive(30)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))

    // Simulate an unexpected crash of the bridge process.
    healthy = false
    children[0]!.kill('SIGTERM')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))

    dispose()
    await bridge.stop()
  })
})
