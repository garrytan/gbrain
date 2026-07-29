#!/usr/bin/env node
/**
 * Import an envelope-v0 file (a JSON serialization of AI chat history; format
 * spec: github.com/memvelope/memvelope) into a brain repo as one Markdown page
 * per conversation, which `gbrain sync` ingests.
 *
 * Usage:
 *   node scripts/envelope-to-gbrain.mjs <envelope.mve.json> [outDir]
 *
 * Zero dependencies. Deterministic. No network. It does NOT call gbrain — it
 * only writes Markdown files.
 *
 * Output layout:
 *   - One page per conversation, filename = date + conversation id (shared
 *     titles cannot collide; the id is the natural key). A duplicate id
 *     overwrites its own filename and warns on stderr; stdout reports DISTINCT
 *     files written, not write calls.
 *   - Frontmatter: `type: conversation` (keeps pages eligible for
 *     conversation-facts extraction and chronicle behavior after sync), the
 *     source provider, the conversation id, and `origin: memvelope/envelope-v0`.
 *   - Page `date` is the first 10 chars of the conversation's ISO-8601
 *     `created_at`. Body keeps message-id citations beside each speaker turn.
 *
 * Memory: the whole envelope is held in memory (no streaming); envelopes are
 * far smaller than the vendor exports they serialize.
 *
 * Verify:
 *   node scripts/envelope-to-gbrain.mjs test/fixtures/memvelope/sample.mve.json /tmp/out
 *     -> expect "wrote 1 markdown page(s)"
 *   bun test test/envelope-to-gbrain.test.ts
 *
 * STATUS: live-verified against gbrain v0.42.56.0 on 2026-07-03: the sample
 * fixture -> 1 page; a real 662MB Claude export -> 353 conversations = 353
 * distinct pages (no collisions), searchable after sync with provenance and
 * message-id citations intact.
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
  // One predicate for "this conversation carries its own id", shared by the
  // filename and the frontmatter below. Keeping it in a single place is what
  // stops the two from disagreeing about whether an id exists.
  const hasId = typeof c.id === 'string' && c.id.trim() !== '';
  const convId = hasId ? c.id.trim() : `conv-${i + 1}`;
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
    // Every interpolated value is quoted. An envelope is a third-party file, so
    // a provider string carrying a newline would otherwise close this scalar and
    // inject arbitrary frontmatter keys into the page gbrain ingests.
    `source: ${JSON.stringify(env.meta?.source_provider || 'unknown')}`,
    // Omit the key entirely when the envelope carries no id, rather than
    // emitting the literal `undefined` or a synthesized `conv-N` — the positional
    // fallback names the file, but it is not a memvelope conversation id and
    // must not be recorded as one.
    ...(hasId ? [`memvelope_conversation_id: ${JSON.stringify(convId)}`] : []),
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
