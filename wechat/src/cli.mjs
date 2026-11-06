#!/usr/bin/env node
// headless 模式：拿到网页版凭据后，不需要浏览器常开。
import { readFile } from 'node:fs/promises';
import { WebWxClient } from './wxweb.mjs';
import { Bridge } from './bridge.mjs';
import { buildAgent } from './agents.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    out[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const credsPath = args.creds || 'creds.json';
const creds = JSON.parse(await readFile(credsPath, 'utf8'));
const agent = buildAgent();
const client = new WebWxClient(creds, { log: (m) => console.log('[wx]', m) });
const bridge = new Bridge({ client, agent, peer: args.peer || 'filehelper', log: (m) => console.log(m) });

await client.init();
await client.statusNotify();

const ac = new AbortController();
process.on('SIGINT', () => ac.abort());
console.log('已连接，监听 ' + bridge.peer + '（Ctrl-C 退出）');

try {
  await client.run({
    signal: ac.signal,
    onMessage: (m) => bridge.submit(m),
    onError: (e) => console.error('[sync]', e.message),
  });
} catch (e) {
  console.error('连接断开:', e.message);
  process.exitCode = 1;
}
