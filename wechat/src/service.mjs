#!/usr/bin/env node
// 常驻服务：文件传输助手 ⇄ agent，带健康检查、手动发送和微信登录管理接口。
// 环境变量：
//   AGENT_MODE=llm|superchat   llm: 直连模型；superchat: 接入 dsh-super-chat 面板
//   SUPERCHAT_URL              superchat 模式下 Super Chat 面板 API 地址（默认 http://127.0.0.1:3080）
//   SUPERCHAT_PATH / SUPERCHAT_HEADER  面板 API 路径与请求头（默认 /super-chat/api、x-super-chat-request）
//   STATE_FILE                 superchat 模式的状态文件（默认 state.json）
//   AIGC_APPID / AIGC_MODEL / AIGC_BASE   → llm 模式走以 app id 授权的 OpenAI 兼容网关
//   AGENT_API_KEY / AGENT_MODEL / AGENT_API_BASE → llm 模式走通用 OpenAI 兼容
//   WX_BASE / WX_LOGIN_BASE / WX_APPID     → 覆盖微信后端地址（测试 mock 用）
//   CREDS / PORT（默认 8790）/ AGENT_SYSTEM
import http from 'node:http';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { beginLogin } from './login.mjs';
import {
  FILEHELPER_APPID,
  FILEHELPER_BASE,
  FILEHELPER_LOGIN,
} from './wxweb.mjs';
import { State } from './state.mjs';
import { WechatSession } from './session.mjs';

