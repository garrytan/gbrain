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
 * All-or-nothing. Both integrity checks below run BEFORE the first write, so a
 * refused import leaves no partial output behind to be mistaken for a whole one.
 *
 *   1. Declared counts. envelope-v0 requires `meta.conversation_count` and
 *      `meta.message_count`: the envelope states its own totals. Each is judged
 *      on its own. One that disagrees with what the file actually contains, or
 *      that is present but is not a non-negative integer, refuses the import
 *      (exit 2) — a mismatch means the envelope is truncated, hand-edited, or
 *      from a broken converter, and nothing here can tell which part is
 *      missing. A count that is simply absent cannot be checked against
 *      anything; the envelope imports, and stderr names the field whose half of
 *      the check was skipped.
 *   2. Existing target files. A file already occupying a target filename is
 *      only overwritten when it is safe: byte-identical content (a re-import),
 *      or a page this importer wrote from the SAME conversation id (a refreshed
 *      export legitimately updating its own page). Anything else — a foreign
 *      file, or one of our pages whose conversation id cannot be matched — is a
 *      conflict, and the import is refused (exit 2).
 *
 * Output layout:
 *   - One page per conversation, filename = date + conversation id (shared
 *     titles cannot collide; the id is the natural key). A duplicate id
 *     overwrites its own filename and warns on stderr; stdout reports DISTINCT
 *     files written, not write calls.
 *   - `id` is `string | null` in envelope-v0 and a converter must not synthesize
 *     one, so null is a conforming shape, not malformed input. Such a
 *     conversation falls back to a POSITIONAL filename (`conv-N`) — a function
 *     of array position, not of identity. That is precisely why check 2 refuses
 *     to overwrite an id-less page: two unrelated exports both put their first
 *     conversation at `conv-1`, and nothing in either file can distinguish
 *     "this conversation, updated" from "a different conversation entirely".
 *   - Frontmatter: `type: conversation` (keeps pages eligible for
 *     conversation-facts extraction and chronicle behavior after sync), the
 *     source provider, the conversation id, and `origin: memvelope/envelope-v0`.
 *   - Page `date` is the first 10 chars of the conversation's ISO-8601
 *     `created_at`. Body keeps message-id citations beside each speaker turn.
 *
 * The stdout receipt reports MESSAGES as well as pages. Counting only pages hid
 * every message-level loss by construction: a conversation that arrives with
 * one turn instead of forty still writes exactly one page.
 *
 * Exit codes: 0 success · 1 usage or unrecognized format · 2 refused import
 * (declared-count mismatch, or a target file that must not be overwritten).
 *
 * Known limits:
 *   - Check 2 is check-then-write, not atomic. Two imports running
 *     SIMULTANEOUSLY into one directory can both pass the check before either
 *     writes, and one then clobbers the other. Measured 2026-08-02 over three
 *     independent sets of 40 trials of two concurrent conflicting imports: 19,
 *     22, and 24 refused out of 40 — roughly half, and it is a race, so expect
 *     the number to move. Against the previous script the same experiment
 *     refused 0 of 40. Closing it needs a lock file, which is a larger change
 *     than this guard. Sequential runs are what this CLI is for, and are what
 *     check 2 covers.
 *   - An id-less conversation cannot be REFRESHED in place. A changed re-import
 *     of an `id: null` export is refused rather than applied, because nothing
 *     in either file distinguishes it from a different conversation at the same
 *     array position. Import it into a fresh directory. This is a deliberate
 *     trade: the same ambiguity, resolved the other way, is what silently
 *     destroyed the earlier import.
 *   - Identity is matched on the conversation id alone, while the filename is
 *     date + id. A conversation whose `created_at` changes between exports
 *     therefore lands on a NEW filename and orphans its earlier page rather
 *     than updating it — duplication, not loss, and true of this script before
 *     these guards existed too.
 *   - A file carrying this importer's own frontmatter shape is treated as this
 *     importer's page. There is no signature, so a hand-written lookalike is
 *     indistinguishable from the real thing.
 *
 * Memory: the whole envelope is held in memory (no streaming); envelopes are
 * far smaller than the vendor exports they serialize.
 *
 * Verify:
 *   node scripts/envelope-to-gbrain.mjs test/fixtures/memvelope/sample.mve.json /tmp/out
 *     -> expect "wrote 1 markdown page(s) (4 message(s))"
 *   bun test test/envelope-to-gbrain.test.ts
 *
 * STATUS:
 *   - 2026-07-03, pre-guard behavior, live-verified against gbrain v0.42.56.0:
 *     the sample fixture -> 1 page; a real 662MB Claude export -> 353
 *     conversations = 353 distinct pages (no collisions), searchable after sync
 *     with provenance and message-id citations intact.
 *   - 2026-08-02, the two guards above: verified against all 12 golden fixtures
 *     from the memvelope reference converter and against fresh envelopes
 *     produced by running that converter over synthetic ChatGPT and Claude
 *     exports. All 19 import at exit 0 with zero stderr bytes, and 18 of them
 *     reproduce every message text byte-verbatim. The exception is the
 *     lone-surrogate golden fixture, where an unpaired `U+D800` becomes
 *     `U+FFFD` on UTF-8 write — behavior of `writeFileSync`, unchanged by these
 *     guards and identical on the previous script. Neither guard has been run
 *     against a full-size real export.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const EXIT_REFUSED = 2;

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

