#!/usr/bin/env bun
/**
 * Gmail mbox pre-filter.
 *
 * Google Takeout produces a single mbox of your entire Gmail archive.
 * For a 20-year-old inbox, 60-80% of that is marketing, receipts, and
 * automated notifications that flood the brain with noise and dominate
 * embedding cost. This script drops the noise BEFORE it hits gbrain.
 *
 * Usage:
 *   bun scripts/filter-gmail-mbox.ts <input.mbox> <output-dir> [--keep d1,d2]
 *
 * Filters applied:
 *   - Drop senders matching noreply / no-reply / notifications / alerts /
 *     donotreply / mailer-daemon / postmaster (common automated patterns)
 *   - Drop messages carrying a List-Unsubscribe header (marketing + lists)
 *   - Drop messages whose primary content type is text/calendar (redundant
 *     with calendar-to-brain)
 *   - Strip quoted-reply `>` lines so each message only embeds its new text
 *
 * --keep accepts a comma-separated list of sender-email substrings (usually
 * domains) that override the drops — use this to preserve high-signal
 * automated mail (bank statements, flight confirmations).
 *
 * Output: one markdown file per kept message in <output-dir>/YYYY/MM/,
 * ready for `gbrain sync <output-dir>`.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

interface ParsedMessage {
  headers: Map<string, string>;
  body: string;
}

interface CliArgs {
  input: string;
  outputDir: string;
  keep: string[];
}

interface Stats {
  total: number;
  droppedNoreply: number;
  droppedUnsubscribe: number;
  droppedCalendar: number;
  droppedEmptyBody: number;
  kept: number;
}

const NOREPLY_PATTERN =
  /\b(noreply|no-reply|notifications?|alerts?|donotreply|do-not-reply|mailer-daemon|postmaster|bounces?)\b/i;

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let keep: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') {
      const next = argv[++i];
      if (!next) throw new Error('--keep requires a value');
      keep = next
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg.startsWith('--keep=')) {
      keep = arg
        .slice('--keep='.length)
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    throw new Error(
      'Usage: filter-gmail-mbox.ts <input.mbox> <output-dir> [--keep d1,d2]',
    );
  }
  return { input: positional[0], outputDir: positional[1], keep };
}

export function splitMbox(content: string): string[] {
  // mbox messages are separated by lines that start with "From " (with space)
  // at the start of a line. Per RFC 4155, body lines starting with "From "
  // are quoted as ">From " — so an unquoted "From " at BOL is the separator.
  const messages: string[] = [];
  const lines = content.split(/\r?\n/);
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('From ') && current.length > 0) {
      messages.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0 && current.some(l => l.trim() !== '')) {
    messages.push(current.join('\n'));
  }
  return messages;
}

export function parseMessage(raw: string): ParsedMessage {
  const lines = raw.split(/\r?\n/);
  // Drop leading envelope "From ..." line if present
  let start = 0;
  if (lines[0]?.startsWith('From ')) start = 1;

  const headers = new Map<string, string>();
  let i = start;
  let lastKey: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') break; // end of headers
    if (/^[ \t]/.test(line) && lastKey) {
      // continuation of previous header
      headers.set(lastKey, (headers.get(lastKey) ?? '') + ' ' + line.trim());
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).toLowerCase();
    const value = line.slice(idx + 1).trim();
    // Gmail mbox sometimes has duplicate Received headers etc — keep first
    if (!headers.has(key)) headers.set(key, value);
    lastKey = key;
  }
  const body = lines.slice(i + 1).join('\n');
  return { headers, body };
}

export function extractEmailAddress(from: string): string {
  // "Name <addr@host>" or "addr@host" or "addr@host (Name)"
  const angle = from.match(/<([^>]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  const paren = from.match(/^([^\s(]+)/);
  if (paren) return paren[1].trim().toLowerCase();
  return from.trim().toLowerCase();
}

export function shouldDrop(
  msg: ParsedMessage,
  keep: string[],
): { drop: boolean; reason: 'noreply' | 'unsubscribe' | 'calendar' | null } {
  const from = msg.headers.get('from') ?? '';
  const email = extractEmailAddress(from);
  const keepMatch = keep.some(k => email.includes(k));
  if (keepMatch) return { drop: false, reason: null };

  const contentType = msg.headers.get('content-type') ?? '';
  if (/^text\/calendar/i.test(contentType)) {
    return { drop: true, reason: 'calendar' };
  }

  if (msg.headers.has('list-unsubscribe')) {
    return { drop: true, reason: 'unsubscribe' };
  }

  if (NOREPLY_PATTERN.test(email)) {
    return { drop: true, reason: 'noreply' };
  }

  return { drop: false, reason: null };
}

export function decodeBody(msg: ParsedMessage): string {
  const encoding = (msg.headers.get('content-transfer-encoding') ?? '')
    .toLowerCase()
    .trim();
  const contentType = msg.headers.get('content-type') ?? '';

  // For multipart, grab the first text/plain part. Falls through to raw body
  // if we can't find one — this is a pre-filter, not a perfect MIME parser.
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
  let body = msg.body;
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = body.split(new RegExp(`--${escapeRegex(boundary)}`));
    const plain = parts.find(p => /content-type:\s*text\/plain/i.test(p));
    if (plain) {
      const bodyStart = plain.search(/\r?\n\r?\n/);
      if (bodyStart !== -1) body = plain.slice(bodyStart).trimStart();
    }
  }

  if (encoding === 'quoted-printable') {
    body = decodeQuotedPrintable(body);
  } else if (encoding === 'base64') {
    try {
      body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
    } catch {
      // leave as-is if base64 invalid
    }
  }
  return body;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, '') // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

export function stripQuotedReplies(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  let sawQuoteMarker = false;
  for (const line of lines) {
    // "On Mon, Jan 1, 2020 at 3:45 PM, Someone <x@y> wrote:" → everything after
    // is a quoted reply. Crude but effective.
    if (/^On .{5,60}\bwrote:\s*$/.test(line.trim())) {
      sawQuoteMarker = true;
      continue;
    }
    if (sawQuoteMarker) continue;
    if (/^>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

export function sanitizeSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function parseDate(raw: string | undefined): Date {
  if (!raw) return new Date(0);
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

export function messageToMarkdown(msg: ParsedMessage): {
  path: string;
  content: string;
} | null {
  const from = msg.headers.get('from') ?? '';
  const to = msg.headers.get('to') ?? '';
  const subject = msg.headers.get('subject') ?? '(no subject)';
  const date = parseDate(msg.headers.get('date'));
  const messageId =
    msg.headers.get('message-id') ??
    createHash('sha1').update(from + subject + date.toISOString()).digest('hex');

  const decoded = decodeBody(msg);
  const stripped = stripQuotedReplies(decoded);
  if (stripped.trim().length === 0) return null;

  const yyyy = date.getUTCFullYear().toString().padStart(4, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const slug = sanitizeSlug(subject) || 'message';
  const hash = createHash('sha1').update(messageId).digest('hex').slice(0, 8);
  const path = join(yyyy, mm, `${slug}-${hash}.md`);

  const esc = (v: string) => v.replace(/"/g, '\\"');
  const content =
    `---\n` +
    `type: email\n` +
    `date: ${date.toISOString()}\n` +
    `from: "${esc(from)}"\n` +
    `to: "${esc(to)}"\n` +
    `subject: "${esc(subject)}"\n` +
    `message_id: "${esc(messageId)}"\n` +
    `---\n\n` +
    `# ${subject}\n\n` +
    `**From:** ${from}\n**To:** ${to}\n**Date:** ${date.toISOString()}\n\n` +
    stripped +
    '\n';
  return { path, content };
}

function main(): void {
  const { input, outputDir, keep } = parseArgs(process.argv.slice(2));
  const raw = readFileSync(input, 'utf-8');
  const messages = splitMbox(raw);
  const stats: Stats = {
    total: messages.length,
    droppedNoreply: 0,
    droppedUnsubscribe: 0,
    droppedCalendar: 0,
    droppedEmptyBody: 0,
    kept: 0,
  };

  for (const raw of messages) {
    const msg = parseMessage(raw);
    const { drop, reason } = shouldDrop(msg, keep);
    if (drop) {
      if (reason === 'noreply') stats.droppedNoreply++;
      else if (reason === 'unsubscribe') stats.droppedUnsubscribe++;
      else if (reason === 'calendar') stats.droppedCalendar++;
      continue;
    }
    const emitted = messageToMarkdown(msg);
    if (!emitted) {
      stats.droppedEmptyBody++;
      continue;
    }
    const fullPath = join(outputDir, emitted.path);
    mkdirSync(join(outputDir, emitted.path.split('/').slice(0, -1).join('/')), {
      recursive: true,
    });
    writeFileSync(fullPath, emitted.content);
    stats.kept++;
  }

  const droppedTotal =
    stats.droppedNoreply +
    stats.droppedUnsubscribe +
    stats.droppedCalendar +
    stats.droppedEmptyBody;
  const pct = stats.total
    ? ((droppedTotal / stats.total) * 100).toFixed(1)
    : '0';
  console.log(
    `mbox filter: ${stats.total} messages, ${droppedTotal} dropped (${pct}%), ${stats.kept} kept`,
  );
  console.log(
    `  dropped: noreply=${stats.droppedNoreply} unsubscribe=${stats.droppedUnsubscribe} calendar=${stats.droppedCalendar} empty=${stats.droppedEmptyBody}`,
  );
  console.log(`  next: gbrain sync ${outputDir}`);
}

if (import.meta.main) {
  main();
}
