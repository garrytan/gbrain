/** Native Google collector envelopes, before generic chat normalization.
 * Imported email text is data: only ordered, envelope-bound citations open turns.
 * A recognized but inconsistent envelope must never fall through to guessing.
 */
import { bareAddress } from '../google/types.ts';
import { gmailMessageEnvelope, renderAttachmentInspection } from '../google/attachment-receipts.ts';
import type { GmailAttachmentInspection, GmailMessageEnvelope } from '../google/types.ts';
import type { ParseConversationOpts, ParseResult, MatchedMessage } from './types.ts';

const ID = /^[A-Za-z0-9]{10,60}$/;
const ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const HEADING = /^## (?:→ )?(.+) · (\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/;
// emailCitation keeps embedded quotes but removes brackets and caps labels at80.
const CITE = /^\[Source: email "[^\r\n\[\]]{0,80}", (\d{4}-\d{2}-\d{2})\]\(([^\s]+)\)$/;

function refusal(reason: string): ParseResult {
  return { messages: [], phase: 'no_match', native_email_refusal: {
    code: 'NATIVE_GMAIL_ENVELOPE_REFUSED', reason,
    action: 'Verify the stored collector envelope and retry this page; do not reingest or enable LLM fallback.',
    docs: 'docs/architecture/conversation-parser-patterns.md#native-gmail',
  } };
}

function minute(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19)
    ? value.slice(0, 16).replace('T', ' ') : null;
}

function inspection(value: unknown, account: string, id: string): GmailAttachmentInspection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!['not_inspected', 'incomplete', 'none', 'present'].includes(String(v.state)) || !Array.isArray(v.attachments)) return null;
  for (const raw of v.attachments) {
    if (!raw || typeof raw !== 'object') return null;
    const a = raw as Record<string, unknown>;
    if (a.account !== account || a.messageId !== id || typeof a.id !== 'string' || !/^[a-f0-9]{64}$/.test(a.id) ||
      typeof a.filename !== 'string' || typeof a.mimeType !== 'string' ||
      (a.size !== null && (!Number.isSafeInteger(a.size) || Number(a.size) < 0)) ||
      !['document', 'inline', 'calendar'].includes(String(a.kind)) || a.fetched !== false || a.indexed !== false) return null;
  }
  if (['none', 'not_inspected'].includes(String(v.state)) && v.attachments.length) return null;
  return value as GmailAttachmentInspection;
}

