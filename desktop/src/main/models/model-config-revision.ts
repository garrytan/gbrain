import { createHash } from 'node:crypto';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function modelConfigRevision(config: Record<string, any>): string {
  const fields = Object.fromEntries(Object.entries(config).filter(([key]) => /model|embedding|ocr|rerank|expansion|provider|api_key/.test(key) || ['chat_fallback_chain', 'engine', 'database_path', 'database_url'].includes(key)));
  const desktop = config.desktop ?? {};
  const catalog = Object.fromEntries(Object.entries(desktop).filter(([key]) => /model|custom_endpoint|custom_openai/.test(key)));
  return createHash('sha256').update(JSON.stringify(canonical({ ...fields, desktop: catalog }))).digest('hex');
}

export function assertModelRevision(config: Record<string, any>, expected: unknown): void {
  if (typeof expected !== 'string' || expected !== modelConfigRevision(config)) throw new Error('配置已变化：其他页面已更新模型配置。本页草稿未保存，请重新载入后再修改。');
}
