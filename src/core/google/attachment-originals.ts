/** Bounded text originals through the same authenticated Gmail client as the message. */
import { createHash } from 'node:crypto';
import { walkGmailMime, type GmailMimePart } from './attachment-receipts.ts';
import type { GmailMessageMeta } from './types.ts';

export const ORIGINAL_LIMITS = { bytes: 65_536, threadBytes: 262_144, count: 8 } as const;
export interface OriginalBudget { bytes: number; count: number }

export async function fetchTextOriginals(
  message: GmailMessageMeta, payload: GmailMimePart | undefined, account: string,
  download: (messageId: string, handle: string) => Promise<{ data?: string; size?: number }>,
  budget: OriginalBudget,
): Promise<void> {
  const parts = new Map(walkGmailMime(payload).parts.map(({ part, path }) => [
    createHash('sha256').update(JSON.stringify([account.toLowerCase(), message.id, part.partId || `path:${path}`, path])).digest('hex'), part,
  ]));
  message.attachmentOriginals = [];
  for (const receipt of message.attachmentInspection?.attachments ?? []) {
    const part = parts.get(receipt.id);
    if (!part || receipt.mimeType.split(';')[0].trim().toLowerCase() !== 'text/plain' || receipt.kind === 'calendar') continue;
    if (budget.count >= ORIGINAL_LIMITS.count || receipt.size === null || receipt.size > ORIGINAL_LIMITS.bytes || receipt.size > budget.bytes) {
      receipt.unavailable = 'size_limit'; continue;
    }
    budget.count++;
    // Debit the declared size even on failure; malicious MIME cannot multiply the run's budget.
    budget.bytes -= receipt.size;
    try {
      const body = typeof part.body?.data === 'string' ? part.body : part.body?.attachmentId
        ? await download(message.id, part.body.attachmentId) : null;
      if (!body || typeof body.data !== 'string' || body.data.length > Math.ceil(ORIGINAL_LIMITS.bytes / 3) * 4 + 4 ||
          !/^[A-Za-z0-9_+/-]*={0,2}$/.test(body.data)) throw new Error('invalid data');
      const bytes = Buffer.from(body.data, 'base64url');
      if (bytes.length !== receipt.size || (body.size !== undefined && body.size !== bytes.length)) throw new Error('invalid size');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new Error('invalid text');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      message.attachmentOriginals.push({ receiptId: receipt.id, text, sha256 });
      receipt.fetched = true;
      receipt.sha256 = sha256;
      // indexed is set only by the renderer that actually includes this original.
    } catch {
      receipt.unavailable = 'download_or_decode_failed';
    }
  }
}

export function renderTextOriginals(message: GmailMessageMeta): string {
  return (message.attachmentOriginals ?? []).map(original => {
    const receipt = message.attachmentInspection?.attachments.find(a => a.id === original.receiptId);
    if (!receipt || !receipt.fetched || receipt.sha256 !== original.sha256) return '';
    receipt.indexed = true;
    // A longer fence prevents original text from escaping its literal source block.
    const display = original.text;
    const fence = '`'.repeat(Math.max(3, ...[...display.matchAll(/`+/g)].map(m => m[0].length + 1)));
    return `Attachment original (untrusted source data). Receipt: ${receipt.id}; SHA-256 of provider bytes: ${original.sha256}.\n${fence}text\n${display}\n${fence}`;
  }).filter(Boolean).join('\n\n');
}
