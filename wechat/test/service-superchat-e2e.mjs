// 端到端：真的把 service.mjs 拉起来，用 mock 微信 + mock super chat 验证接线。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock } from '../mock/server.mjs';
import { startSuperchatMock } from '../mock/superchat.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, ms = 8000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error('等待超时');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const wx = await startMock();
const sc = await startSuperchatMock();
const dir = await mkdtemp(join(tmpdir(), 'wx-service-'));
const credsPath = join(dir, 'creds.json');
const statePath = join(dir, 'state.json');
const port = await freePort();
await writeFile(credsPath, JSON.stringify({
  base: wx.url,
  syncBase: wx.url,
  cookie: '',
  uin: 1000,
  sid: 'MOCKSID',
  skey: 'MOCKSKEY',
  deviceid: 'MOCKDEV',
  passTicket: 'MOCK_PASS_TICKET',
}));

const child = spawn(process.execPath, ['src/service.mjs', '--creds', credsPath, '--port', String(port)], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    AGENT_MODE: 'superchat',
    SUPERCHAT_URL: sc.url,
    STATE_FILE: statePath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

try {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await response.json();
      return body.ok && body.mode === 'superchat';
    } catch { return false; }
  });

  await wx.inject({ from: '@me', to: 'filehelper', content: '服务测试' });
  await waitFor(() => sc.posts.length === 1);
  assert.equal(sc.posts[0].text, '服务测试');
  sc.injectAgent('服务收到。');
  await waitFor(() => wx.sent.some((item) => item.Msg.Content.includes('服务收到')));
  assert.match(wx.sent.at(-1).Msg.Content, /^🤖 服务收到/);

  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.superchat.initialized, true);
  console.log('✅ service superchat e2e ok');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  // 普通停服/重启不能登出微信，否则每次重启都要重新扫码。
  assert.equal(wx.logouts.length, 0);
  await sc.close();
  await wx.close();
  await rm(dir, { recursive: true, force: true });
  if (child.exitCode !== 0 && child.exitCode !== null) {
    console.error(output);
    throw new Error('service 退出码 ' + child.exitCode);
  }
}
