import assert from 'node:assert/strict';
import { startMock } from '../mock/server.mjs';
import { WebWxClient } from '../src/wxweb.mjs';
import { Bridge } from '../src/bridge.mjs';
import { echoAgent } from '../src/agents.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error('等待超时');
}

const mock = await startMock();
const base = mock.url;
const client = new WebWxClient(
  {
    base,
    syncBase: base,
    cookie: '',
    uin: 1000,
    sid: 'MOCKSID',
    skey: 'MOCKSKEY',
    deviceid: 'MOCKDEV',
    passTicket: 'MOCK_PASS_TICKET',
  },
  { log: () => {} }
);
await client.init();

const bridge = new Bridge({ client, agent: echoAgent });
const ac = new AbortController();
client.run({ signal: ac.signal, onMessage: (m) => bridge.submit(m) });

// 状态通知（type=51）应被静默忽略，不触发回复
await mock.inject({ from: '@me', to: 'filehelper', type: 51, content: '<statusnotify></statusnotify>' });
await new Promise((r) => setTimeout(r, 250));
assert.equal(mock.sent.length, 0);

// 手机上发给文件传输助手的消息：from 是自己，to 是 filehelper
await mock.inject({ from: '@me', to: 'filehelper', content: '你好 agent' });
await waitFor(() => mock.sent.length === 1);
assert.equal(mock.sent[0].Msg.ToUserName, 'filehelper');
assert.equal(mock.sent[0].Msg.Content, '收到：你好 agent');
assert.equal(mock.sent[0].Msg.FromUserName, '@me');
assert.equal(mock.sent[0].Scene, 0);

// 自己刚发出的那条被同步回来时，必须靠 MsgID 排掉，不能形成回环
const ownId = [...client.sentIds][0];
assert.ok(ownId, '回复的 MsgID 应被记录');
await mock.inject({ from: '@me', to: 'filehelper', content: '收到：你好 agent', msgId: ownId });
await sleep(600);
assert.equal(mock.sent.length, 1, '不应产生二次回复');

ac.abort();
await mock.close();
console.log('✅ e2e ok');
