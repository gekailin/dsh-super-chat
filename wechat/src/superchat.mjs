// Super Chat 面板 API 的 HTTP 客户端。
// 默认指向 dsh-super-chat 插件：GET/POST /super-chat/api/chat，header x-super-chat-request。
// 也可用 SUPERCHAT_PATH / SUPERCHAT_HEADER 指向兼容的 /superagent-chat/api。
const DEFAULT_BASE = process.env.SUPERCHAT_URL || 'http://127.0.0.1:3080';
const DEFAULT_PATH = process.env.SUPERCHAT_PATH || '/super-chat/api';
const DEFAULT_HEADER = process.env.SUPERCHAT_HEADER || 'x-super-chat-request';
const DEFAULT_TIMEOUT_MS = 15_000;

export class SuperchatError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SuperchatError';
    this.status = status;
  }
}

export class SuperchatClient {
  constructor({ base = DEFAULT_BASE, path = DEFAULT_PATH, header = DEFAULT_HEADER, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.path = String(path).replace(/\/+$/, '');
    this.header = header;
    this.log = log;
    this.timeoutMs = timeoutMs;
  }

  get name() {
    return 'superchat:' + this.base + this.path;
  }

  async request(path, init = {}) {
    let res;
    try {
      res = await fetch(this.base + path, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          [this.header]: '1',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
      });
    } catch (e) {
      throw new SuperchatError('连接失败: ' + e.message, 0);
    }
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text.slice(0, 300) };
    }
    if (!res.ok) throw new SuperchatError(body?.error || ('HTTP ' + res.status), res.status);
    return body;
  }

  /** 读通用聊天，或一个主题的过滤视图；桥需要完整的最近窗口来定位已投递游标。 */
  view(topic) {
    const params = new URLSearchParams();
    if (topic) params.set('topic', topic);
    params.set('limit', '200');
    return this.request(this.path + '/chat?' + params.toString());
  }

  /** 发一条消息；tags 是主题名称，服务端会复用或创建主题。 */
  post(text, { tags = [], clientId, via = 'wechat' } = {}) {
    return this.request(this.path + '/chat', {
      method: 'POST',
      body: JSON.stringify({ text, tags, via, ...(clientId ? { clientId } : {}) }),
    });
  }
}
