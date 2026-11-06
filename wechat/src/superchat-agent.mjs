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

  retryable(error) {
    const status = error?.status;
    return status === undefined || status === 0 || status === 429 || status >= 500;
  }

  async reply({ text, msg }) {
    const parsed = extractTags(text);
    const peer = this.state.peer(this.peerId);
    const rawId = msg?.id !== undefined ? 'wx-' + String(msg.id).replace(/[^A-Za-z0-9_-]/g, '') : '';
    const clientId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(rawId) ? rawId : randomUUID();

    if (!peer.initialized) {
      let view;
      try {
        view = await this.client.view();
      } catch (e) {
        if (!this.retryable(e)) {
          return { text: '⚠️ 发送失败（' + e.message + '），请修改后重发。' };
        }
        await this.queue(parsed, peer, clientId);
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
    }
    try {
      const result = await this.client.post(parsed.text, { tags: parsed.tags, clientId });
      if (result.result === 'filtered') {
        return { text: '这条被聊天 Source 过滤了，没有发起工作。' };
      }
      return null;
    } catch (e) {
      if (!this.retryable(e)) {
        return { text: '⚠️ 发送失败（' + e.message + '），请修改后重发。' };
      }
      await this.queue(parsed, peer, clientId);
      return { text: '⚠️ 发送失败（' + e.message + '），消息已暂存，恢复后自动发送。' };
    }
  }

  async queue(parsed, peer, id = randomUUID()) {
    peer.outbox.push({
      id,
      text: parsed.text,
      tags: parsed.tags,
      attempts: 0,
      at: new Date().toISOString(),
    });
    await this.state.save();
  }
}
