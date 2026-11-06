// 一个已登录的微信会话：持有 WebWxClient、收消息长轮询、super chat 轮询和发送队列。
// 登录/登出由 service.mjs 控制；会话可以整体 stop 后再用新 creds 重建，
// 这样面板能在不重启进程的情况下扫码登录或退出。
import { WebWxClient } from './wxweb.mjs';
import { Bridge } from './bridge.mjs';
import { buildAgent } from './agents.mjs';
import { SuperchatClient } from './superchat.mjs';
import { Outbound } from './outbound.mjs';
import { Poller } from './poller.mjs';
import { SuperchatAgent } from './superchat-agent.mjs';

export class WechatSession {
  constructor({
    creds,
    peer = 'filehelper',
    mode = 'llm',
    superchatUrl = 'http://127.0.0.1:3080',
    superchatPath = '/super-chat/api',
    superchatHeader = 'x-super-chat-request',
    state = null,
    log = () => {},
    onClosed = () => {},
  }) {
    this.creds = creds;
    this.peer = peer;
    this.mode = mode;
    this.superchatUrl = superchatUrl;
    this.superchatPath = superchatPath;
    this.superchatHeader = superchatHeader;
    this.state = state;
    this.log = log;
    this.onClosed = onClosed;
    this.client = null;
    this.self = null;
    this.agent = null;
    this.bridge = null;
    this.poller = null;
    this.outbound = null;
    this.startedAt = null;
    this.lastError = null;
    this.abort = null;
    this.closed = false;
    this.stopping = false;
    this.messageCount = 0;
    this.lastMessageAt = null;
    this.lastUnsupportedAt = 0;
  }

  async start() {
    this.client = new WebWxClient(this.creds, { log: (m) => this.log('[wx]', m) });
    const init = await this.client.init();
    this.self = init.User;
    this.startedAt = new Date().toISOString();
    this.abort = new AbortController();
    this.outbound = new Outbound({ send: (text) => this.client.sendText(this.peer, text), log: this.log });

    if (this.mode === 'superchat') {
      const chat = new SuperchatClient({ base: this.superchatUrl, path: this.superchatPath, header: this.superchatHeader, log: this.log });
      this.poller = new Poller({
        superchat: chat,
        outbound: this.outbound,
        state: this.state,
        peerId: this.peer,
        log: this.log,
      });
      this.agent = new SuperchatAgent({
        client: chat,
        state: this.state,
        peerId: this.peer,
        poller: this.poller,
        log: this.log,
      });
      this.bridge = new Bridge({
        client: this.client,
        agent: this.agent,
        peer: this.peer,
        log: this.log,
        send: (text) => this.outbound.enqueue(text),
        seen: {
          has: (id) => this.state.isSeen(this.peer, id),
          add: async (id) => {
            this.state.markSeen(this.peer, id);
            await this.state.save();
          },
        },
        onUnsupported: async () => {
          if (Date.now() - (this.lastUnsupportedAt ?? 0) < 60_000) return;
          this.lastUnsupportedAt = Date.now();
          await this.outbound.enqueue('暂不支持图片/文件/语音，目前只能处理文本。');
        },
      });
    } else {
      // llm / echo：保持原来的同步 agent 行为；模型出错时给用户一句提示（30 秒内最多一次，避免刷屏）。
      const rawAgent = buildAgent();
      const log = this.log;
      let lastErrAt = 0;
      this.agent = {
        name: rawAgent.name,
        async reply(ctx) {
          try {
            return await rawAgent.reply(ctx);
          } catch (e) {
            log('agent error:', e.message);
            if (Date.now() - lastErrAt > 30_000) {
              lastErrAt = Date.now();
              return '⚠️ 模型调用失败：' + String(e.message).slice(0, 120);
            }
            return null;
          }
        },
      };
      this.bridge = new Bridge({ client: this.client, agent: this.agent, peer: this.peer, log: this.log });
    }

    this.poller?.start();
    this.client
      .run({
        signal: this.abort.signal,
        onMessage: (message) => {
          this.messageCount += 1;
          this.lastMessageAt = new Date().toISOString();
          this.bridge.submit(message);
        },
        onError: (e) => {
          this.lastError = e.message;
          this.log('[sync]', e.message);
        },
      })
      .catch((e) => {
        if (this.abort.signal.aborted || this.stopping) return;
        // 1100/1101：手机退出或在别处登录。会话已经不可用，交给 service 清 creds 并显示未登录。
        this.closed = true;
        this.lastError = e.message;
        this.poller?.stop();
        this.log('[sync] 会话结束:', e.message);
        this.onClosed?.(e);
      });
    return this;
  }

  status() {
    if (!this.client || this.closed) return { loggedIn: false, ...(this.lastError ? { error: this.lastError } : {}) };
    return {
      loggedIn: true,
      nick: this.self?.NickName,
      user: this.self?.UserName,
      since: this.startedAt,
      peer: this.peer,
      mode: this.mode,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /** Stop the session. `notify` signs out on the WeChat server too; restarts and shutdowns keep the login. */
  async stop({ notify = false } = {}) {
    this.stopping = true;
    let notified = null;
    if (notify && this.client) notified = await this.client.logout();
    this.abort?.abort();
    this.poller?.stop();
    this.closed = true;
    if (this.state) await this.state.save().catch(() => {});
    return { notified };
  }
}
