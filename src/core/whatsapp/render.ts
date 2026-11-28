/**
 * Deterministic Markdown renderers for WhatsApp chat source pages and seed person dossiers.
 *
 * Follows gbrain's iMessage safety contract:
 * - Every untrusted external string passes through `neutralizeOutsideText`.
 * - Every source page carries `visibility: private`, `source_kind: whatsapp`, `connector: whatsapp`.
 * - Inline-date turn format (`**Speaker** (YYYY-MM-DD HH:MM UTC): text`) matches conversation-parser.
 */
import { createHash } from 'node:crypto';
import { dumpFrontmatterYaml } from '../data-frontmatter.ts';
import { neutralizeOutsideText } from '../outside-content.ts';
import type { WhatsAppMessage, WhatsAppWhitelistEntry } from './types.ts';

function cleanInline(text: string): string {
  return neutralizeOutsideText(text.replace(/\s+/g, ' ').trim());
}

function cleanSpeaker(text: string): string {
  return cleanInline(text.replace(/[*:()[\]]/g, ' ')) || 'Unknown';
}

function formatUtcStamp(iso: string): string {
  if (!iso) return 'unknown';
  return iso.replace('T', ' ').replace(/:\d{2}Z$/, ' UTC');
}

export function hashWhatsAppThread(jid: string, messages: readonly WhatsAppMessage[]): string {
  const payload = messages.map((m) => [m.id, m.timestampIso, m.fromMe, m.text]);
  return createHash('sha256').update(JSON.stringify([jid, payload])).digest('hex').slice(0, 32);
}

export function whatsAppSourceSlug(contact: WhatsAppWhitelistEntry, lastDate: string): string {
  const datePart = /^\d{4}-\d{2}-\d{2}/.test(lastDate)
    ? lastDate.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const year = datePart.slice(0, 4);
  return `source/whatsapp/${year}/${datePart}-${contact.slug}`;
}

export function renderWhatsAppSourcePage(opts: {
  contact: WhatsAppWhitelistEntry;
  messages: readonly WhatsAppMessage[];
  ownerLabel?: string;
}): { slug: string; markdown: string; date: string; fingerprint: string } {
  const { contact, messages } = opts;
  const owner = cleanSpeaker(opts.ownerLabel ?? 'Me');
  const peer = cleanSpeaker(contact.name);
  const lastIso = messages.length > 0 ? messages[messages.length - 1]!.timestampIso : '';
  const date = /^\d{4}-\d{2}-\d{2}/.test(lastIso)
    ? lastIso.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const firstDate = messages.length > 0 && messages[0]!.timestampIso
    ? messages[0]!.timestampIso.slice(0, 10)
    : date;
  const slug = whatsAppSourceSlug(contact, date);
  const fingerprint = hashWhatsAppThread(contact.jid, messages);

  const frontmatter: Record<string, unknown> = {
    type: 'source',
    title: `WhatsApp Chat — ${cleanInline(contact.name)}`,
    date,
    connector: 'whatsapp',
    source_kind: 'whatsapp',
    whatsapp_contact: contact.slug,
    message_count: messages.length,
    first_date: firstDate,
    last_date: date,
    fingerprint,
    tags: ['whatsapp', 'personal-crm', contact.category],
    visibility: 'private',
    immutable: true,
  };

  const turns = messages.map((m) => {
    const speaker = m.fromMe ? owner : peer;
    const body = neutralizeOutsideText(m.text).replace(/\r\n/g, '\n');
    const lines = body.split('\n');
    const firstLine = `**${speaker}** (${formatUtcStamp(m.timestampIso)}): ${lines[0] ?? ''}`;
    if (lines.length === 1) return firstLine;
    return [firstLine, ...lines.slice(1).map((l) => `  ${l}`)].join('\n');
  });

  const body = [
    `# WhatsApp Chat — ${cleanInline(contact.name)}`,
    '',
    `**Contact:** [[people/${contact.slug}|${cleanInline(contact.name)}]] · **Range:** ${firstDate} to ${date} · **Messages:** ${messages.length}`,
    '',
    '## Transcript',
    '',
    ...turns,
  ].join('\n');

  const markdown = `---\n${dumpFrontmatterYaml(frontmatter, { lineWidth: 1000 })}---\n\n${body}\n`;
  return { slug, markdown, date, fingerprint };
}

export function renderWhatsAppSeedPersonPage(opts: {
  contact: WhatsAppWhitelistEntry;
  sourceSlug: string;
  date: string;
  messageCount: number;
}): string {
  const { contact, sourceSlug, date, messageCount } = opts;
  const safeName = cleanInline(contact.name);
  const frontmatter: Record<string, unknown> = {
    type: 'person',
    title: safeName,
    tags: ['person', 'personal-crm', 'whatsapp', contact.category],
    category: contact.category,
    updated: date,
    visibility: 'private',
  };

  const body = [
    `# ${safeName}`,
    '',
    '## State',
    `- Whitelisted WhatsApp contact (${contact.category}). ${messageCount} text messages captured through ${date} \`[Source: ${sourceSlug}]\`.`,
    '',
    '## Open Threads',
    `- Review WhatsApp transcript \`[Source: ${sourceSlug}]\` for key commitments and follow-ups.`,
  ].join('\n');

  return `---\n${dumpFrontmatterYaml(frontmatter, { lineWidth: 1000 })}---\n\n${body}\n`;
}
