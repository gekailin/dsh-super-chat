import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock } from '../mock/server.mjs';
import { startSuperchatMock } from '../mock/superchat.mjs';
import { WebWxClient } from '../src/wxweb.mjs';
import { Bridge } from '../src/bridge.mjs';
import { State } from '../src/state.mjs';
import { SuperchatClient } from '../src/superchat.mjs';
import { Outbound } from '../src/outbound.mjs';
import { Poller } from '../src/poller.mjs';
import { SuperchatAgent } from '../src/superchat-agent.mjs';
import { extractTags } from '../src/tags.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, ms = 5000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('等待超时');
}

assert.deepEqual(extractTags('帮我看下 @设计 这个页面'), { text: '帮我看下 这个页面', tags: ['设计'] });
assert.deepEqual(extractTags('帮我看下，@设计 这个页面'), { text: '帮我看下， 这个页面', tags: ['设计'] });
assert.deepEqual(extractTags('@设计 @紧急 两个标签'), { text: '两个标签', tags: ['设计', '紧急'] });
assert.deepEqual(extractTags('邮箱 a@b.com 不是标签'), { text: '邮箱 a@b.com 不是标签', tags: [] });

const wx = await startMock();
let sc = await startSuperchatMock();
const dir = await mkdtemp(join(tmpdir(), 'wx-superchat-'));
const statePath = join(dir, 'state.json');
const state = await State.load(statePath);
const client = new WebWxClient({
  base: wx.url,
  syncBase: wx.url,
  cookie: '',
  uin: 1000,
  sid: 'MOCKSID',
  skey: 'MOCKSKEY',
  deviceid: 'MOCKDEV',
  passTicket: 'MOCK_PASS_TICKET',
}, { log: () => {} });
await client.init();
const chat = new SuperchatClient({ base: sc.url, log: () => {} });
const outbound = new Outbound({ send: (text) => client.sendText('filehelper', text), log: () => {}, gapMs: 0 });
const poller = new Poller({ superchat: chat, outbound, state, peerId: 'filehelper', log: () => {}, pollMs: 20 });
const agent = new SuperchatAgent({ client: chat, state, peerId: 'filehelper', poller, log: () => {} });
const bridge = new Bridge({
  client,
  agent,
  peer: 'filehelper',
  send: (text) => outbound.enqueue(text),
  seen: {
    has: (id) => state.isSeen('filehelper', id),
    add: async (id) => { state.markSeen('filehelper', id); await state.save(); },
  },
  log: () => {},
});
const ac = new AbortController();
client.run({ signal: ac.signal, onMessage: (m) => bridge.submit(m) });
poller.start();

const contents = () => wx.sent.map((item) => item.Msg.Content);

try {
  // 1) 默认通用聊天；普通文本直接发送。
  await wx.inject({ from: '@me', to: 'filehelper', content: '你好' });
  await waitFor(() => sc.posts.length === 1);
  assert.equal(sc.posts[0].text, '你好');
  assert.deepEqual(sc.posts[0].tags, []);
  assert.equal(sc.posts[0].via, 'wechat');
  assert.equal(wx.sent.length, 0, '普通消息不应立刻回复');

  // 2) agent 回复进入通用聊天，再转发微信。
  sc.injectAgent('你好，我是 Superagent。');
  await waitFor(() => wx.sent.length === 1);
  assert.match(contents()[0], /^🤖 你好/);

  // 3) 自然语言 @主题：消息打标、正文保留。
  await wx.inject({ from: '@me', to: 'filehelper', content: '帮我看下 @设计 这个页面' });
  await waitFor(() => sc.posts.length === 2);
  assert.equal(sc.posts[1].text, '帮我看下 这个页面');
  assert.deepEqual(sc.posts[1].tags, ['设计']);
  assert.ok(sc.topics.some((topic) => topic.name === '设计'));

  // 4) 多重标签；agent 带标签的回复在微信里显示主题前缀。
  await wx.inject({ from: '@me', to: 'filehelper', content: '@设计 @紧急 两个标签' });
  await waitFor(() => sc.posts.length === 3);
  assert.deepEqual(sc.posts[2].tags, ['设计', '紧急']);
  sc.injectAgent('收到，分到设计和紧急。', ['设计', '紧急']);
  await waitFor(() => contents().some((text) => text.includes('「设计、紧急」')));
  assert.ok(contents().some((text) => text.includes('收到，分到设计和紧急。')));

  // 5) 命令系统已移除：/list 作为自然语言文本发送。
  await wx.inject({ from: '@me', to: 'filehelper', content: '/list' });
  await waitFor(() => sc.posts.some((post) => post.text === '/list'));
  assert.ok(!contents().some((text) => text.includes('对话（')), '不再有 /list 命令回复');

  // 6) 自己发出的消息回显不触发二次发送。
  const before = wx.sent.length;
  const ownId = [...client.sentIds].at(-1);
  await wx.inject({ from: '@me', to: 'filehelper', content: '回显', msgId: ownId });
  await sleep(300);
  assert.equal(wx.sent.length, before, '回显不应触发发送');

  // 7) 状态持久化：单流游标还在。
  await state.save();
  const reloaded = await State.load(statePath);
  assert.equal(reloaded.peer('filehelper').initialized, true);
  assert.ok(reloaded.peer('filehelper').lastDeliveredId);

  // 8) 暂存：Super Chat 不可达时消息进 outbox，恢复后带标签补发。
  await sc.close();
  await wx.inject({ from: '@me', to: 'filehelper', content: '离线消息 @设计' });
  await waitFor(() => contents().some((text) => text.includes('已暂存')));
  assert.equal(state.peer('filehelper').outbox.length, 1);
  assert.deepEqual(state.peer('filehelper').outbox[0].tags, ['设计']);
  sc = await startSuperchatMock();
  chat.base = sc.url;
  await waitFor(() => sc.posts.some((post) => post.text === '离线消息' && post.tags.includes('设计')), 15000);
  await waitFor(() => state.peer('filehelper').outbox.length === 0);

  ac.abort();
  poller.stop();
  console.log('✅ superchat e2e ok');
} finally {
  ac.abort();
  poller.stop();
  await sc.close();
  await wx.close();
  await rm(dir, { recursive: true, force: true });
}
