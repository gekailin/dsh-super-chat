// 把「发给文件传输助手的文本」接到 agent，再把回复发回去。
//
// 注意：文件传输助手是「和自己对话」——手机发的、网页发的、agent 回复的，
// FromUserName 全都是你自己，只有 ToUserName 恒为 "filehelper"。
// 所以：
//   1) 只能按 to === peer 判断「这是这个会话里的消息」；
//   2) 自己刚发出的 MsgID 必须排除，否则 agent 会被自己的回复再次触发（死循环）。
export class Bridge {
  constructor({ client, agent, peer = 'filehelper', log = () => {}, send, seen, onUnsupported } = {}) {
    this.client = client;
    this.agent = agent;
    this.peer = peer;
    this.log = log;
    this.send = send ?? ((text) => client.sendText(peer, text));
    this.sent = new Set();
    this.fallbackSeen = new Set();
    // 入站去重：默认内存 Set；super chat 模式传入持久化实现 { has, add }。
    this.seen = seen ?? {
      has: (id) => this.fallbackSeen.has(id),
      add: (id) => {
        this.fallbackSeen.add(id);
        if (this.fallbackSeen.size > 500) this.fallbackSeen.delete(this.fallbackSeen.values().next().value);
      },
    };
    this.onUnsupported = onUnsupported;
    this.history = [];
    this.chain = Promise.resolve();
  }

  submit(msg) {
    this.chain = this.chain
      .then(() => this.handle(msg))
      .catch((e) => this.log('处理失败: ' + e.message));
    return this.chain;
  }

  isOwn(msg) {
    const id = String(msg.id);
    return this.sent.has(id) || this.client.sentIds?.has(id);
  }

  async handle(msg) {
    if (!msg || msg.to !== this.peer) return null;
    if (this.isOwn(msg)) return null;
    if (msg.type !== 1) {
      // 51=状态通知，10000=系统提示，10002=撤回：静默丢弃，别刷屏
      if (![51, 10000, 10002].includes(msg.type)) {
        this.log('跳过非文本消息 type=' + msg.type);
        if (this.onUnsupported) await this.onUnsupported(msg).catch((e) => this.log('提示失败: ' + e.message));
      }
      return null;
    }
    const text = String(msg.text || '').trim();
    if (!text) return null;

    const key = String(msg.id);
    if (await this.seen.has(key)) return null;
    await this.seen.add(key);

    this.log('← ' + text);
    const answer = await this.agent.reply({ text, msg, history: this.history });
    if (!answer) return null;

    const output = typeof answer === 'string' ? answer : answer.text;
    if (typeof answer === 'string') {
      this.history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
      if (this.history.length > 40) this.history.splice(0, this.history.length - 40);
    }

    if (output) {
      const msgId = await this.send(output);
      if (msgId) this.sent.add(String(msgId));
      this.log('→ ' + output);
    }
    if (typeof answer === 'object' && typeof answer.after === 'function') await answer.after();
    return output ?? null;
  }
}
