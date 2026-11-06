import assert from 'node:assert/strict';
import { login } from '../src/login.mjs';
import { startMock } from '../mock/server.mjs';

const mock = await startMock();
const { creds, user } = await login({
  loginBase: mock.url,
  base: mock.url,
  qrPath: '.cache/test-qr.jpg',
  open: false,
  pollMs: 20,
});

assert.equal(creds.uin, '1000');
assert.equal(creds.sid, 'MOCKSID');
assert.equal(creds.skey, 'MOCKSKEY');
assert.equal(creds.passTicket, 'MOCKTICKET');
assert.match(creds.cookie, /wxuin=1000/);
assert.equal(user.NickName, 'tester');

await mock.close();
console.log('✅ login e2e ok');
