// 微信消息里的 @主题：解析出来作为标签，正文保留自然语言。
const TAG = /(^|[^\w@])@([^\s@,，。.!！?？、]+)/gu;

/** Return the message text with @topic tokens removed, plus the topic names in order. */
export function extractTags(value) {
  const raw = String(value ?? '').trim();
  const names = [];
  const text = raw.replace(TAG, (_match, lead, name) => {
    if (name) names.push(name);
    return lead;
  }).replace(/\s{2,}/gu, ' ').trim();
  return {
    text: text || raw,
    tags: [...new Set(names.map((name) => name.trim()).filter(Boolean))],
  };
}
