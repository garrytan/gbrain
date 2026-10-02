import { privateKeySpans } from './secret-scan.ts';

export const PRIVATE_KEY_PROJECTION_TOKEN = '<REDACTED:private_key_pem>';

/**
 * Retrieval text for a canonical page body: every private-key span (the
 * scanner's whole-text rules, including truncated and split keys) becomes one
 * `<REDACTED:private_key_pem>` token followed by as many newlines as the span
 * held, so line numbers stay stable. Chunkers and evidence reconstruction both
 * cut from this text, which keeps chunk anchors aligned and keeps key material
 * out of chunks, embeddings and delivered evidence. The stored body and raw
 * page reads are unchanged. Idempotent: the token holds no key marker.
 */
export function credentialSafeProjection(text: string): string {
  if (!text.includes('PRIVATE KEY-----')) return text;
  const spans = privateKeySpans(text);
  if (spans.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end } of spans) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    parts.push(text.slice(cursor, from));
    let newlines = 0;
    for (let i = from; i < end; i++) if (text.charCodeAt(i) === 10) newlines++;
    parts.push(PRIVATE_KEY_PROJECTION_TOKEN + '\n'.repeat(newlines));
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}