/** The file's contents, or null if it does not exist. Any other error is the
 *  caller's problem to fail on — an unreadable target must never be silently
 *  treated as an absent one, because "absent" is the answer that permits a
 *  write. */
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** The conversation identity recorded in a page this importer previously wrote,
 *  or null if the file is not recognizably one of ours.
 *
 *  A deliberate line scan of our own emitted shape rather than a YAML parse:
 *  this script has no dependencies, and anything it cannot confidently
 *  recognize must fall through to "foreign" — the answer that refuses the
 *  overwrite. `{ id: null }` means "ours, but written from a conversation that
 *  carried no id", which is a different thing from "not ours" and must not be
 *  collapsed into it. */
function existingPageIdentity(raw) {
  // A page we wrote can pick up cosmetic byte changes without ceasing to be
  // ours: a git checkout with core.autocrlf, a cross-platform sync, an editor
  // that adds a BOM. Refusing to recognize those made a whole envelope
  // unimportable over a line ending, so normalize them away before the scan.
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return null;
  const ID_KEY = 'memvelope_conversation_id: ';
  let ours = false;
  let id = null;
  for (const line of text.slice(4, end).split('\n')) {
    if (line === 'origin: memvelope/envelope-v0') {
      ours = true;
    } else if (line.startsWith(ID_KEY)) {
      try {
        const value = JSON.parse(line.slice(ID_KEY.length));
        if (typeof value !== 'string') return null;
        id = value;
      } catch {
        return null;
      }
    }
  }
  return ours ? { id } : null;
}

const conversations = env.conversations || [];

// ---------------------------------------------------------------------------
// Check 1 — the envelope's own declared counts, before anything is written.
//
// Each count is judged on its own. Treating "either field exists" as "the
// envelope is checkable" gave a half-declared envelope a half check and total
// silence, which is the very defect this guard exists to close.
// ---------------------------------------------------------------------------

/** How a declared count is to be read: a usable number, absent, or present but
 *  not a count at all. The third case must not collapse into the second —
 *  saying "declares no count" about a file that declares a broken one is a
 *  false statement, and it would be printed over a real truncation. */
function readDeclaredCount(value) {
  if (value === undefined) return { state: 'absent' };
  if (Number.isInteger(value) && value >= 0) return { state: 'declared', value };
  return { state: 'malformed' };
}

const actualConversations = conversations.length;
const actualMessages = conversations.reduce((sum, c) => sum + (c.messages || []).length, 0);
const counts = [
  { field: 'meta.conversation_count', raw: env.meta?.conversation_count, actual: actualConversations },
  { field: 'meta.message_count', raw: env.meta?.message_count, actual: actualMessages },
].map((c) => ({ ...c, ...readDeclaredCount(c.raw) }));

const malformed = counts.filter((c) => c.state === 'malformed');
if (malformed.length) {
  // envelope-v0 types both counts as non-negative integers. A count that is
  // present but is not one cannot be compared, and an envelope this malformed
  // is not a file to trust with an unchecked import.
  console.error('refusing to import: the envelope declares a count that is not a non-negative integer.');
  for (const c of malformed) console.error(`  ${c.field} = ${JSON.stringify(c.raw)}`);
  console.error('Nothing was written. Re-export, or correct the declared counts if the contents are known-good.');
  process.exit(EXIT_REFUSED);
}

const mismatched = counts.filter((c) => c.state === 'declared' && c.value !== c.actual);
if (mismatched.length) {
  // Fail closed. The counts are the envelope's own statement of what it holds,
  // and they disagree with what it holds — so the file is not what it claims,
  // and nothing here can tell which conversations or turns went missing. A
  // partial import that exits 0 is how an archive silently becomes a fragment.
  console.error("refusing to import: the envelope's declared counts disagree with its contents.");
  // Print both counts, not only the failing one: seeing which half agrees is
  // what tells a truncated download apart from a broken converter.
  for (const c of counts) {
    const declared = c.state === 'declared' ? c.value : 'not declared';
    console.error(`  ${c.field} declared ${declared}, envelope contains ${c.actual}`);
  }
  console.error('This envelope is truncated, hand-edited, or from a broken converter. Nothing was written. Re-export, or correct the declared counts if the contents are known-good.');
  process.exit(EXIT_REFUSED);
}

