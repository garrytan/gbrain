/**
 * Pure canonical Markdown event rendering.
 *
 * This module owns no transport, authorization, filesystem, or projection
 * behavior. It validates one typed interaction and deterministically splices
 * it into an existing page while preserving every unrelated body byte.
 */

import { applySparsePagePatch, CanonicalMutationError } from './canonical-page-mutations.ts';
import { coerceFrontmatterString, parseMarkdown } from './markdown.ts';

export interface CanonicalInteractionEvent {
  date: string;
  channel: string;
  note: string;
  eventToken: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_TOKEN = /^sha256:[0-9a-f]{64}$/;
const CHANNEL = /^[\p{L}\p{N}][\p{L}\p{N} _./+()-]{0,39}$/u;
const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizedFrontmatterDate(value: unknown): string | null {
  const raw = coerceFrontmatterString(value).trim();
  if (!raw) return null;
  if (isRealIsoDate(raw)) return raw;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

export function validateCanonicalInteractionEvent(event: CanonicalInteractionEvent): void {
  if (typeof event.date !== 'string' || typeof event.channel !== 'string'
    || typeof event.note !== 'string' || typeof event.eventToken !== 'string') {
    throw new CanonicalMutationError('invalid_patch', 'Interaction fields must all be strings.');
  }
  if (!isRealIsoDate(event.date)) {
    throw new CanonicalMutationError('invalid_patch', 'Interaction date must be a real ISO calendar date (YYYY-MM-DD).');
  }
  if (!CHANNEL.test(event.channel) || CONTROL_OR_LINE_BREAK.test(event.channel)) {
    throw new CanonicalMutationError('invalid_patch', 'Interaction channel must be a single safe label of at most 40 characters.');
  }
  const note = event.note.trim();
  if (!note || event.note.length > 500 || Buffer.byteLength(event.note, 'utf8') > 2_000
    || CONTROL_OR_LINE_BREAK.test(event.note) || note.includes('<!--') || note.includes('-->')) {
    throw new CanonicalMutationError('invalid_patch', 'Interaction note must be one plain-text line of 1 to 500 characters.');
  }
  if (!EVENT_TOKEN.test(event.eventToken)) {
    throw new CanonicalMutationError('invalid_patch', 'Interaction event token must be a sha256 digest.');
  }
}

export function renderCanonicalInteractionEvent(event: CanonicalInteractionEvent): string {
  validateCanonicalInteractionEvent(event);
  const plainNote = event.note.trim().replace(/[\\`*_{}\[\]<>]/g, '\\$&');
  return `<!-- cosmic:event:v1 ${event.eventToken} -->\n- ${event.date} · ${event.channel.trim()} · ${plainNote}`;
}

interface HeadingRange {
  headingEnd: number;
  sectionEnd: number;
  newline: '\n' | '\r\n';
}

function isInteractionsH2(line: string): boolean {
  return /^ {0,3}##[ \t]+Interactions(?:[ \t]+#+)?[ \t]*$/.test(line);
}

function isH1OrH2(line: string): boolean {
  return /^ {0,3}(?:#(?:[ \t]+.*)?|##(?:[ \t]+.*)?)[ \t]*$/.test(line);
}

/** Find the real Interactions H2 while ignoring headings inside fenced code. */
function findInteractionsHeading(content: string): HeadingRange | null {
  const newline: '\n' | '\r\n' = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.match(/.*(?:\r\n|\n|$)/g) ?? [];
  let offset = 0;
  let fence: { marker: '`' | '~'; length: number } | null = null;
  let headingEnd: number | null = null;
  let sectionEnd: number | null = null;
  for (const raw of lines) {
    if (!raw) continue;
    const line = raw.replace(/\r?\n$/, '');
    if (fence !== null) {
      const close = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
      offset += raw.length;
      continue;
    }
    const opener = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opener && (opener[1][0] === '~' || !opener[2].includes('`'))) {
      fence = { marker: opener[1][0] as '`' | '~', length: opener[1].length };
      offset += raw.length;
      continue;
    }
    if (isInteractionsH2(line)) {
      if (headingEnd !== null) {
        throw new CanonicalMutationError('invalid_canonical', 'Canonical page has more than one Interactions section.');
      }
      headingEnd = offset + raw.length;
    } else if (headingEnd !== null && sectionEnd === null && isH1OrH2(line)) {
      sectionEnd = offset;
    }
    offset += raw.length;
  }
  return headingEnd === null ? null : { headingEnd, sectionEnd: sectionEnd ?? content.length, newline };
}

function interactionInsertionOffset(section: string, eventDate: string): number {
  const lines = section.match(/.*(?:\r\n|\n|$)/g) ?? [];
  let offset = 0;
  let previousStart = 0;
  let previousLine = '';
  let fence: { marker: '`' | '~'; length: number } | null = null;
  let sawBullet = false;
  let lastBulletEnd = 0;
  for (const raw of lines) {
    if (!raw) continue;
    const line = raw.replace(/\r?\n$/, '');
    if (fence !== null) {
      const close = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
    } else {
      const opener = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (opener && (opener[1][0] === '~' || !opener[2].includes('`'))) {
        fence = { marker: opener[1][0] as '`' | '~', length: opener[1].length };
      } else {
        const bullet = line.match(/^ {0,3}-[ \t]+(\d{4}-\d{2}-\d{2})[ \t]+·/);
        if (bullet && isRealIsoDate(bullet[1])) {
          sawBullet = true;
          lastBulletEnd = offset + raw.length;
          if (eventDate >= bullet[1]) {
            return /^<!--[ \t]+cosmic:event:v1[ \t]+sha256:[0-9a-f]{64}[ \t]+-->$/.test(previousLine)
              ? previousStart
              : offset;
          }
        }
      }
    }
    previousStart = offset;
    previousLine = line;
    offset += raw.length;
  }
  if (!sawBullet) return 0;
  return lastBulletEnd;
}

function spliceInteractionBlock(content: string, block: string, eventDate: string): string {
  const marker = block.split(/\r?\n/, 1)[0];
  if (content.includes(marker)) {
    throw new CanonicalMutationError('invalid_canonical', 'Canonical page already contains this event marker without its immutable receipt.');
  }
  const heading = findInteractionsHeading(content);
  if (!heading) {
    const newline: '\n' | '\r\n' = content.includes('\r\n') ? '\r\n' : '\n';
    const separator = content.endsWith(`${newline}${newline}`)
      ? ''
      : content.endsWith(newline) ? newline : `${newline}${newline}`;
    return `${content}${separator}## Interactions${newline}${newline}${block.replaceAll('\n', newline)}${newline}`;
  }

  const section = content.slice(heading.headingEnd, heading.sectionEnd);
  const localOffset = interactionInsertionOffset(section, eventDate);
  const absoluteOffset = heading.headingEnd + localOffset;
  const rendered = block.replaceAll('\n', heading.newline);
  const leading = localOffset === 0 || content[absoluteOffset - 1] !== '\n' ? heading.newline : '';
  const inserted = `${leading}${rendered}${heading.newline}`;
  return content.slice(0, absoluteOffset) + inserted + content.slice(absoluteOffset);
}

/**
 * Apply one newest-first interaction and monotonic contact metadata update.
 * Historical backfills are placed by date and never regress contact metadata.
 */
export function applyCanonicalInteractionEvent(
  content: string,
  slug: string,
  event: CanonicalInteractionEvent,
): string {
  const block = renderCanonicalInteractionEvent(event);
  const parsed = parseMarkdown(content, `${slug}.md`, { validate: true, expectedSlug: slug });
  if ((parsed.errors ?? []).length > 0) {
    throw new CanonicalMutationError(
      'invalid_canonical',
      `Canonical page cannot receive an interaction until its Markdown validates: ${(parsed.errors ?? []).map((error) => error.code).join(', ')}.`,
    );
  }

  const existingDateRaw = coerceFrontmatterString(parsed.frontmatter.last_contacted).trim();
  const existingDate = normalizedFrontmatterDate(parsed.frontmatter.last_contacted);
  const shouldAdvance = !existingDateRaw
    || (existingDate !== null && event.date >= existingDate);
  const withMetadata = shouldAdvance
    ? applySparsePagePatch(content, slug, {
        frontmatter_set: {
          last_contacted: event.date,
          last_interaction_channel: event.channel.trim(),
        },
      })
    : content;
  return spliceInteractionBlock(withMetadata, block, event.date);
}
