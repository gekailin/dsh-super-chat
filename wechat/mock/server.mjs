// 假的微信网页版后端，用来在没有任何微信账号的情况下验证整条链路。
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const PAGE = new URL('./page.html', import.meta.url);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export async function startMock({ port = 0, host = '127.0.0.1' } = {}) {
  const state = { queue: [], sent: [], logouts: [], inits: 0, syncRetcode: '0', msgId: 1000, val: 1, pollCount: 0 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
    const p = url.pathname;
    const json = (o, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(o));
    };
    try {
      if (p === '/' || p === '/mock') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(await readFile(PAGE, 'utf8'));
        return;
      }
      if (p === '/_inject') {
        const b = JSON.parse(await readBody(req));
        state.queue.push({
          MsgId: b.msgId !== undefined ? String(b.msgId) : String(state.msgId++),
          FromUserName: b.from || 'filehelper',
          ToUserName: b.to || '@me',
          MsgType: b.type ?? 1,
          Content: b.content ?? '',
          CreateTime: Math.floor(Date.now() / 1000),
        });
        return json({ ok: true, queued: state.queue.length });
      }
      if (p === '/_sent') return json(state.sent);
      if (p === '/_reset') {
        state.queue = [];
        state.sent = [];
        state.logouts = [];
        return json({ ok: true });
      }
      if (p === '/jslogin') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end('window.QRLogin.code = 200; window.QRLogin.uuid = "MOCKUUID";');
        return;
      }
      if (p.startsWith('/qrcode/')) {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        return;
      }
      if (p === '/cgi-bin/mmwebwx-bin/login') {
        state.pollCount++;
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        if (state.pollCount < 2) {
          res.end('window.code=201;');
        } else {
          const host = req.headers.host || '127.0.0.1';
          const ru =
            'http://' + host + '/cgi-bin/mmwebwx-bin/webwxnewloginpage?ticket=MOCKTICKET&uuid=MOCKUUID&lang=zh_CN&scan=1';
          res.end('window.code=200;\nwindow.redirect_uri="' + ru + '";');
        }
        return;
      }
      if (p.endsWith('/webwxnewloginpage')) {
        res.writeHead(200, {
          'content-type': 'text/xml; charset=utf-8',
          'set-cookie': ['wxuin=1000; Path=/', 'wxsid=MOCKSID; Path=/', 'skey=MOCKSKEY; Path=/'],
        });
        res.end(
          '<error><ret>0</ret><message></message><skey>MOCKSKEY</skey><wxsid>MOCKSID</wxsid><wxuin>1000</wxuin><pass_ticket>MOCKTICKET</pass_ticket></error>'
        );
        return;
      }
      if (p.endsWith('/webwxinit')) {
        state.inits++;
        return json({
          BaseResponse: { Ret: 0 },
          SyncKey: { Count: 1, List: [{ Key: 1, Val: 1 }] },
          User: { UserName: '@me', NickName: 'tester' },
          SKey: '',
        });
      }
      if (p.endsWith('/webwxstatusnotify')) return json({ BaseResponse: { Ret: 0 } });
      if (p.endsWith('/webwxlogout')) {
        const b = JSON.parse((await readBody(req)) || '{}');
        state.logouts.push({ body: b, query: Object.fromEntries(url.searchParams), appId: req.headers.mmweb_appid ?? '' });
        return json({ ret: 0 });
      }
      if (p.endsWith('/synccheck')) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('window.synccheck={retcode:"' + state.syncRetcode + '",selector:"' + (state.queue.length ? 2 : 0) + '"}');
        return;
      }
      if (p.endsWith('/webwxsync')) {
        const list = state.queue.splice(0);
        return json({
          BaseResponse: { Ret: 0 },
          AddMsgCount: list.length,
          AddMsgList: list,
          SyncKey: { Count: 1, List: [{ Key: 1, Val: ++state.val }] },
          ContinueFlag: 0,
        });
      }
      if (p.endsWith('/webwxsendmsg')) {
        const b = JSON.parse((await readBody(req)) || '{}');
        state.sent.push(b);
        return json({ BaseResponse: { Ret: 0 }, MsgID: String(state.msgId++), LocalID: b?.Msg?.LocalID });
      }
      json({ error: 'not found: ' + p }, 404);
    } catch (e) {
      json({ error: e.message }, 500);
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    url: 'http://' + host + ':' + actualPort,
    get sent() {
      return state.sent;
    },
    get logouts() {
      return state.logouts;
    },
    get inits() {
      return state.inits;
    },
    setSyncRetcode(code) {
      state.syncRetcode = String(code);
    },
    async inject(msg) {
      const r = await fetch('http://' + host + ':' + actualPort + '/_inject', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(msg),
      });
      return r.json();
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