const absent = counts.filter((c) => c.state === 'absent');
if (absent.length) {
  // envelope-v0 requires both fields, so this file is already non-conforming.
  // Import it anyway — hand-authored envelopes are useful — but never let an
  // unchecked import look identical to a checked one on the way past. Naming
  // the missing field matters: with one count present, only half the envelope
  // was verified, and the receipt alone cannot show which half.
  console.warn(
    `warning: envelope declares no ${absent.map((c) => c.field).join(' and no ')} (envelope-v0 requires both) — integrity check skipped for ${absent.length === 2 ? 'conversations and messages' : absent[0].field.replace('meta.', '').replace('_count', 's')}; a truncated envelope would import silently.`,
  );
}

// ---------------------------------------------------------------------------
// Render every page in memory first. Rendering has no side effects, so the
// conflict check below can see the complete set of target files — including the
// final content of any filename an envelope writes more than once — while the
// output directory is still untouched.
// ---------------------------------------------------------------------------
const pages = new Map();
let collisions = 0;
for (const [i, c] of conversations.entries()) {
  const date = (c.created_at || '').slice(0, 10);
  // Name the file by the conversation's own id — the natural unique key — so two
  // conversations that share a date and title can never silently overwrite each
  // other. The date only leads as a human/chronological sort prefix; the id
  // carries uniqueness. Positional fallback keeps names unique and deterministic
  // when an envelope omits an id.
  // One predicate for "this conversation carries its own id", shared by the
  // filename, the frontmatter below, and the conflict check further down.
  // Keeping it in a single place is what stops them disagreeing about whether
  // an id exists.
  const hasId = typeof c.id === 'string' && c.id.trim() !== '';
  const convId = hasId ? c.id.trim() : `conv-${i + 1}`;
  // `date` is third-party, exactly like `convId`, so it gets the same slug()
  // treatment. Interpolating it raw let a `created_at` of `../…` resolve the
  // join below outside outDir and write there.
  const name = `${slug(date, '0000-00-00')}-${slug(convId, `conv-${i + 1}`)}.md`;
  // gbrain reads YAML frontmatter + markdown body; keep provenance in frontmatter.
  // Emit `type: conversation` so gbrain stores these as conversation pages rather
  // than defaulting to the generic `concept`. gbrain is open-typed — it takes an
  // explicit frontmatter `type` verbatim — and its conversation-aware features
  // (conversation-facts extraction, the conversation_format_coverage check,
  // chronicle eligibility) key off `type == 'conversation'`.
  const front = [
    '---',
    'type: conversation',
    // Every interpolated value below is quoted. An envelope is a third-party
    // file, so any string carrying a newline would otherwise close its scalar
    // and inject arbitrary frontmatter keys into the page gbrain ingests — or
    // duplicate an existing key, which makes the parse throw and silently
    // strips every provenance field from the page.
    `title: ${JSON.stringify(c.title || 'Untitled conversation')}`,
    // `date` is the first 10 chars of the envelope's `created_at`; 10 is plenty
    // to smuggle a newline plus a short key. Absent stays an unquoted YAML null.
    `date: ${date ? JSON.stringify(date) : 'null'}`,
    `source: ${JSON.stringify(env.meta?.source_provider || 'unknown')}`,
    // Omit the key entirely when the envelope carries no id, rather than
    // emitting the literal `undefined` or a synthesized `conv-N` — the positional
    // fallback names the file, but it is not a memvelope conversation id and
    // must not be recorded as one.
    // The id VERBATIM, not the trimmed form used for the filename. The spec has
    // converters copy ids exactly, and recording the trimmed one made two ids
    // differing only by surrounding whitespace indistinguishable on disk — so
    // the conflict check below read them as one conversation and let the second
    // import destroy the first.
    ...(hasId ? [`memvelope_conversation_id: ${JSON.stringify(c.id)}`] : []),
    'origin: memvelope/envelope-v0',
    '---',
    '',
  ].join('\n');
  const messages = c.messages || [];
  const body = messages
    .map((m) => `**${m.role === 'user' ? 'Me' : 'Assistant'}** (${m.ts || 'no timestamp'} · ${m.id}):\n\n${m.text}`)
    .join('\n\n---\n\n');
  // Never lose a page silently: if two conversations still map to the same
  // filename (e.g. an envelope carrying duplicate ids — which the spec permits,
  // since merging never deduplicates), warn loudly instead of overwriting in
  // silence, and report the count of DISTINCT files written — not the number of
  // write calls, which is what hid the old title-collision bug.
  if (pages.has(name)) {
    collisions += 1;
    console.warn(`warning: filename collision on "${name}" — conversation id ${JSON.stringify(c.id)} is not unique; overwriting the earlier page.`);
  }
  pages.set(name, {
    content: front + `# ${c.title || 'Conversation'}\n\n` + body + '\n',
    messageCount: messages.length,
    // The conversation's OWN id, verbatim, or null. Never the positional
    // fallback: that is a filename, not an identity, and treating it as one is
    // the whole bug. Verbatim rather than trimmed for the same reason — see the
    // frontmatter note above.
    conversationId: hasId ? c.id : null,
  });
}

