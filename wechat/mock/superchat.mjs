// 假的 Super Chat 后端：模拟单流 + 主题标签的 HTTP API，用来在没开面板时验证桥。
import http from 'node:http';

const now = () => new Date().toISOString();

export async function startSuperchatMock({ port = 0, host = '127.0.0.1' } = {}) {
  const state = {
    topics: [],
    messages: [],
    posts: [],
    gets: [],
    seq: 0,
    configured: true,
    mode: 'superagent',
    postResult: 'stored',
  };

  const topic = (name) => {
    const clean = String(name ?? '').trim();
    if (!clean) return null;
    let item = state.topics.find((entry) => entry.name.toLowerCase() === clean.toLowerCase());
    if (!item) {
      item = { id: 'tp-' + (++state.seq), name: clean, createdAt: now(), updatedAt: now(), messageCount: 0 };
      state.topics.push(item);
    }
    return item;
  };
  const message = (role, text, tags = []) => {
    const ids = tags.map(topic).filter(Boolean).map((item) => item.id);
    const entry = { id: 'm' + (++state.seq), role, text, at: now(), tags: ids };
    state.messages.push(entry);
    for (const item of state.topics) {
      const count = state.messages.filter((m) => m.tags.includes(item.id)).length;
      item.messageCount = count;
      const latest = [...state.messages].reverse().find((m) => m.tags.includes(item.id));
      item.updatedAt = latest?.at ?? item.createdAt;
    }
    return entry;
  };
  const view = (topicId) => {
    const selected = topicId ? state.topics.find((item) => item.id === topicId) : undefined;
    return {
      ...(selected ? { topic: selected } : {}),
      topics: state.topics.map((item) => ({ ...item })),
      messages: (topicId ? state.messages.filter((entry) => entry.tags.includes(topicId)) : state.messages).slice(-200).map((entry) => ({ ...entry })),
      mode: state.mode,
      configured: state.configured,
      busy: false,
    };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
    const json = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const read = () => new Promise((resolve) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); }
      });
    });
    try {
      if (url.pathname === '/super-chat/api/chat' && req.method === 'GET') {
        const selected = url.searchParams.get('topic') || undefined;
        state.gets.push({ topic: selected ?? null });
        if (selected && !state.topics.some((item) => item.id === selected)) return json({ error: 'Unknown topic' }, 404);
        return json(view(selected));
      }
      if (url.pathname === '/super-chat/api/chat' && req.method === 'POST') {
        const body = await read();
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) return json({ error: 'A message is required' }, 400);
        const tags = Array.isArray(body.tags) ? body.tags.map(topic).filter(Boolean).map((item) => item.name) : [];
        const entry = message('user', text, tags);
        state.posts.push({ text: entry.text, tags, clientId: body.clientId ?? null, via: body.via ?? null });
        const selected = body.topic || state.topics.find((item) => entry.tags.includes(item.id))?.id;
        return json({ result: state.postResult, ...view(selected) });
      }
      if (url.pathname === '/super-chat/api/topics' && req.method === 'POST') {
        const body = await read();
        if (typeof body.name !== 'string' || !body.name.trim()) return json({ error: 'A topic name is required' }, 400);
        const item = topic(body.name);
        return json({ topic: item, topics: state.topics.map((entry) => ({ ...entry })) });
      }
      if (url.pathname === '/super-chat/api/topics/rename' && req.method === 'POST') {
        const body = await read();
        const item = state.topics.find((entry) => entry.id === body.id);
        if (!item) return json({ error: 'Unknown topic' }, 404);
        item.name = String(body.name ?? '').trim();
        return json({ topic: item, topics: state.topics.map((entry) => ({ ...entry })) });
      }
      return json({ error: 'not found: ' + url.pathname }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    url: 'http://' + host + ':' + actualPort,
    get topics() { return state.topics; },
    get messages() { return state.messages; },
    get posts() { return state.posts; },
    get gets() { return state.gets; },
    set configured(value) { state.configured = value; },
    set mode(value) { state.mode = value; },
    set postResult(value) { state.postResult = value; },
    injectAgent(text, tags = []) {
      return message('agent', text, tags);
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