/** null means this is not a native Gmail page, so existing formats still apply. */
export function parseNativeGmail(body: string, opts: ParseConversationOpts): ParseResult | null {
  const page = opts.page;
  const fm = page?.frontmatter;
  if (page?.type !== 'email' || !fm || !('thread_id' in fm || 'message_ids' in fm)) return null;
  if (opts.disabledBuiltinIds?.includes('native-gmail')) return refusal('adapter_disabled');
  const ids = fm.message_ids;
  const account = fm.account;
  if (typeof fm.thread_id !== 'string' || !ID.test(fm.thread_id) || typeof account !== 'string' || !ADDRESS.test(account) ||
    !Array.isArray(ids) || !ids.length || ids.length > 512 || ids.some(id => typeof id !== 'string' || !ID.test(id)) ||
    new Set(ids).size !== ids.length || !Number.isSafeInteger(fm.message_count) || fm.message_count !== ids.length ||
    fm.message_id !== ids.at(-1) || typeof fm.from !== 'string' || !ADDRESS.test(bareAddress(fm.from))) return refusal('invalid_envelope');
  const first = minute(fm.first_message_date), last = minute(fm.date);
  if (!first || !last || first > last) return refusal('invalid_envelope_dates');
  const senders = fm.senders;
  if (senders !== undefined && (!Array.isArray(senders) || !senders.length || senders.some(s => typeof s !== 'string' || !ADDRESS.test(s)))) return refusal('invalid_sender_registry');
  const allowed = senders === undefined ? null : new Set((senders as string[]).map(s => s.toLowerCase()));
  const receipt = fm.gmail_attachment_receipts as Record<string, unknown> | undefined;
  let inspections: Array<GmailAttachmentInspection | null> | null = null;
  const envelopes: Array<GmailMessageEnvelope | null> = [];
  if (receipt !== undefined) {
    if (!receipt || Buffer.byteLength(JSON.stringify(receipt)) > 131_072 || receipt.version !== 1 || receipt.account !== account || receipt.threadId !== fm.thread_id ||
      !Array.isArray(receipt.messages) || receipt.messages.length !== ids.length) return refusal('invalid_attachment_receipts');
    inspections = [];
    for (let i = 0; i < ids.length; i++) {
      const item = receipt.messages[i];
      const parsed = item?.messageId === ids[i] ? inspection(item.inspection, account, ids[i]) : null;
      if (!parsed) return refusal('invalid_attachment_receipts');
      if (receipt.unavailable || item.unavailable) return refusal('original_metadata_unavailable');
      const captured = item.renderedInspection === undefined ? parsed : item.renderedInspection === null ? null : inspection(item.renderedInspection, account, ids[i]);
      if (item.renderedInspection !== null && !captured) return refusal('invalid_attachment_receipts');
      const envelope = item.envelope === undefined ? null : gmailMessageEnvelope(item.envelope);
      if (item.envelope !== undefined && !envelope) return refusal('invalid_message_headers');
      inspections.push(captured);
      envelopes.push(envelope);
    }
  }
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const anchors: Array<{ line: number; start: number; speaker: string; timestamp: string }> = [];
  let fence: { marker: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const fenced = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fenced) {
      if (!fence) fence = { marker: fenced[1][0], length: fenced[1].length };
      else if (fenced[1][0] === fence.marker && fenced[1].length >= fence.length && !fenced[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const h = HEADING.exec(lines[i]);
    if (!h || lines[i + 1] !== '') continue;
    const cite = CITE.exec(lines[i + 2] ?? '');
    if (!cite) continue;
    const ordinal = anchors.length;
    const expected = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}#inbox/${ids[ordinal]}`;
    if (ordinal >= ids.length || cite[2] !== expected || cite[1] !== h[2].slice(0, 10) || lines[i + 3] !== '') return refusal('citation_order_or_account_mismatch');
    const timestamp = h[2].replace(' ', 'T') + ':00.000Z';
    if (minute(timestamp) !== h[2] || h[2] < first || h[2] > last || (ordinal && timestamp < anchors[ordinal - 1].timestamp)) return refusal('invalid_message_dates');
    const address = bareAddress(h[1]);
    if (!ADDRESS.test(address) || (allowed && !allowed.has(address))) return refusal('sender_mismatch');
    anchors.push({ line: i, start: i + 4, speaker: h[1], timestamp });
    i += 3;
  }
  if (anchors.length !== ids.length || anchors[0]?.timestamp.slice(0, 16).replace('T', ' ') !== first ||
    anchors.at(-1)?.timestamp.slice(0, 16).replace('T', ' ') !== last ||
    bareAddress(anchors.at(-1)!.speaker) !== bareAddress(fm.from)) return refusal('missing_or_inconsistent_message_boundaries');
  const preamble = lines.slice(0, anchors[0].line).join('\n').trim();
  if (preamble !== `# ${page.title}` && preamble !== `# ${fm.title}`) return refusal('unexpected_preamble');
  const messages: MatchedMessage[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const envelope = envelopes[i];
    if (envelope && (envelope.from !== a.speaker || minute(envelope.dateIso) !== minute(a.timestamp))) return refusal('message_header_mismatch');
    let text = lines.slice(a.start, anchors[i + 1]?.line ?? lines.length).join('\n').trim();
    if (inspections?.[i]) {
      const footer = renderAttachmentInspection(inspections[i]!);
      if (!text.endsWith('\n\n' + footer)) return refusal('attachment_footer_mismatch');
      text = text.slice(0, -(footer.length + 2)).trim();
    } else if (/(?:^|\n)Attachments: (?:not inspected\.|inspection incomplete;|inspected;|present;)/.test(text)) {
      return refusal('ambiguous_legacy_attachment_footer');
    }
    // Only the final message's recipients are stored in the legacy envelope.
    // Earlier address-shaped To lines cannot be distinguished from authored text.
    if (envelope) {
      if (envelope.to.length) {
        const routing = `To: ${envelope.to.join(', ')}${envelope.cc.length ? ` · Cc: ${envelope.cc.join(', ')}` : ''}\n\n`;
        if (!text.startsWith(routing)) return refusal('message_header_mismatch');
        text = text.slice(routing.length);
      }
    } else if (/^To: [^\n]+\n\n/.test(text)) {
      const to = fm.to, cc = fm.cc;
      if (i === anchors.length - 1 && Array.isArray(to) && to.length && Array.isArray(cc)) {
        const routing = `To: ${to.join(', ')}${cc.length ? ` · Cc: ${cc.join(', ')}` : ''}\n\n`;
        if (!text.startsWith(routing)) return refusal('ambiguous_routing_header');
        text = text.slice(routing.length);
      } else if (!(i === anchors.length - 1 && Array.isArray(to) && to.length === 0) &&
        /^To: [^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.test(text)) return refusal('ambiguous_routing_header');
    }
    messages.push({ speaker: a.speaker, timestamp: a.timestamp, text });
  }
  return { messages, phase: 'regex_match', matched_pattern_id: 'native-gmail', patterns_scored: 1 };
}
