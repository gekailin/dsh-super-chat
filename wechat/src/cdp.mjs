#!/usr/bin/env node
// Chrome 端 hook（不装扩展）：用 CDP 挂到已登录的网页版微信，
// 抓 webwxinit / webwxsync 的响应，并在页面上下文里发 webwxsendmsg。
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { normalize, UA } from './wxweb.mjs';
import { echoAgent, openaiAgent } from './agents.mjs';
import { Bridge } from './bridge.mjs';

export class Cdp extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) {
        this.emit(msg.method, msg.params);
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('连接 ' + wsUrl + ' 失败')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

export async function findPage({ port = 9222, urlIncludes = 'wx.qq.com' } = {}) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list');
  const list = await res.json();
  return (
    list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://') && t.url.includes(urlIncludes)) || null
  );
}

export async function attach({ port = 9222, urlIncludes = 'wx.qq.com', reload = false, appId = '', log = () => {} } = {}) {
  const page = await findPage({ port, urlIncludes });
  if (!page) throw new Error('没找到匹配的页面（' + urlIncludes + '），确认 Chrome 带 --remote-debugging-port 启动且已打开该页');

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  const state = { passTicket: null, baseRequest: null, self: null, syncKey: null };
  const handlers = [];
  const kinds = new Map();
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  cdp.on('Network.requestWillBeSent', (p) => {
    const u = p.request.url;
    if (u.includes('/webwxinit')) {
      const pt = new URL(u).searchParams.get('pass_ticket');
      if (pt) state.passTicket = pt;
      try {
        state.baseRequest = JSON.parse(p.request.postData || '{}').BaseRequest;
      } catch {}
      kinds.set(p.requestId, 'init');
    } else if (u.includes('/webwxsync')) {
      kinds.set(p.requestId, 'sync');
    }
  });

  cdp.on('Network.loadingFinished', async (p) => {
    const kind = kinds.get(p.requestId);
    if (!kind) return;
    kinds.delete(p.requestId);
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      const json = JSON.parse(text);
      if (kind === 'init') {
        state.self = json.User;
        state.syncKey = json.SyncKey;
        // init 请求里的 Skey 常为空，响应里的 SKey 才是后续签名用的
        if (json.SKey && state.baseRequest) state.baseRequest.Skey = json.SKey;
        log('身份: ' + state.self.NickName);
        resolveReady(state);
      } else {
        for (const raw of json.AddMsgList || []) {
          const m = normalize(raw);
          for (const h of handlers) h(m);
        }
      }
    } catch (e) {
      log('读取响应失败: ' + e.message);
    }
  });

  await cdp.send('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024 });
  await cdp.send('Page.enable');
  if (reload) await cdp.send('Page.reload', { ignoreCache: false });

  return {
    cdp,
    state,
    ready,
    onMessage(fn) {
      handlers.push(fn);
    },
    async sendText(to, content) {
      if (!state.self || !state.baseRequest || !state.passTicket) {
        throw new Error('还没抓到登录态：给页面刷新一次，或加 --reload');
      }
      const id = String(Date.now()) + String(Math.floor(Math.random() * 1e4)).padStart(4, '0');
      const body = {
        BaseRequest: state.baseRequest,
        Msg: {
          Type: 1,
          Content: content,
          FromUserName: state.self.UserName,
          ToUserName: to,
          LocalID: id,
          ClientMsgId: id,
        },
      };
      if (appId) body.Scene = 0;
      const payload = JSON.stringify(body);
      const url =
        '/cgi-bin/mmwebwx-bin/webwxsendmsg?lang=zh_CN&pass_ticket=' + encodeURIComponent(state.passTicket);
      const headers = { 'Content-Type': 'application/json;charset=UTF-8' };
      if (appId) headers.mmweb_appid = appId;
      const expr = '(async()=>{const r=await fetch(' + JSON.stringify(url) + ',{method:"POST",credentials:"include",headers:' + JSON.stringify(headers) + ',body:' + JSON.stringify(payload) + '});return await r.text()})()';
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面内发送失败');
      const j = JSON.parse(r.result.value);
      if (j?.BaseResponse?.Ret !== 0) throw new Error('发送失败 Ret=' + j?.BaseResponse?.Ret);
      return j.MsgID;
    },
    close() {
      cdp.close();
    },
  };
}

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const hook = await attach({
    port: Number(args.port || 9222),
    urlIncludes: args.match || 'wx.qq.com',
    reload: Boolean(args.reload),
    appId: args.appid || (String(args.match || '').includes('filehelper') ? 'wx_webfilehelper' : ''),
    log: (m) => console.log('[cdp]', m),
  });
  await hook.ready;
  const agent = process.env.AGENT_API_KEY ? openaiAgent() : echoAgent;
  const bridge = new Bridge({
    client: { sendText: (to, text) => hook.sendText(to, text) },
    agent,
    peer: args.peer || 'filehelper',
    log: console.log,
  });
  hook.onMessage((m) => bridge.submit(m));
  console.log('已挂载，监听 ' + bridge.peer + '（Ctrl-C 退出）');
  await new Promise(() => {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
