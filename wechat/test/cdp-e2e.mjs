import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { startMock } from '../mock/server.mjs';
import { attach, findPage } from '../src/cdp.mjs';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(100);
  }
  throw new Error('等待超时');
}

const mock = await startMock();
const debugPort = 9300 + Math.floor(Math.random() * 300);
const profile = '/tmp/wxcdp-' + process.pid + '-' + Date.now();

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + debugPort,
    mock.url + '/mock',
  ],
  { stdio: 'ignore' }
);

try {
  await waitFor(() => findPage({ port: debugPort, urlIncludes: mock.port + '/mock' }));

  const hook = await attach({
    port: debugPort,
    urlIncludes: String(mock.port) + '/mock',
    reload: true,
    appId: 'wx_webfilehelper',
    log: () => {},
  });
  await Promise.race([
    hook.ready,
    sleep(8000).then(() => {
      throw new Error('抓不到 webwxinit');
    }),
  ]);

  const got = [];
  hook.onMessage((m) => got.push(m));
  await mock.inject({ from: '@me', to: 'filehelper', content: '来自手机的消息' });
  await waitFor(() => got.length === 1);
  assert.equal(got[0].text, '来自手机的消息');
  assert.equal(got[0].to, 'filehelper');

  await hook.sendText('filehelper', '来自 agent 的回复');
  await waitFor(() => mock.sent.length === 1);
  assert.equal(mock.sent[0].Msg.Content, '来自 agent 的回复');
  assert.equal(mock.sent[0].Msg.ToUserName, 'filehelper');
  assert.equal(mock.sent[0].Scene, 0);

  hook.close();
  console.log('✅ cdp e2e ok');
} finally {
  chrome.kill('SIGKILL');
  await sleep(200);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await mock.close();
}
