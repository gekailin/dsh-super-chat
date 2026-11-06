// 微信消息里的 @主题：解析出来作为标签，正文保留自然语言。
const TAG = /(^|[^\w@])@([^\s@,，。.!！?？、:：;；]+)/gu;
const MAX_TAGS = 8;
const TOPIC_NAME_MAX = 60;

/** Return the message text with @topic tokens removed, plus the topic names in order. */
export function extractTags(value) {
  const raw = String(value ?? '').trim();
  const names = [];
  const text = raw.replace(TAG, (_match, lead, name) => {
    const clean = [...name.trim()].slice(0, TOPIC_NAME_MAX).join('');
    if (clean) names.push(clean);
    return lead;
  }).replace(/\s{2,}/gu, ' ').trim();
  return {
    text: text || raw,
    tags: [...new Set(names.filter(Boolean))].slice(0, MAX_TAGS),
  };
}
