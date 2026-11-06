// agent 适配层：echo / 通用 OpenAI 兼容 / 以 app id 授权的 OpenAI 兼容网关
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const echoAgent = {
  name: 'echo',
  async reply({ text }) {
    return '收到：' + text;
  },
};

// 任意 OpenAI 兼容端点（OpenAI / DeepSeek 官方 / Ollama / vLLM ...）
export function openaiAgent({
  base = process.env.AGENT_API_BASE || 'https://api.deepseek.com/v1',
  key = process.env.AGENT_API_KEY,
  model = process.env.AGENT_MODEL || 'deepseek-chat',
  system = process.env.AGENT_SYSTEM || DEFAULT_SYSTEM,
} = {}) {
  if (!key) throw new Error('缺少 AGENT_API_KEY');
  return makeAgent({
    name: 'openai:' + model,
    url: base.replace(/\/$/, '') + '/chat/completions',
    headers: { Authorization: 'Bearer ' + key },
    model,
    system,
  });
}

// 以 app id 作 Bearer 凭据的 OpenAI 兼容网关；AIGC_BASE 必须由使用者提供
export function gatewayAgent({
  base = process.env.AIGC_BASE,
  appid = process.env.AIGC_APPID,
  model = process.env.AIGC_MODEL || 'deepseek-v4-flash',
  system = process.env.AGENT_SYSTEM || DEFAULT_SYSTEM,
} = {}) {
  if (!appid) throw new Error('缺少 AIGC_APPID');
  if (!base) throw new Error('缺少 AIGC_BASE');
  return makeAgent({
    name: 'gateway:' + model,
    url: base.replace(/\/$/, '') + '/chat/completions',
    headers: { Authorization: 'Bearer ' + appid },
    model,
    system,
  });
}

export const DEFAULT_SYSTEM =
  '你是一个通过微信「文件传输助手」和用户对话的助手。回答简洁、直接，默认用中文；' +
  '代码块用 markdown，但不要长篇大论。用户可能在手机上读，段落尽量短。';

function makeAgent({
  name,
  url,
  headers,
  model,
  system,
  temperature = 0.6,
  maxTokens = 2048,
  timeoutMs = 90_000,
  retries = 2,
}) {
  return {
    name,
    async reply({ text, history = [] }) {
      const body = {
        model,
        messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: text }],
        temperature,
        max_tokens: maxTokens,
      };
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt++) {
        let res;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          lastError = e;
          if (attempt < retries) {
            await sleep(1500 * (attempt + 1));
            continue;
          }
          throw new Error('网络错误: ' + e.message);
        }
        if (res.ok) {
          const j = await res.json();
          const content = j?.choices?.[0]?.message?.content;
          if (typeof content !== 'string') throw new Error('响应缺少 choices[0].message.content');
          return content.trim();
        }
        const errText = await res.text();
        lastError = new Error('HTTP ' + res.status + ': ' + errText.slice(0, 300));
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          const wait = res.status === 429 ? 3000 * (attempt + 1) : 1500 * (attempt + 1);
          await sleep(wait);
          continue;
        }
        throw lastError;
      }
      throw lastError;
    },
  };
}

export function buildAgent(env = process.env) {
  if (env.AIGC_APPID) return gatewayAgent();
  if (env.AGENT_API_KEY) return openaiAgent();
  return echoAgent;
}
