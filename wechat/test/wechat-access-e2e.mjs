// 端到端：面板用的微信接入接口。无 creds 启动 → 未登录；mock 扫码 → 已登录；登出 → 未登录并删掉 creds。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock } from '../mock/server.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, ms = 12000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await fn()) return;
    await sleep(100);
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
const dir = await mkdtemp(join(tmpdir(), 'wx-access-'));
const credsPath = join(dir, 'creds.json');
const statePath = join(dir, 'state.json');
const port = await freePort();
const origin = 'http://127.0.0.1:3080';
const baseUrl = 'http://127.0.0.1:' + port;

const child = spawn(process.execPath, ['src/service.mjs', '--creds', credsPath, '--port', String(port)], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    WX_BASE: wx.url,
    WX_LOGIN_BASE: wx.url,
    STATE_FILE: statePath,
    AGENT_MODE: 'llm',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

const call = async (path, init = {}) => {
  const headers = {
    origin,
    ...(init.method === 'POST' ? { 'x-super-chat-request': '1' } : {}),
    ...init.headers,
  };
  const response = await fetch(baseUrl + path, { ...init, headers });
  return { response, body: await response.json() };
};

try {
  await waitFor(async () => {
    try {
      const { body } = await call('/health');
      return body.ok === true;
    } catch {
      return false;
    }
  });

  // 没有 creds 时服务也要能起来，面板先看到未登录。
  const initial = await call('/wechat/status');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.response.headers.get('access-control-allow-origin'), origin);
  assert.equal(initial.body.loggedIn, false);
  assert.equal(initial.body.login.phase, 'idle');

  // 扫码登录：二维码以 data URL 返回，后台轮询 mock 的 201/200 后自动建立会话。
  const started = await call('/wechat/login', { method: 'POST' });
  assert.equal(started.response.status, 200);
  assert.match(started.body.login.qr, /^data:image\/jpeg;base64,/);
  assert.ok(['waiting', 'scanned', 'starting', 'success'].includes(started.body.login.phase));

  await waitFor(async () => (await call('/wechat/status')).body.loggedIn === true);
  const loggedIn = (await call('/wechat/status')).body;
  assert.equal(loggedIn.nick, 'tester');
  assert.equal(loggedIn.login.phase, 'success');
  assert.equal(loggedIn.login.qr, undefined);
  const health = (await call('/health')).body;
  assert.equal(health.wechat.nick, 'tester');
  assert.match(health.agent, /echo/);
  await stat(credsPath);

  // 已登录时再点登录不会另起二维码。
  const again = await call('/wechat/login', { method: 'POST' });
  assert.equal(again.body.loggedIn, true);

  // 登出：先通知微信服务器（webwxlogout），再停会话、删 creds、拒绝 /send。
  assert.equal(wx.logouts.length, 0);
  const loggedOut = await call('/wechat/logout', { method: 'POST' });
  assert.equal(loggedOut.body.loggedIn, false);
  assert.equal(loggedOut.body.login.phase, 'idle');
  assert.equal(loggedOut.body.login.message, '已退出登录');
  assert.equal(wx.logouts.length, 1);
  assert.deepEqual(wx.logouts[0].body, { sid: 'MOCKSID', uin: 1000 });
  assert.equal(wx.logouts[0].query.skey, 'MOCKSKEY');
  assert.equal(wx.logouts[0].query.type, '0');
  assert.equal(wx.logouts[0].appId, 'wx_webfilehelper');
  await assert.rejects(stat(credsPath));
  const send = await call('/send', { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
  assert.equal(send.response.status, 503);

  // 跨站/非白名单 Origin 与缺少请求头的 POST 均被拒绝。
  const badOrigin = await fetch(baseUrl + '/wechat/status', { headers: { origin: 'http://127.0.0.1:9999' } });
  assert.equal(badOrigin.status, 403);
  const missingHeader = await fetch(baseUrl + '/wechat/login', { method: 'POST', headers: { origin } });
  assert.equal(missingHeader.status, 403);

  console.log('✅ wechat access e2e ok');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await wx.close();
  await rm(dir, { recursive: true, force: true });
  if (child.exitCode !== 0 && child.exitCode !== null) {
    console.error(output);
    throw new Error('service 退出码 ' + child.exitCode);
  }
}