// ---------------------------------------------------------------------------
// Check 2 — target files that already exist and were not written by this run.
// `pages` is per-process and the default outDir is a fixed literal, so without
// this a second import into the same directory clobbered the first in silence.
// Only the exact target filenames are examined: unrelated markdown sitting in
// the output directory is none of this script's business.
// ---------------------------------------------------------------------------
const conflicts = [];
for (const [name, page] of pages) {
  const existing = readIfPresent(join(outDir, name));
  // Absent, or already exactly what we are about to write (a re-import of the
  // same envelope). Rewriting identical bytes changes nothing.
  if (existing === null || existing === page.content) continue;
  const identity = existingPageIdentity(existing);
  if (identity === null) {
    // Say what is true — the file was not recognized. Asserting that this
    // importer did not write it is a claim this code is in no position to make,
    // and it is wrong for any page of ours that has been edited since.
    conflicts.push(`  ${name} — already exists and could not be recognized as a page written by this importer.`);
  } else if (identity.id === null) {
    // Ours, but written from an id-less conversation, so its filename encodes
    // array position rather than identity. An update and a wholly different
    // conversation are indistinguishable here; guessing either way risks
    // destroying an import.
    conflicts.push(`  ${name} — written by this importer from a conversation with no id, so it cannot be matched to this envelope's conversation. Refusing to guess.`);
  } else if (identity.id !== page.conversationId) {
    // Distinct ids that slug to one filename (truncation at 60 chars, or
    // characters that slug away). Rare, but silently fatal if permitted.
    conflicts.push(`  ${name} — holds conversation ${JSON.stringify(identity.id)}, but this envelope maps ${JSON.stringify(page.conversationId)} to the same filename.`);
  }
  // Otherwise: same conversation id, different content — a refreshed export
  // updating its own page. That is exactly what re-importing is for.
}

if (conflicts.length) {
  console.error(`refusing to import: ${conflicts.length} target file(s) in ${outDir} would be overwritten with different content.`);
  for (const line of conflicts) console.error(line);
  console.error('Nothing was written. Import into a different output directory, or delete the listed file(s) if they are stale.');
  process.exit(EXIT_REFUSED);
}

// ---------------------------------------------------------------------------
// Write. Everything above has already passed, so this loop cannot refuse.
// ---------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
let messagesWritten = 0;
for (const [name, page] of pages) {
  writeFileSync(join(outDir, name), page.content);
  messagesWritten += page.messageCount;
}

console.log(`wrote ${pages.size} markdown page(s) (${messagesWritten} message(s)) to ${outDir} — point gbrain's sync at this directory.`);
if (collisions) {
  console.warn(`warning: ${collisions} filename collision(s) — ${collisions} page(s) overwritten. Deduplicate conversation ids in the envelope to avoid data loss.`);
}
if (messagesWritten !== actualMessages) {
  // The page count alone cannot show this: an overwritten page still leaves one
  // file on disk, so only the message tally reveals the turns that went with it.
  //
  // Worded as a fact about the overwritten pages, not as an announcement of
  // loss. Duplicate ids are conforming input — the spec has merging never
  // deduplicate — so converting an old export together with a newer one, which
  // is what the memvelope CLI tells users to do, lands here routinely with the
  // surviving page already holding every unique turn. An alarm that cries wolf
  // on the mainstream path teaches its reader to ignore the one that matters.
  console.warn(`warning: the overwritten page(s) carried ${actualMessages - messagesWritten} message(s) that are not on disk (${actualMessages} read, ${messagesWritten} written). If they were earlier copies of the same conversation, the surviving page may already contain those turns; if not, this is real loss.`);
}