const args = parseArgs(process.argv.slice(2));
const credsPath = args.creds || process.env.CREDS || 'creds.json';
const port = Number(args.port || process.env.PORT || 8790);
const peer = args.peer || 'filehelper';
const mode = process.env.AGENT_MODE || 'llm';
const statePath = process.env.STATE_FILE || 'state.json';
const superchatUrl = process.env.SUPERCHAT_URL || 'http://127.0.0.1:3080';
const superchatPath = process.env.SUPERCHAT_PATH || '/super-chat/api';
const superchatHeader = process.env.SUPERCHAT_HEADER || 'x-super-chat-request';
const loginBase = process.env.WX_LOGIN_BASE || FILEHELPER_LOGIN;
const base = process.env.WX_BASE || FILEHELPER_BASE;
const appId = process.env.WX_APPID || FILEHELPER_APPID;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    out[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return out;
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 面板在 DSH Web 端口（默认 3080），桥在 127.0.0.1:8790；只对本机页面开放跨域。 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

const health = {
  startedAt: Date.now(),
  lastError: null,
};

let state = null;
let session = null;
let loginNonce = 0;
const login = { phase: 'idle', message: '', qr: null, startedAt: null };

function statusView() {
  const current = session?.status() ?? { loggedIn: false };
  return {
    ok: true,
    ...current,
    loggedIn: !!session,
    login: {
      phase: login.phase,
      ...(login.message ? { message: login.message } : {}),
      ...(login.qr ? { qr: login.qr } : {}),
    },
  };
}

function healthView() {
  return {
    ok: true,
    mode,
    agent: session?.agent?.name ?? (mode === 'superchat' ? 'superchat:未登录' : '未登录'),
    wechat: session ? { nick: session.self?.NickName, user: session.self?.UserName } : null,
    peer,
    messages: session?.messageCount ?? 0,
    lastMessageAt: session?.lastMessageAt ?? null,
    lastError: session?.lastError ?? health.lastError,
    uptimeSec: Math.round((Date.now() - health.startedAt) / 1000),
    login: { phase: login.phase, message: login.message },
    ...(mode === 'superchat'
      ? {
          superchat: {
            url: superchatUrl,
            path: superchatPath,
            ...(session?.poller?.status() ?? { initialized: false, pendingOutbox: 0, lastError: null }),
          },
        }
      : {}),
  };
}

async function readCreds() {
  try {
    return JSON.parse(await readFile(credsPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') log('读取 creds 失败: ' + e.message);
    return null;
  }
}

async function clearCreds() {
  await rm(credsPath, { force: true }).catch((e) => log('删除 creds 失败: ' + e.message));
}

async function stopSession({ notify = false } = {}) {
  const current = session;
  session = null;
  if (!current) return { notified: null };
  try {
    return (await current.stop({ notify })) ?? { notified: null };
  } catch (e) {
    log('停止会话失败: ' + e.message);
    return { notified: notify ? false : null };
  }
}

async function startSession(creds) {
  await stopSession();
  const next = new WechatSession({
    creds,
    peer,
    mode,
    superchatUrl,
    superchatPath,
    superchatHeader,
    state,
    log,
    onClosed: (e) => {
      void sessionClosed(next, e);
    },
  });
  await next.start();
  session = next;
  health.lastError = null;
  log('微信已登录: ' + next.self?.NickName + ' | agent: ' + next.agent?.name + ' | 会话: ' + peer);
  return next;
}

/** 手机退出/在别处登录：清掉失效的 creds，面板回到未登录，可重新扫码。 */
async function sessionClosed(closed, error) {
  if (session !== closed) return;
  log('微信会话结束: ' + error.message);
  await stopSession();
  await clearCreds();
  login.phase = 'idle';
  login.message = error.message;
  login.qr = null;
}

/**
 * 开始一次扫码登录。二维码以 data URL 返回给面板，轮询在后台继续；
 * 登录成功后写 creds、建会话；已有会话时直接返回已登录状态。
 */
async function startLogin() {
  if (session) return statusView();
  if (['connecting', 'waiting', 'scanned', 'starting'].includes(login.phase)) return statusView();

  const nonce = ++loginNonce;
  login.phase = 'connecting';
  login.message = '正在获取二维码…';
  login.qr = null;
  login.startedAt = new Date().toISOString();

  let flow;
  try {
    flow = await beginLogin({
      loginBase,
      base,
      appId,
      onStatus: (text, phase) => {
        if (nonce !== loginNonce) return;
        if (phase) login.phase = phase;
        login.message = text;
      },
    });
  } catch (e) {
    if (nonce === loginNonce) {
      login.phase = 'error';
      login.message = e.message;
    }
    return statusView();
  }
  if (nonce !== loginNonce) return statusView();

  login.qr = 'data:image/jpeg;base64,' + flow.qr.toString('base64');
  const initial = flow.status();
  login.phase = initial.phase;
  login.message = initial.message;

  flow.done
    .then(async ({ creds, user }) => {
      if (nonce !== loginNonce) return;
      login.phase = 'starting';
      login.message = '登录成功，正在连接…';
      await writeFile(credsPath, JSON.stringify(creds, null, 2) + '\n');
      try {
        await startSession(creds);
        if (nonce !== loginNonce) return;
        login.phase = 'success';
        login.message = '已登录: ' + user.NickName;
        login.qr = null;
        log('扫码登录成功: ' + user.NickName);
      } catch (e) {
        if (nonce !== loginNonce) return;
        login.phase = 'error';
        login.message = '连接失败: ' + e.message;
        login.qr = null;
        health.lastError = e.message;
      }
    })
    .catch((e) => {
      if (nonce !== loginNonce) return;
      login.phase = 'error';
      login.message = e.message;
      login.qr = null;
    });

  return statusView();
}

async function logout() {
  loginNonce += 1;
  const stopped = await stopSession({ notify: true });
  await clearCreds();
  login.phase = 'idle';
  login.message = stopped.notified === false
    ? '已退出登录，但未能通知微信服务器（手机可能仍显示连接）'
    : '已退出登录';
  login.qr = null;
  login.startedAt = null;
  health.lastError = null;
  log('微信已退出登录' + (stopped.notified === false ? '（服务器未确认）' : ''));
  return statusView();
}

if (mode === 'superchat') {
  state = await State.load(statePath, log);
  log('Super Chat 模式: ' + superchatUrl + superchatPath + ' | state: ' + statePath);
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, healthView());
    if (req.method === 'GET' && url.pathname === '/wechat/status') return json(res, statusView());
    if (req.method === 'POST' && url.pathname === '/wechat/login') return json(res, await startLogin());
    if (req.method === 'POST' && url.pathname === '/wechat/logout') return json(res, await logout());
    if (req.method === 'POST' && url.pathname === '/send') {
      if (!session) return json(res, { error: '微信未登录' }, 503);
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.text) return json(res, { error: 'missing text' }, 400);
      const msgId = await session.client.sendText(body.to || peer, body.text);
      return json(res, { ok: true, msgId });
    }
    return json(res, { error: 'not found' }, 404);
  } catch (e) {
    return json(res, { error: e.message }, 500);
  }
});

await new Promise((r) => server.listen(port, '127.0.0.1', r));
log('HTTP 监听 127.0.0.1:' + port + '（/health, /wechat/status, /wechat/login, /wechat/logout, POST /send）');

const initial = await readCreds();
if (initial) {
  try {
    await startSession(initial);
  } catch (e) {
    health.lastError = e.message;
    log('自动登录失败，等待扫码: ' + e.message);
    login.phase = 'idle';
    login.message = '上次登录已失效: ' + e.message;
  }
} else {
  log('没有 creds，等待扫码登录');
}

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  log('收到 ' + sig + '，退出');
  await stopSession();
  server.close();
  if (state) await state.save().catch(() => {});
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
