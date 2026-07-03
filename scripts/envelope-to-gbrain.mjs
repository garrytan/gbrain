#!/usr/bin/env node
/**
 * Import a Memvelope envelope — a portable JSON export of AI chat history,
 * spec at github.com/memvelope/memvelope — into a brain repo as one Markdown
 * page per conversation, which `gbrain sync` ingests.
 *
 * Usage:
 *   node scripts/envelope-to-gbrain.mjs <envelope.mve.json> [outDir]
 *
 * Zero dependencies. Deterministic. No network. It does NOT call gbrain — it
 * only writes Markdown files.
 *
 * STATUS: live-verified. Validated end-to-end against gbrain v0.42.56.0 on
 * 2026-07-03: the sample envelope -> 1 page; a real 662MB Claude export -> 353
 * conversations = 353 distinct pages (no collisions), stored as
 * `type: conversation` with provenance and message-id citations intact.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , envelopePath, outDir = './brain/conversations'] = process.argv;
if (!envelopePath) {
  console.error('usage: node envelope-to-gbrain.mjs <envelope.mve.json> [outDir]');
  process.exit(1);
}

const env = JSON.parse(readFileSync(envelopePath, 'utf8'));
if (env.memvelope !== 'envelope-v0') {
  console.error(`not an envelope-v0 file (memvelope field = ${JSON.stringify(env.memvelope)})`);
  process.exit(1);
}

const slug = (s, fallback) =>
  (String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback).slice(0, 60);

mkdirSync(outDir, { recursive: true });
const filesWritten = new Set();
let collisions = 0;
const conversations = env.conversations || [];
for (const [i, c] of conversations.entries()) {
  const date = (c.created_at || '').slice(0, 10);
  // Name the file by the conversation's own id — the natural unique key — so two
  // conversations that share a date and title can never silently overwrite each
  // other. The date only leads as a human/chronological sort prefix; the id
  // carries uniqueness. Positional fallback keeps names unique and deterministic
  // when an envelope omits an id.
  const convId = (typeof c.id === 'string' && c.id.trim()) ? c.id.trim() : `conv-${i + 1}`;
  const name = `${date || '0000-00-00'}-${slug(convId, `conv-${i + 1}`)}.md`;
  // gbrain reads YAML frontmatter + markdown body; keep provenance in frontmatter.
  // Emit `type: conversation` so gbrain stores these as conversation pages rather
  // than defaulting to the generic `concept`. gbrain is open-typed — it takes an
  // explicit frontmatter `type` verbatim — and its conversation-aware features
  // (conversation-facts extraction, the conversation_format_coverage check,
  // chronicle eligibility) key off `type == 'conversation'`.
  const front = [
    '---',
    'type: conversation',
    `title: ${JSON.stringify(c.title || 'Untitled conversation')}`,
    `date: ${date || 'null'}`,
    `source: ${env.meta?.source_provider || 'unknown'}`,
    `memvelope_conversation_id: ${JSON.stringify(c.id)}`,
    'origin: memvelope/envelope-v0',
    '---',
    '',
  ].join('\n');
  const body = (c.messages || [])
    .map((m) => `**${m.role === 'user' ? 'Me' : 'Assistant'}** (${m.ts || 'no timestamp'} · ${m.id}):\n\n${m.text}`)
    .join('\n\n---\n\n');
  // Never lose a page silently: if two conversations still map to the same
  // filename (e.g. an envelope carrying duplicate ids), warn loudly instead of
  // overwriting in silence, and report the count of DISTINCT files written — not
  // the number of write calls, which is what hid the old title-collision bug.
  if (filesWritten.has(name)) {
    collisions += 1;
    console.warn(`warning: filename collision on "${name}" — conversation id ${JSON.stringify(c.id)} is not unique; overwriting the earlier page.`);
  }
  writeFileSync(join(outDir, name), front + `# ${c.title || 'Conversation'}\n\n` + body + '\n');
  filesWritten.add(name);
}
console.log(`wrote ${filesWritten.size} markdown page(s) to ${outDir} — point gbrain's sync at this directory.`);
if (collisions) {
  console.warn(`warning: ${collisions} filename collision(s) — ${collisions} page(s) overwritten. Deduplicate conversation ids in the envelope to avoid data loss.`);
}
