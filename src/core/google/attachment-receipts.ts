import { createHash } from 'node:crypto';
import type { GmailAttachmentInspection, GmailAttachmentReceipt, GmailThreadData } from './types.ts';

export interface GmailMimePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMimePart[];
}

export const GMAIL_MIME_LIMITS = { depth: 32, parts: 512, receiptBytes: 65_536 } as const;

export function walkGmailMime(root: GmailMimePart | undefined): {
  parts: Array<{ part: GmailMimePart; path: string }>;
  reason?: GmailAttachmentInspection['reason'];
} {
  const parts: Array<{ part: GmailMimePart; path: string }> = [];
  if (!root) return { parts, reason: 'missing_payload' };
  const stack = [{ nodes: [root], index: 0, path: '', depth: 0 }];
  let reason: GmailAttachmentInspection['reason'];
  let visited = 0;
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.nodes.length) { stack.pop(); continue; }
    if (visited++ >= GMAIL_MIME_LIMITS.parts) { reason = 'part_limit'; break; }
    const index = frame.index++;
    const part = frame.nodes[index];
    if (!part || typeof part !== 'object' || Array.isArray(part)) { reason ??= 'malformed_part'; continue; }
    const path = frame.path ? `${frame.path}.${index}` : String(index);
    parts.push({ part, path });
    if (part.parts !== undefined && !Array.isArray(part.parts)) { reason ??= 'malformed_part'; continue; }
    if (part.parts?.length) {
      if (frame.depth >= GMAIL_MIME_LIMITS.depth) reason ??= 'depth_limit';
      else stack.push({ nodes: part.parts, index: 0, path, depth: frame.depth + 1 });
    }
  }
  return { parts, ...(reason ? { reason } : {}) };
}

export function gmailPartHeader(part: GmailMimePart | undefined, name: string): string {
  if (!Array.isArray(part?.headers)) return '';
  const header = part.headers.slice(0, GMAIL_MIME_LIMITS.parts).find(h => typeof h?.name === 'string' && h.name.toLowerCase() === name.toLowerCase());
  return typeof header?.value === 'string' ? header.value.slice(0, GMAIL_MIME_LIMITS.receiptBytes) : '';
}

export function inspectGmailAttachments(root: GmailMimePart | undefined, account: string, messageId: string, receiptBudget: number = GMAIL_MIME_LIMITS.receiptBytes): GmailAttachmentInspection {
  if (receiptBudget <= 0) return { state: 'incomplete', reason: 'receipt_bytes_limit', attachments: [] };
  const walk = walkGmailMime(root);
  let reason = walk.reason;
  const attachments: GmailAttachmentReceipt[] = [];
  let bytes = 0;
  for (const { part, path } of walk.parts) {
    if (!part.mimeType && !part.filename && !part.body && !part.parts?.length) reason ??= 'malformed_part';
    if (part.body !== undefined && (!part.body || typeof part.body !== 'object' || Array.isArray(part.body))) reason ??= 'malformed_part';
    if (part.body?.size !== undefined && (typeof part.body.size !== 'number' || !Number.isSafeInteger(part.body.size) || part.body.size < 0)) reason ??= 'malformed_part';
    if (part.headers !== undefined && (!Array.isArray(part.headers) || part.headers.slice(0, GMAIL_MIME_LIMITS.parts).some(h => !h || typeof h.name !== 'string' || typeof h.value !== 'string'))) reason ??= 'malformed_part';
    if (Array.isArray(part.headers) && part.headers.length > GMAIL_MIME_LIMITS.parts) reason ??= 'part_limit';
    if ([part.filename, part.mimeType, part.partId, part.body?.attachmentId].some(v => v !== undefined && typeof v !== 'string')) {
      reason ??= 'malformed_part';
      continue;
    }
    const filename = part.filename ?? '';
    const mimeType = part.mimeType ?? 'application/octet-stream';
    const partId = part.partId || `path:${path}`;
    const fields = [filename, mimeType, partId, part.body?.attachmentId ?? '', account, messageId];
    if (fields.some(v => v.length > GMAIL_MIME_LIMITS.receiptBytes)) {
      reason = 'receipt_bytes_limit'; break;
    }
    if (fields.some(v => v.includes('\0') || Buffer.from(v).toString('utf8') !== v)) {
      reason ??= 'malformed_part'; continue;
    }
    const mime = mimeType.split(';')[0].trim().toLowerCase();
    const disposition = gmailPartHeader(part, 'Content-Disposition').split(';')[0].trim().toLowerCase();
    if (mime.startsWith('multipart/') && !part.parts?.length) reason ??= 'malformed_part';
    if ((!part.mimeType || !mime) && !filename && !part.body?.attachmentId && !part.parts?.length &&
      disposition !== 'attachment' && disposition !== 'inline' && !gmailPartHeader(part, 'Content-ID')) {
      reason ??= 'malformed_part';
      continue;
    }
    const calendar = mime === 'text/calendar' || mime === 'application/ics';
    const body = mime === 'text/plain' || mime === 'text/html' || mime.startsWith('multipart/');
    if (!filename && disposition !== 'attachment' && !calendar && body) continue;
    if (!filename && !part.body?.attachmentId && !calendar && mime !== 'message/rfc822' && disposition !== 'attachment' && (!part.body || mime.startsWith('multipart/'))) continue;
    const receipt: GmailAttachmentReceipt = {
      id: createHash('sha256').update(JSON.stringify([account.toLowerCase(), messageId, partId, path])).digest('hex'),
      account, messageId, partId, filename, mimeType,
      size: typeof part.body?.size === 'number' && Number.isSafeInteger(part.body.size) && part.body.size >= 0 ? part.body.size : null,
      attachmentId: part.body?.attachmentId || null,
      kind: calendar ? 'calendar' : disposition === 'inline' || gmailPartHeader(part, 'Content-ID') ? 'inline' : 'document',
      fetched: false, indexed: false,
    };
    bytes += Buffer.byteLength(JSON.stringify(receipt));
    if (bytes > Math.min(receiptBudget, GMAIL_MIME_LIMITS.receiptBytes)) { reason = 'receipt_bytes_limit'; break; }
    attachments.push(receipt);
  }
  return { state: reason ? 'incomplete' : attachments.length ? 'present' : 'none', attachments, ...(reason ? { reason } : {}) };
}

function escaped(value: string): string {
  return value.replace(/[&<>"'`\[\]\\*_{}|\r\n\u0000-\u001f\u007f]/g, c => `&#${c.charCodeAt(0)};`);
}

export function renderAttachmentInspection(inspection?: GmailAttachmentInspection): string {
  const state = inspection?.state ?? 'not_inspected';
  const heading = state === 'not_inspected' ? 'Attachments: not inspected.'
    : state === 'incomplete' ? 'Attachments: inspection incomplete; absence is not established.'
    : state === 'none' ? 'Attachments: inspected; none found.'
    : 'Attachments: present; not downloaded; not indexed.';
  return [heading, ...(inspection?.attachments ?? []).map(a =>
    `- ${escaped(a.filename || '(unnamed)')} — ${escaped(a.mimeType)}; ${a.size === null ? 'size unavailable' : `${a.size} bytes`}; ${a.kind}; not downloaded; not indexed. Receipt: ${a.id}.`
  )].join('\n');
}

export function threadAttachmentReceipts(thread: GmailThreadData) {
  return { version: 1 as const, account: thread.account, threadId: thread.threadId,
    messages: thread.messages.map(m => ({ messageId: m.id, inspection: m.attachmentInspection ?? { state: 'not_inspected' as const, attachments: [] } })) };
}
