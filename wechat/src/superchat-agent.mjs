// super chat 模式的 agent 适配层：自然语言 + @主题 打标；回复由 poller 异步转发。
import { randomUUID } from 'node:crypto';
import { extractTags } from './tags.mjs';

export class SuperchatAgent {
  constructor({ client, state, peerId, poller, log = () => {} }) {
    this.client = client;
    this.state = state;
    this.peerId = peerId;
    this.poller = poller;
    this.log = log;
  }

  get name() {
    return this.client.name;
  }

  async reply({ text }) {
    const parsed = extractTags(text);
    const peer = this.state.peer(this.peerId);

    let view;
    try {
      view = await this.client.view();
    } catch (e) {
      await this.queue(parsed, peer);
      return { text: '⚠️ 连不上 Superagent（' + e.message + '），消息已暂存，恢复后自动发送。' };
    }
    if (view.mode === 'session') {
      this.log('[in] superagent 不可用，使用独立 Session');
    }
    try {
      await this.poller.ensureCursor(view);
    } catch (e) {
      this.log('[in] 初始化游标失败: ' + e.message);
    }
    try {
      const result = await this.client.post(parsed.text, { tags: parsed.tags, clientId: randomUUID() });
      if (result.result === 'filtered') {
        return { text: '这条被聊天 Source 过滤了，没有发起工作。' };
      }
      return null;
    } catch (e) {
      await this.queue(parsed, peer);
      return { text: '⚠️ 发送失败（' + e.message + '），消息已暂存，恢复后自动发送。' };
    }
  }

  async queue(parsed, peer) {
    peer.outbox.push({
      id: randomUUID(),
      text: parsed.text,
      tags: parsed.tags,
      attempts: 0,
      at: new Date().toISOString(),
    });
    await this.state.save();
  }
}
