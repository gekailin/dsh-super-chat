// 持久化状态：通用聊天的投递游标、入站去重、待发送队列。
// 以微信 peer 为顶层；接入小号时一个好友一个 peer，互不影响。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const VERSION = 2;
const SEEN_LIMIT = 500;

function newPeer() {
  return {
    initialized: false,
    lastDeliveredId: null,
    inbound: { lastMsgId: null, seen: [] },
    outbox: [],
  };
}

/** Keep the useful parts of a v1 peer (inbound dedupe and pending posts) and reset its stream cursor. */
function migratePeer(raw) {
  const peer = newPeer();
  if (raw && typeof raw === 'object') {
    if (raw.inbound && Array.isArray(raw.inbound.seen)) peer.inbound = raw.inbound;
    if (Array.isArray(raw.outbox)) peer.outbox = raw.outbox;
  }
  return peer;
}

export class State {
  constructor(path, log = () => {}) {
    this.path = path;
    this.log = log;
    this.data = { version: VERSION, peers: {} };
    this.writing = Promise.resolve();
  }

  static async load(path, log = () => {}) {
    const state = new State(path, log);
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      if (raw && typeof raw === 'object' && raw.peers && typeof raw.peers === 'object') {
        const peers = {};
        for (const [id, peer] of Object.entries(raw.peers)) peers[id] = raw.version === VERSION ? { ...newPeer(), ...peer } : migratePeer(peer);
        state.data = { version: VERSION, peers };
      } else {
        log('[state] 版本不匹配，使用空状态');
      }
    } catch (e) {
      if (e.code !== 'ENOENT') log('[state] 读取失败，使用空状态: ' + e.message);
    }
    return state;
  }

  peer(id) {
    if (!this.data.peers[id]) this.data.peers[id] = newPeer();
    const peer = this.data.peers[id];
    if (!peer.inbound) peer.inbound = { lastMsgId: null, seen: [] };
    if (!Array.isArray(peer.outbox)) peer.outbox = [];
    return peer;
  }

  isSeen(peerId, msgId) {
    return this.peer(peerId).inbound.seen.includes(String(msgId));
  }

  markSeen(peerId, msgId) {
    const peer = this.peer(peerId);
    const id = String(msgId);
    peer.inbound.seen.push(id);
    if (peer.inbound.seen.length > SEEN_LIMIT) {
      peer.inbound.seen.splice(0, peer.inbound.seen.length - SEEN_LIMIT);
    }
    peer.inbound.lastMsgId = id;
  }

  /** 串行、原子地写盘；后一次写会等前一次完成。 */
  save() {
    this.writing = this.writing
      .then(() => this.write())
      .catch((e) => this.log('[state] 写入失败: ' + e.message));
    return this.writing;
  }

  async write() {
    const tmp = this.path + '.tmp';
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.path);
  }
}
