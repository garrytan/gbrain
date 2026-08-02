#!/usr/bin/env node
/**
 * Export gbrain conversation pages to an envelope-v0 file (a JSON serialization
 * of AI chat history; format spec: github.com/memvelope/memvelope). The
 * counterpart of scripts/envelope-to-gbrain.mjs - that script reads the format,
 * this one writes it.
 *
 * Usage:
 *   node scripts/gbrain-to-envelope.mjs <pagesDir> [out.mve.json]
 *
 * Zero dependencies. Deterministic. No network. It does NOT call gbrain - it
 * only reads Markdown files. Point it at a `gbrain export --dir` output tree, at
 * a brain repo, or at the directory envelope-to-gbrain.mjs wrote.
 *
 * Input selection:
 *   - Walks <pagesDir> recursively for *.md, in sorted path order. Dot
 *     directories are skipped.
 *   - Takes only pages whose frontmatter `type` is `conversation`. Everything
 *     else is skipped and counted on stderr.
 *   - Reads turns out of the body in the shape envelope-to-gbrain.mjs writes:
 *     `**Me** (<ts> · <message id>):` and `**Assistant** (...)`. A page whose
 *     body no longer carries those headers yields no messages and is skipped:
 *     envelope-v0 requires at least one message per conversation.
 *   - The body is cut at the `<!-- timeline -->` sentinel that
 *     src/core/markdown.ts writes, so a page's timeline never becomes message
 *     text.
 *   - Frontmatter is read line by line, top-level plain scalars only. A block
 *     scalar (`key: |`) is treated as absent rather than guessed at. That is
 *     enough for the six keys the importer writes and avoids a YAML dependency.
 *
 * What survives the round trip envelope -> envelope-to-gbrain.mjs -> here. On
 * test/fixtures/memvelope/sample.mve.json the output is deep-equal to the
 * input, which covers:
 *   - conversation id and title
 *   - message id, role, timestamp and text, verbatim
 *   - meta.source_provider
 *   - meta.conversation_count and meta.message_count, recomputed and equal
 * A probe envelope built to carry the cases the fixture does not adds:
 *   - a null conversation id, which stays null
 *   - a `---` rule inside a message, and a message that ends on one
 *
 * What does not survive. Each of these was measured on a probe envelope built
 * to carry it, not assumed:
 *   - `conversation.created_at` and `conversation.updated_at`. The page keeps
 *     only `date`, the first 10 characters of created_at, which is a day and
 *     not a date-time. Both fields are taken here from the first and last
 *     message timestamps instead. A conversation whose created_at was
 *     09:00:00Z with a first message at 10:00:00Z comes back as 10:00:00Z, and
 *     one whose first message has no timestamp comes back null.
 *   - `meta.source_export_date`. Never written to a page. Omitted here, which
 *     is what the spec asks for when the value is unknown.
 *   - Any other key. envelope-v0 allows additional properties at every level,
 *     the page carries none of them, and they are gone at meta, conversation
 *     and message level alike.
 *   - Conversation order. Output follows sorted file path, so a conversation
 *     listed first but dated last moves to the end.
 *   - Leading and trailing whitespace in message text, trimmed.
 *   - A message that is only whitespace. Dropped, with a warning, because
 *     envelope-v0 requires text of at least one character. meta.message_count
 *     follows what was written, so it drops too.
 *   - Anything before the first turn header, including the `# Title` heading.
 *   - Text that itself contains a line shaped like a turn header. It splits
 *     into two messages, and the second one's id comes from that line.
 *   - CRLF line endings, normalized to LF on read.
 *   - One source_provider per file. An envelope names a single provider, so a
 *     page set spanning several keeps the first in sorted path order and warns.
 *
 * A page with no `memvelope_conversation_id` emits `id: null` rather than a
 * synthesized id. envelope-v0 permits null there and tells converters not to
 * invent one.
 *
 * Memory: the whole page set is held in memory (no streaming), same posture as
 * the importer.
 *
 * Verify:
 *   node scripts/envelope-to-gbrain.mjs test/fixtures/memvelope/sample.mve.json /tmp/pages
 *   node scripts/gbrain-to-envelope.mjs /tmp/pages /tmp/out.mve.json
 *     -> expect "wrote 1 conversation(s), 4 message(s)"
 *   bun test test/gbrain-to-envelope.test.ts
 *
 * STATUS: verified against gbrain v0.42.72.1 on 2026-08-02. The sample fixture
 * round-trips through the importer and back deep-equal, and the output
 * validates against the published envelope-v0 JSON Schema. It also round-trips
 * deep-equal the long way: imported, put into a PGLite brain, written back out
 * by `gbrain export --dir`, then read here. That path rewrites the frontmatter
 * quoting and key order and leaves the body alone, so the turn headers survive
 * the trip through the database.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [, , pagesDir, outPath = './envelope.mve.json'] = process.argv;
if (!pagesDir) {
  console.error('usage: node gbrain-to-envelope.mjs <pagesDir> [out.mve.json]');
  process.exit(1);
}

let dirStat;
try {
  dirStat = statSync(pagesDir);
} catch {
  console.error(`cannot read ${pagesDir}`);
  process.exit(1);
}
if (!dirStat.isDirectory()) {
  console.error(`${pagesDir} is not a directory`);
  process.exit(1);
}

// Sorted at every level, so the output is a function of the page set and not of
// the order the filesystem hands back. `gbrain export` writes nested by slug,
// the importer writes flat; both are covered by the same walk.
function markdownFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

// Frontmatter is the block between the first `---` line and the next one. A
// page without that block is not a gbrain page and is skipped rather than
// guessed at.
function splitPage(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') return null;
  const close = lines.indexOf('---', 1);
  if (close === -1) return null;
  return { front: lines.slice(1, close), body: lines.slice(close + 1).join('\n') };
}

// Top-level plain scalars only. gbrain writes these through js-yaml, which
// quotes with single quotes; the importer writes them through JSON.stringify,
// which quotes with double quotes. Both are read here, along with the unquoted
// form. Indented lines belong to a nested value and never match, so a list or a
// block scalar cannot contribute a key.
function parseFrontmatter(lines) {
  const out = {};
  for (const line of lines) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*): ?(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim();
    if (raw === '' || raw === '|' || raw === '|-' || raw === '>' || raw === '>-') continue;
    if (raw === 'null' || raw === '~') {
      out[key] = null;
      continue;
    }
    if (raw.startsWith('"')) {
      try {
        out[key] = JSON.parse(raw);
        continue;
      } catch {
        // Fall through to the raw form rather than dropping the field.
      }
    }
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      out[key] = raw.slice(1, -1).replace(/''/g, "'");
      continue;
    }
    out[key] = raw;
  }
  return out;
}

// The turn header the importer writes. The timestamp group is lazy so the first
// middle dot separates it from the message id, which leaves an id free to
// contain one.
const TURN_HEADER = /^\*\*(Me|Assistant)\*\* \((.*?) · (.*)\):$/gm;
const TIMELINE_SENTINEL = '<!-- timeline -->';

function readMessages(body, onEmpty) {
  const sentinel = body.indexOf(TIMELINE_SENTINEL);
  const text = sentinel === -1 ? body : body.slice(0, sentinel);
  const headers = [...text.matchAll(TURN_HEADER)];
  const messages = [];
  for (const [i, h] of headers.entries()) {
    const start = h.index + h[0].length;
    const end = i + 1 < headers.length ? headers[i + 1].index : text.length;
    let raw = text.slice(start, end);
    // Between two turns the importer writes exactly one `---` separator line.
    // Strip that one occurrence, never a `---` the message itself ended with
    // after the last turn.
    if (i + 1 < headers.length) raw = raw.replace(/\n\n---\n\n$/, '');
    const messageText = raw.trim();
    if (messageText === '') {
      onEmpty(h[3]);
      continue;
    }
    messages.push({
      id: h[3],
      role: h[1] === 'Me' ? 'user' : 'assistant',
      // The importer writes the literal `no timestamp` when the envelope had
      // none. Read it back as the null the schema asks for, not as prose.
      ts: h[2] === 'no timestamp' ? null : h[2],
      text: messageText,
    });
  }
  return messages;
}

const files = markdownFiles(pagesDir);
const conversations = [];
const providers = [];
const seenIds = new Set();
let skippedNotConversation = 0;
let skippedNoFrontmatter = 0;
let skippedNoMessages = 0;
let droppedEmptyMessages = 0;
let messageCount = 0;

for (const file of files) {
  // Normalize to LF up front. Every match below is line-anchored, so a page
  // saved with CRLF would otherwise fail to parse as a whole and be reported as
  // frontmatter-less. The cost is stated in the header: CRLF inside a message
  // comes back as LF.
  const page = splitPage(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  if (!page) {
    skippedNoFrontmatter += 1;
    continue;
  }
  const front = parseFrontmatter(page.front);
  if (front.type !== 'conversation') {
    skippedNotConversation += 1;
    continue;
  }
  const messages = readMessages(page.body, (id) => {
    droppedEmptyMessages += 1;
    console.warn(`warning: ${file} - message ${JSON.stringify(id)} has no text; dropped (envelope-v0 requires at least one character).`);
  });
  if (messages.length === 0) {
    skippedNoMessages += 1;
    console.warn(`warning: ${file} - no speaker turns found; skipped (envelope-v0 requires at least one message per conversation).`);
    continue;
  }
  if (typeof front.source === 'string' && front.source !== '') providers.push(front.source);
  // Never synthesize. An absent id is null, which the schema permits and the
  // spec requires of converters.
  const id = typeof front.memvelope_conversation_id === 'string' ? front.memvelope_conversation_id : null;
  // envelope-v0 says ids should be unique within an envelope and that consumers
  // must tolerate duplicates. Emit both conversations and say so, rather than
  // dropping one to keep the field clean.
  if (id !== null && seenIds.has(id)) {
    console.warn(`warning: ${file} - conversation id ${JSON.stringify(id)} already used by another page; both are emitted.`);
  }
  if (id !== null) seenIds.add(id);
  conversations.push({
    id,
    title: typeof front.title === 'string' && front.title !== '' ? front.title : 'Untitled conversation',
    // The page's `date` is a day, not a date-time, so it cannot fill these.
    // First and last message timestamps are the only date-times on the page.
    created_at: messages[0].ts,
    updated_at: messages[messages.length - 1].ts,
    messages,
  });
  messageCount += messages.length;
}

const distinctProviders = [...new Set(providers)];
if (distinctProviders.length > 1) {
  console.warn(`warning: pages name ${distinctProviders.length} source providers (${distinctProviders.join(', ')}); an envelope carries one. Using ${JSON.stringify(distinctProviders[0])}.`);
}
const envelope = {
  memvelope: 'envelope-v0',
  meta: {
    source_provider: distinctProviders[0] || 'unknown',
    conversation_count: conversations.length,
    message_count: messageCount,
  },
  conversations,
};

writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n');
console.log(`wrote ${conversations.length} conversation(s), ${messageCount} message(s) to ${outPath}`);
// Every page that did not become a conversation is accounted for on stderr, so
// a mistargeted directory reads as a diagnosis rather than an empty file.
if (skippedNoFrontmatter || skippedNotConversation || skippedNoMessages || droppedEmptyMessages) {
  console.warn(`scanned ${files.length} markdown file(s): ${skippedNoFrontmatter} without frontmatter, ${skippedNotConversation} not type conversation, ${skippedNoMessages} without speaker turns, ${droppedEmptyMessages} empty message(s) dropped.`);
}
