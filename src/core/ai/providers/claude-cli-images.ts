/** Preserve image bytes on Claude's tool-free CLI transport. */
import type { LanguageModelV2Prompt } from '@ai-sdk/provider';

const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_BYTES = 20 * 1024 * 1024;

export function claudeImageInput(prompt: LanguageModelV2Prompt, text: string): string | undefined {
  const images: Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> = [];
  for (const message of prompt) {
    if (message.role !== 'user') continue;
    for (const part of message.content) {
      if (part.type !== 'file' || !part.mediaType?.startsWith('image/')) continue;
      if (!TYPES.has(part.mediaType)) throw new Error('claude-cli: unsupported image media type');
      let bytes: Buffer;
      if (part.data instanceof Uint8Array) bytes = Buffer.from(part.data);
      else {
        const value = String(part.data);
        const raw = value.startsWith('data:') ? value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/) : null;
        if (part.data instanceof URL && !raw) throw new Error('claude-cli: image URL must contain inline data');
        if (raw && raw[1] !== part.mediaType) throw new Error('claude-cli: image media type mismatch');
        const base64 = raw?.[2] ?? value;
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length > Math.ceil(MAX_BYTES / 3) * 4)
          throw new Error('claude-cli: invalid or oversized inline image');
        bytes = Buffer.from(base64, 'base64');
        if (bytes.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, ''))
          throw new Error('claude-cli: invalid inline image');
      }
      if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('claude-cli: empty or oversized image');
      images.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: bytes.toString('base64') } });
    }
  }
  if (!images.length) return undefined;
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }, ...images] } }) + '\n';
}
