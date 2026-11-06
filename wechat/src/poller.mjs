// 轮询通用聊天流，把游标之后的 agent 消息转发到微信。
const DEFAULT_POLL_MS = 2000;
const MAX_INBOX_ATTEMPTS = 50;

export class Poller {
  constructor({ superchat, outbound, state, peerId, log = () => {}, pollMs = DEFAULT_POLL_MS }) {
    this.superchat = superchat;
    this.outbound = outbound;
    this.state = state;
    this.peerId = peerId;
    this.log = log;
    this.pollMs = pollMs;
    this.error = null;
    this.stopped = false;
    this.timer = null;
    this.busy = false;
    this.cache = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), this.pollMs);
    this.timer.unref?.();
    this.kick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    const peer = this.state.peer(this.peerId);
    return {
      pendingOutbox: peer.outbox.length,
      lastError: this.error,
      initialized: peer.initialized === true,
    };
  }

  kick() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    this.tick()
      .catch((e) => { this.error = e.message; })
      .finally(() => { this.busy = false; });
  }

  async tick() {
    let view;
    try {
      view = await this.superchat.view();
      this.error = null;
    } catch (e) {
      this.error = e.message;
      return;
    }
    this.cache = view;
    const peer = this.state.peer(this.peerId);
    if (!peer.initialized) {
      this.initCursor(peer, view);
      await this.state.save();
      await this.flushInbox();
      return;
    }
    const messages = view.messages ?? [];
    let fresh = [];
    if (peer.lastDeliveredId) {
      const index = messages.findIndex((message) => message.id === peer.lastDeliveredId);
      if (index < 0) {
        this.initCursor(peer, view);
        await this.state.save();
        void this.outbound.enqueue('离线期间的消息已跳过，打开 Super Chat 面板查看完整记录。').catch(() => {});
        await this.flushInbox();
        return;
      }
      fresh = messages.slice(index + 1).filter((message) => message.role === 'agent');
    } else {
      fresh = messages.filter((message) => message.role === 'agent');
    }
    for (const message of fresh) {
      try {
        await this.outbound.enqueue(this.format(message, view), { ref: message.id });
      } catch (e) {
        this.error = '发送到微信失败: ' + e.message;
        await this.state.save();
        return;
      }
      peer.lastDeliveredId = message.id;
      await this.state.save();
    }
    await this.flushInbox();
  }

  /** First poll only records the newest agent message, so history is not replayed into WeChat. */
  initCursor(peer, view) {
    const latest = [...(view.messages ?? [])].reverse().find((message) => message.role === 'agent');
    peer.lastDeliveredId = latest?.id ?? null;
    peer.initialized = true;
  }

  async ensureCursor(view) {
    const peer = this.state.peer(this.peerId);
    if (peer.initialized) return;
    this.initCursor(peer, view ?? (await this.superchat.view()));
    await this.state.save();
  }

  /** Prefix an agent reply with its topic names when it carries tags. */
  format(message, view) {
    const names = (message.tags ?? []).map((id) => (view.topics ?? []).find((topic) => topic.id === id)?.name ?? id);
    return names.length ? '「' + names.join('、') + '」' + message.text : message.text;
  }

  /** 补发入站暂存队列：Super Chat 不可达时消息不丢，恢复后按顺序补发。 */
  async flushInbox() {
    const peer = this.state.peer(this.peerId);
    if (peer.outbox.length === 0) return;
    const item = peer.outbox[0];
    if (item.nextAt && Date.now() < Date.parse(item.nextAt)) return;
    try {
      await this.superchat.post(item.text, { tags: item.tags ?? [], clientId: item.id });
      peer.outbox.shift();
      await this.state.save();
      this.log('[inbox] 暂存消息已补发');
    } catch (e) {
      item.attempts = (item.attempts ?? 0) + 1;
      item.nextAt = new Date(Date.now() + Math.min(2000 * 2 ** Math.min(item.attempts, 5), 60_000)).toISOString();
      this.error = '暂存消息补发失败: ' + e.message;
      if (item.attempts >= MAX_INBOX_ATTEMPTS) {
        peer.outbox.shift();
        void this.outbound.enqueue('有一条暂存消息多次发送失败，已放弃。').catch(() => {});
      }
      await this.state.save();
    }
  }
}
