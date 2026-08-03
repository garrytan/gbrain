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
 *
 * TWO PAGE SHAPES, TOLD APART BY THE `messages:` FRONTMATTER KEY.
 *
 * The importer writes per-message identity into frontmatter:
 *
 *   messages:
 *     - id: "m1"
 *       ts: "2025-11-02T14:22:51.000Z"
 *
 * and a body whose turn headers carry a speaker and a minute-resolution UTC
 * wall clock, nothing else:
 *
 *   **Me** (2025-11-02 14:22):
 *
 * A page CARRYING the `messages:` key is read that way: `messages[i]` is the
 * i-th turn of the body, so the id and the full RFC 3339 `ts` come from the
 * array, and the body header supplies only the speaker and the text. A page
 * WITHOUT the key is read the legacy way the pre-2026-08-02 importer wrote:
 * `**Me** (<ts> · <message id>):`, identity parsed out of the header
 * parenthetical. The legacy path is unchanged; everything it got right it
 * still gets right, and everything prose could do to it - break a header with
 * a newline id, miss a match over one trailing space, forge a boundary with a
 * header-shaped line - it can still do. Those defects are CLOSED only on the
 * recorded path, because identity moved somewhere message text cannot reach.
 *
 * HOW A RECORDED PAGE'S TURNS ARE FOUND. The positional join is only sound if
 * the body anchors exactly as many turns as the array records, so boundaries
 * are not taken on shape alone. For each recorded message the expected header
 * clock is recomputed from its `ts` - the same derivation the importer used to
 * write it (headerClock below is copied verbatim from envelope-to-gbrain.mjs;
 * keep them in lockstep) - and a header-shaped line is a boundary ONLY when
 * its clock equals the clock expected for the next unfilled position. A
 * header-shaped line carrying any other clock is message text, reported on
 * stderr and kept in place. So forging a boundary from prose requires
 * predicting the next message's minute, not merely producing the shape - and
 * a page whose body still does not anchor one turn per recorded message is
 * SKIPPED, loudly, naming both numbers, rather than joined wrong.
 *
 * The recorded-path header is matched strictly - `**Me** (YYYY-MM-DD HH:MM):`
 * or `**Assistant** (...)`, two-digit fields, one space, no text after the
 * colon - with one tolerance: trailing spaces or tabs after the colon.
 * gbrain's own `imessage-slack` pattern (the one these headers are written
 * for) tolerates them too, and one trailing space added by an editor used to
 * absorb the whole turn into its neighbour in silence.
 *
 * What a recorded page REFUSES loudly (skipped, counted, named on stderr)
 * rather than guesses about:
 *   - a `messages:` value this script cannot read back as an array of
 *     `{id, ts}` items (anything but `[]`, or block items carrying both keys);
 *   - a recorded id that is not a string under YAML core-schema reading
 *     (`id: null`, an unquoted number or boolean, a flow collection).
 *     envelope-v0 requires a string message id, and inventing one is exactly
 *     the synthesis the spec forbids;
 *   - `messages: []` - envelope-v0 requires at least one message;
 *   - a body anchoring more or fewer turns than the array records.
 *
 * Fenced code blocks (``` or ~~~, up to three leading spaces) are not scanned
 * for turn headers, timeline sentinels or the H1 - but a fence reaches only to
 * the end of the turn it opened in. On the recorded path the signal that ends
 * one is the same clock rule as everywhere else: a fence still open at a line
 * whose header clock matches the next expected turn has provably swallowed a
 * real boundary, so the fence loses - it is read as ordinary text, with a
 * warning naming the line it opened on. The same demotion applies to a fence
 * still open at the end of the page. Both are the same trade: a fence must
 * never be allowed to swallow the turns after it, and a spurious stretch of
 * ordinary text is a far smaller failure than a turn deleted in silence. On
 * the legacy path the fence-versus-boundary signal is the blank / `---` /
 * blank separator the old importer wrote between turns, as before.
 *
 * The body is cut at a gbrain timeline sentinel - a line that is exactly
 * `<!-- timeline -->`, `<!--timeline-->` or `--- timeline ---` after
 * trimming - so a page's timeline never becomes message text. Only a sentinel
 * with no accepted turn after it is treated as a boundary; one with turns
 * below it is message text and is reported rather than cut at. A sentinel
 * standing alone on its line INSIDE the final message still cuts - from this
 * side of the page it is indistinguishable from gbrain's real delimiter - and
 * the cut is what the timeline note on stderr is counting. The fourth form
 * gbrain's own parser accepts (a bare `---` followed by `## Timeline`) is
 * deliberately NOT recognized here, because `---` is also the legacy
 * turn separator.
 *
 * Frontmatter is read line by line: top-level scalars only, in the plain,
 * single-quoted, double-quoted (escapes decoded, including `\U` beyond the
 * BMP), folded (`>`) and literal (`|`) block forms - plus, alone among
 * nested structures, the `messages:` block sequence described above. Items
 * accept the importer's JSON-quoted scalars, the single-quoted / plain forms
 * gbrain's js-yaml rewrite produces, `null`, and block scalars; member keys
 * beyond `id` and `ts` are ignored so a future third field does not break the
 * read; a quoted scalar that does not close on its own line is refused (js-yaml
 * folds long values into block scalars rather than wrapping quotes, so that
 * shape indicates a page this script does not understand).
 *
 * `title` falls back to the body's first H1 when frontmatter carries none,
 * the same precedence gbrain's own parser uses (src/core/markdown.ts,
 * inferTitleFromBody), and only then to `Untitled conversation`.
 * `title`, `source` and `memvelope_conversation_id` are trimmed, which
 * matters only for a block scalar: its chomping indicator can leave a
 * trailing newline on a value that never carried one. Recorded ids and
 * timestamps are NOT trimmed - they are the record, and the record is
 * verbatim.
 *
 * What survives the round trip envelope -> envelope-to-gbrain.mjs -> here,
 * measured on the recorded format (see STATUS for the corpus):
 *   - conversation id and title, including a null id
 *   - message id, role, timestamp and text, verbatim - including ids carrying
 *     newlines, YAML syntax, or a whole frontmatter block, and timestamps at
 *     full sub-second resolution with their original offsets
 *   - meta.source_provider
 *   - meta.conversation_count and meta.message_count, recomputed and equal
 *
 * What does not survive. Each of these was measured on a probe envelope or a
 * probe page built to carry it, not assumed:
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
 *     envelope-v0 requires text of at least one character. On the recorded
 *     path its `{id, ts}` entry is dropped with it, so the join stays aligned.
 *     meta.message_count follows what was written, so it drops too.
 *   - Anything before the first turn header except the `# Title` heading,
 *     which is read as the title fallback described above.
 *   - A gbrain timeline section. envelope-v0 has no field for it. Every page
 *     that carried one is counted on stderr.
 *   - A recorded `ts` that is not a strict RFC 3339 `date-time` - which is
 *     what the schema's `format: date-time` names. Emitted as null, with a
 *     warning, rather than as a value that fails validation. That includes a
 *     second of 60 anywhere but the instant a leap second is inserted; see
 *     asRfc3339DateTime below. A recorded `ts: null` stays null, silently -
 *     that is the agreed spelling of "the export had no timestamp", not a
 *     loss. On the legacy path the same rule judges the header parenthetical,
 *     and the literal `no timestamp` is the agreed null there.
 *   - A message whose text contains a line that matches the next expected
 *     header exactly - speaker shape and the very minute the following
 *     message is recorded at. That line still splits the message, the real
 *     header below it is then read as prose, and both halves land in the
 *     wrong turn's text; ids and timestamps stay correct, nothing is deleted,
 *     and the misread header is reported on stderr. This is the residue of
 *     defect D2: the boundary signal is the recorded clock, so only text that
 *     forges the right clock at the right position can still confuse it.
 *   - CRLF line endings, normalized to LF on read.
 *   - One source_provider per file. An envelope names a single provider, so a
 *     page set spanning several keeps the first in sorted path order and warns.
 *
 * A page with no `memvelope_conversation_id` emits `id: null` rather than a
 * synthesized id. envelope-v0 permits null there and tells converters not to
 * invent one.
 *
 * `meta.source_provider` is required by envelope-v0 and cannot be omitted, so a
 * page set where no page carries a `source:` key falls back to the literal
 * `unknown` - which no provider registry defines - and says so on stderr,
 * naming the token it wrote.
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
 * STATUS: see the test file and findings for 2026-08-02. Conformance in CI is
 * checked by test/gbrain-to-envelope.test.ts, which validates against the
 * published envelope-v0 JSON Schema vendored byte-for-byte at
 * test/fixtures/memvelope/envelope-v0.schema.json (sha256
 * 423813d563de394cde2798848e90fdadc85ba52458f5c18b1da897e6c8ae52b9, identical
 * across memvelope.com, raw.githubusercontent.com/memvelope/memvelope@main and
 * the memvelope package). The test walks those bytes with a draft-07 subset it
 * implements in full and refuses any keyword it does not, so a constraint added
 * upstream turns the suite red instead of going unchecked. No validator
 * dependency is added.
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

// YAML double-quoted scalars carry escapes JSON does not: `\U0001F680` for an
// astral code point, `\x41`, `\N`, `\_`. js-yaml reaches for this form whenever
// a string holds a tab or a non-printable, which includes any emoji - common in
// vendor conversation titles. Decoding it here is the difference between the
// real title and the literal text `"\U0001F680 ..."`, quotes and all.
const SIMPLE_ESCAPES = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f',
  r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85',
  _: '\xa0', L: '\u2028', P: '\u2029',
};

function isCompleteDoubleQuoted(raw) {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return false;
  // The closing quote must not itself be escaped, and no unescaped quote may
  // appear before it - otherwise this is a fragment and not a whole scalar.
  let escaped = false;
  for (let i = 1; i < raw.length; i += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (raw[i] === '\\') escaped = true;
    else if (raw[i] === '"') return i === raw.length - 1;
  }
  return false;
}

function decodeDoubleQuoted(raw) {
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== '\\') {
      out += inner[i];
      continue;
    }
    const esc = inner[i + 1];
    if (esc === undefined) {
      out += '\\';
      break;
    }
    i += 1;
    if (esc in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[esc];
      continue;
    }
    const width = esc === 'x' ? 2 : esc === 'u' ? 4 : esc === 'U' ? 8 : 0;
    if (width === 0) {
      // An escape YAML does not define. Keep both characters rather than
      // inventing a decoding.
      out += `\\${esc}`;
      continue;
    }
    const digits = inner.slice(i + 1, i + 1 + width);
    if (digits.length !== width || !/^[0-9A-Fa-f]+$/.test(digits)) {
      out += `\\${esc}`;
      continue;
    }
    const code = parseInt(digits, 16);
    if (code > 0x10ffff) {
      out += `\\${esc}${digits}`;
    } else {
      out += String.fromCodePoint(code);
    }
    i += width;
  }
  return out;
}

// A single-quoted scalar is complete when its closing quote is the last
// character and every interior quote is one half of an escaped `''` pair.
function isCompleteSingleQuoted(raw) {
  if (raw.length < 2 || !raw.startsWith("'") || !raw.endsWith("'")) return false;
  let i = 1;
  while (i < raw.length) {
    if (raw[i] !== "'") {
      i += 1;
      continue;
    }
    if (i === raw.length - 1) return true;
    if (raw[i + 1] === "'") {
      i += 2;
      continue;
    }
    return false;
  }
  return false;
}

// A block scalar's content, given its already-dedented lines. Folded (`>`)
// joins a paragraph's lines with a space and turns a blank line into a
// newline; a more-indented line keeps its breaks. Literal (`|`) keeps every
// break as written.
function joinBlockScalar(contentLines, style, chomping, trailingBlanks) {
  let value;
  if (style === '|') {
    value = contentLines.join('\n');
  } else {
    value = '';
    for (let i = 0; i < contentLines.length; i += 1) {
      const line = contentLines[i];
      if (i === 0) {
        value = line;
        continue;
      }
      const prev = contentLines[i - 1];
      if (line === '' || prev === '') {
        value += line === '' ? '\n' : line;
        continue;
      }
      value += (/^\s/.test(line) || /^\s/.test(prev) ? '\n' : ' ') + line;
    }
  }
  if (chomping === 'strip') return value;
  if (chomping === 'keep') return value + '\n'.repeat(1 + trailingBlanks);
  return value === '' ? '' : `${value}\n`;
}

/** A block scalar header (`>-`, `|`, `>2-`, ...) or null. */
function blockScalarHeader(raw) {
  const block = /^([|>])([+-]?[0-9]?|[0-9][+-]?)$/.exec(raw);
  if (!block) return null;
  return {
    style: block[1],
    chomping: raw.includes('+') ? 'keep' : raw.includes('-') ? 'strip' : 'clip',
    explicit: /[0-9]/.exec(raw),
  };
}

/** Reads the indented block below `lines[headerIdx]` as a block scalar whose
 *  owner key sits at indentation `ownerLead`. Returns the value and the index
 *  of the first line after the block. */
function readBlockScalar(lines, headerIdx, header, ownerLead) {
  // A YAML indentation indicator is relative to the owner node; at the top
  // level (ownerLead 0) that is the absolute column, matching the previous
  // behavior of this parser exactly.
  let indent = header.explicit ? ownerLead + Number(header.explicit[0]) : -1;
  const collected = [];
  let j = headerIdx + 1;
  for (; j < lines.length; j += 1) {
    if (lines[j].trim() === '') {
      collected.push('');
      continue;
    }
    const lead = lines[j].length - lines[j].trimStart().length;
    if (lead <= ownerLead) break;
    if (indent === -1) indent = lead;
    if (lead < indent) break;
    collected.push(lines[j].slice(indent));
  }
  let trailingBlanks = 0;
  while (collected.length > 0 && collected[collected.length - 1] === '') {
    collected.pop();
    trailingBlanks += 1;
  }
  return { value: joinBlockScalar(collected, header.style, header.chomping, trailingBlanks), next: j };
}

// Top-level scalars only. gbrain writes these through js-yaml, which quotes
// with single quotes, escapes with double quotes, and folds anything long into
// a block scalar; the importer writes them through JSON.stringify, which quotes
// with double quotes. All of those are read here, along with the unquoted form.
// A line that is indented belongs to a nested value or to a block scalar's
// content and is never read as a key. The one nested structure this script
// understands - the `messages:` sequence - is read by parseMessagesRecord,
// separately, over the same lines.
function parseFrontmatter(lines) {
  const out = {};
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*): ?(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim();

    // `key: >-`, `key: |`, `key: >2-`: the value is the indented block below.
    const block = blockScalarHeader(raw);
    if (block) {
      const scalar = readBlockScalar(lines, i, block, 0);
      out[key] = scalar.value;
      i = scalar.next - 1;
      continue;
    }

    if (raw === '') continue;
    if (raw === 'null' || raw === '~') {
      out[key] = null;
      continue;
    }
    if (isCompleteDoubleQuoted(raw)) {
      out[key] = decodeDoubleQuoted(raw);
      continue;
    }
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      out[key] = raw.slice(1, -1).replace(/''/g, "'");
      continue;
    }
    out[key] = raw;
  }
  return out;
}

// What a plain (unquoted) YAML scalar means under the core schema js-yaml
// reads and writes: null, boolean and number forms are not strings. The
// importer JSON-quotes every string it takes from an envelope and js-yaml
// re-quotes any string that LOOKS like one of these on the way back out, so an
// unquoted `id: 123` really is a number and refusing it is correct - reading
// it as the string "123" would fabricate an id the record does not hold.
// (`yes`, `no`, `on`, `off` are strings under the core schema, and stay
// strings here.)
const PLAIN_NON_STRING =
  /^(true|false|True|False|TRUE|FALSE|[-+]?\d[\d_]*|0x[\dA-Fa-f]+|0o[0-7]+|[-+]?(\.\d+|\d[\d_]*(\.[\d_]*)?)([eE][-+]?\d+)?|[-+]?\.(inf|Inf|INF)|\.(nan|NaN|NAN))$/;

/** Decodes one scalar value from a `messages:` item member line. Returns
 *  `{ value }` (string or null) or `{ error }` when the raw text is not a
 *  scalar this script can stand behind. */
function decodeMemberScalar(raw) {
  if (raw === '' || raw === 'null' || raw === '~' || raw === 'Null' || raw === 'NULL') return { value: null };
  if (raw.startsWith('"')) {
    if (isCompleteDoubleQuoted(raw)) return { value: decodeDoubleQuoted(raw) };
    return { error: 'a double-quoted scalar that does not close on its own line' };
  }
  if (raw.startsWith("'")) {
    if (isCompleteSingleQuoted(raw)) return { value: raw.slice(1, -1).replace(/''/g, "'") };
    return { error: 'a single-quoted scalar that does not close on its own line' };
  }
  if (raw.startsWith('[') || raw.startsWith('{') || raw.startsWith('&') || raw.startsWith('*') || raw.startsWith('!')) {
    return { error: `a value this script does not read (${JSON.stringify(raw)})` };
  }
  if (PLAIN_NON_STRING.test(raw)) return { value: { nonString: raw } };
  return { value: raw };
}

/**
 * The `messages:` record, read out of the frontmatter lines: the per-message
 * identity the importer writes and gbrain's serializer rewrites (values and
 * order intact, quoting style not - so this parser accepts both quotings and
 * the block-scalar form js-yaml folds long values into).
 *
 * Returns `{ present: false }` when the page carries no `messages:` key - a
 * page written before this format existed - `{ present: true, items }` when
 * the record reads cleanly, and `{ present: true, error }` when the key is
 * there but this script cannot stand behind what it read. The error case must
 * never fall back to the legacy path: a page that declares a record it cannot
 * deliver is not a legacy page, it is an unreadable one.
 */
function parseMessagesRecord(lines) {
  let at = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^messages: ?/.test(lines[i]) || lines[i] === 'messages:') {
      if (at !== -1) return { present: true, error: 'the messages key appears twice' };
      at = i;
    }
  }
  if (at === -1) return { present: false };

  const inline = (/^messages: ?(.*)$/.exec(lines[at]))[1].trim();
  if (inline === '[]') return { present: true, items: [] };
  if (inline !== '') return { present: true, error: `an inline value this script does not read (${JSON.stringify(inline)})` };

  const items = [];
  let itemLead = -1;
  let current = null;
  let i = at + 1;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const lead = line.length - line.trimStart().length;
    // A new top-level key ends the sequence.
    if (lead === 0) break;

    const item = /^(\s+)- (.*)$/.exec(line);
    if (item && (itemLead === -1 || item[1].length === itemLead)) {
      if (itemLead === -1) itemLead = item[1].length;
      current = {};
      items.push(current);
      const first = readMember(item[2].trim(), itemLead + 2);
      if (first.error) return { present: true, error: first.error };
      continue;
    }
    if (current === null) return { present: true, error: `a line before the first item (${JSON.stringify(line)})` };
    if (lead <= itemLead) return { present: true, error: `an indentation this script does not read (${JSON.stringify(line)})` };
    const member = readMember(line.trim(), lead);
    if (member.error) return { present: true, error: member.error };
  }

  // One member line, already trimmed, belonging to `current`. `memberLead` is
  // the column its key starts at, needed when its value is a block scalar.
  function readMember(text, memberLead) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*): ?(.*)$/.exec(text);
    if (!m) return { error: `an item line that is not a key: value pair (${JSON.stringify(text)})` };
    const key = m[1];
    const raw = m[2].trim();
    if (key !== 'id' && key !== 'ts') {
      // A future third field. Skip its value, block scalar and all.
      const block = blockScalarHeader(raw);
      if (block) i = readBlockScalar(lines, i, block, memberLead).next - 1;
      return {};
    }
    if (key in current) return { error: `the ${key} key appears twice in one item` };
    const block = blockScalarHeader(raw);
    if (block) {
      const scalar = readBlockScalar(lines, i, block, memberLead);
      current[key] = scalar.value;
      i = scalar.next - 1;
      return {};
    }
    const decoded = decodeMemberScalar(raw);
    if (decoded.error) return { error: `${key}: ${decoded.error}` };
    current[key] = decoded.value;
    return {};
  }

  for (const [n, item] of items.entries()) {
    if (!('id' in item) || !('ts' in item)) {
      return { present: true, error: `item ${n + 1} does not carry both id and ts` };
    }
  }
  return { present: true, items };
}

// ---------------------------------------------------------------------------
// The header-clock derivation, copied VERBATIM from envelope-to-gbrain.mjs so
// the expected clock recomputed here is the clock the importer wrote. If one
// of these functions changes, change both files - the round-trip tests fail
// loudly (a clock mismatch skips the page) if they drift.
// ---------------------------------------------------------------------------

/** The date a turn header is allowed to carry: exactly `YYYY-MM-DD`. */
const HEADER_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What `deriveDateContext()` in gbrain's conversation parser falls back to when
 *  a page carries no date at all. */
const EPOCH_DATE = '1970-01-01';

/** The RFC 3339 shapes the importer will read a wall clock out of.
 *  Groups: 1=Y 2=M 3=D 4=hh 5=mm, then an optional offset 6=sign 7=hh 8=mm. */
const TS_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))?$/;

/**
 * The `YYYY-MM-DD HH:MM` a turn header carries, or null when the message's `ts`
 * cannot supply one. 24-hour, and UTC - see envelope-to-gbrain.mjs for the
 * full reasoning; this copy exists so the expected boundary clock is derived
 * from the recorded `ts` by the exact function that wrote it.
 */
function headerClock(ts) {
  if (typeof ts !== 'string') return null;
  const m = TS_SHAPE.exec(ts.trim());
  if (m === null) return null;
  const [, year, month, day, hour, minute, sign, offsetHour, offsetMinute] = m;
  const [y, mo, d, h, mi] = [year, month, day, hour, minute].map(Number);
  if (h > 23 || mi > 59) return null;
  const utc = new Date(0);
  utc.setUTCFullYear(y, mo - 1, d);
  utc.setUTCHours(h, mi, 0, 0);
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) {
    return null;
  }
  if (sign === undefined) return `${year}-${month}-${day} ${hour}:${minute}`;
  const [oh, om] = [offsetHour, offsetMinute].map(Number);
  if (oh > 23 || om > 59) return null;
  utc.setUTCMinutes(utc.getUTCMinutes() - (oh * 60 + om) * (sign === '-' ? -1 : 1));
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}`;
}

// ---------------------------------------------------------------------------
// Body reading - shared pieces.
// ---------------------------------------------------------------------------

// The legacy turn header, matched one line at a time so a fenced block can be
// excluded. The timestamp group is lazy so the first middle dot separates it
// from the message id, which leaves an id free to contain one.
const TURN_HEADER = /^\*\*(Me|Assistant)\*\* \((.*?) · (.*)\):$/;
// The recorded-format turn header: speaker and minute-resolution clock, no
// identity. Strict except for trailing whitespace, which gbrain's own
// `imessage-slack` pattern also tolerates - and which used to absorb a turn.
const RECORDED_HEADER = /^\*\*(Me|Assistant)\*\* \((\d{4}-\d{2}-\d{2} \d{2}:\d{2})\):[ \t]*$/;
// A whole line, after trimming - never a substring. A message that quotes the
// sentinel mid-sentence is prose, and cutting there destroys every later turn.
const TIMELINE_SENTINELS = new Set(['<!-- timeline -->', '<!--timeline-->', '--- timeline ---']);
const NO_TIMESTAMP = 'no timestamp';
const FALLBACK_PROVIDER = 'unknown';
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Strict RFC 3339 `date-time`, the profile the schema's `format: date-time`
// names. Shape first, then real calendar and clock bounds, so `2026-02-30` and
// `T25:00:00` are rejected rather than passed through. Returns the value when it
// conforms, else null.
//
// Second 60 is a leap second, and RFC 3339 5.6 permits it only at the instant a
// leap second is inserted - midnight UTC. The local clock may read anything, as
// long as it names that instant: the RFC's own example set has
// `1990-12-31T15:59:60-08:00`. So the check normalizes the offset away and asks
// whether the UTC time-of-day is 23:59. `2026-02-01T09:00:60Z` and
// `2026-12-31T23:59:60+01:00` both fail it, and both are rejected by ajv 8.20.0
// + ajv-formats 3.0.1 in strict/full mode - which is what a consumer validating
// the published schema runs, and what this bound was measured against.
function asRfc3339DateTime(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (day < 1 || day > (month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1])) return null;
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (hour > 23 || minute > 59 || second > 60) return null;
  const offset = m[8];
  let offsetMinutes = 0;
  if (offset !== 'Z' && offset !== 'z') {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (offset[0] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }
  if (second === 60) {
    const utcMinuteOfDay = (((hour * 60 + minute - offsetMinutes) % 1440) + 1440) % 1440;
    if (utcMinuteOfDay !== 23 * 60 + 59) return null;
  }
  return value;
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// The separator the LEGACY importer wrote between two turns: a blank line, a
// `---` rule, a blank line. On the legacy path it is the one structural signal
// on the page that separates a real turn boundary from a transcript pasted
// into a code block, and it decides the only case fence state cannot decide on
// its own - a header-shaped line reached while a fence is open.
function precededByTurnSeparator(lines, i) {
  return i >= 3
    && lines[i - 1].trim() === ''
    && lines[i - 2].trim() === '---'
    && lines[i - 3].trim() === '';
}

// One left-to-right pass producing the fence mask and the turn headers
// together, so that a fence can never hide a header belonging to a LATER turn.
// `disabled` holds the fence openers already proven not to close inside their
// own turn; those read as ordinary text. Returns `{ reopen }` when it meets such
// an opener, and the caller disables it and runs the pass again.
function scanPass(lines, disabled) {
  const fenced = new Array(lines.length).fill(false);
  const headers = [];
  const quotedHeaders = [];
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const fence = FENCE_LINE.exec(lines[i]);
    if (open === null) {
      const header = TURN_HEADER.exec(lines[i]);
      if (header) {
        headers.push({ line: i, match: header });
        continue;
      }
      // A backtick fence's info string may not itself contain a backtick.
      if (fence && !disabled.has(i) && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        open = { char: fence[1][0], len: fence[1].length, at: i };
        fenced[i] = true;
      }
      continue;
    }
    if (TURN_HEADER.test(lines[i])) {
      // A fence's reach ends with the turn it opened in. A header carrying the
      // separator above it belongs to the next turn, so the fence is the thing
      // that is wrong and it loses: masking on from here would delete that
      // turn's id, role and timestamp outright and swallow its text into the
      // turn above, which is the loss no count in the output contradicts.
      if (precededByTurnSeparator(lines, i)) return { reopen: { at: open.at, spanningAt: i } };
      quotedHeaders.push(i);
    }
    fenced[i] = true;
    if (fence && fence[1][0] === open.char && fence[1].length >= open.len && fence[2].trim() === '') open = null;
  }
  // A fence left open at the end of the body would mask everything after it.
  if (open !== null) return { reopen: { at: open.at, spanningAt: -1 } };
  return { reopen: null, fenced, headers, quotedHeaders };
}

// The fence mask and the turn headers. A fence that cannot close inside its own
// turn is demoted to ordinary text and the pass is rerun without it, which is
// the same trade the unclosed case already made: a spurious extra message is a
// far smaller failure than a silently truncated conversation. Each rerun
// disables one more opener, so the loop runs at most once per fence line.
function scanFencesAndHeaders(lines, warn) {
  const disabled = new Set();
  for (;;) {
    const pass = scanPass(lines, disabled);
    if (pass.reopen === null) return pass;
    disabled.add(pass.reopen.at);
    warn(pass.reopen.spanningAt === -1
      ? `an unclosed code fence opens at body line ${pass.reopen.at + 1}; read as ordinary text so the turns after it are not lost.`
      : `the code fence opened at body line ${pass.reopen.at + 1} is still open at the turn header on body line ${pass.reopen.spanningAt + 1}; a fence does not span a turn, so it was read as ordinary text and that turn was kept.`);
  }
}

// The recorded-path twin of scanPass. Boundaries are accepted by position:
// a header-shaped line is boundary k only when its clock is the one expected
// for position k. The same rule is the fence-demotion signal - a fence still
// open at a line carrying the next expected clock has swallowed a real
// boundary, so the fence loses.
function scanRecordedPass(lines, expected, disabled) {
  const fenced = new Array(lines.length).fill(false);
  const boundaries = [];
  const proseHeaders = [];
  const quotedHeaders = [];
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const fence = FENCE_LINE.exec(lines[i]);
    if (open === null) {
      const header = RECORDED_HEADER.exec(lines[i]);
      if (header) {
        if (boundaries.length < expected.length && header[2] === expected[boundaries.length]) {
          boundaries.push({ line: i, speaker: header[1] });
        } else {
          proseHeaders.push(i);
        }
        continue;
      }
      if (fence && !disabled.has(i) && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        open = { char: fence[1][0], len: fence[1].length, at: i };
        fenced[i] = true;
      }
      continue;
    }
    const header = RECORDED_HEADER.exec(lines[i]);
    if (header && boundaries.length < expected.length && header[2] === expected[boundaries.length]) {
      return { reopen: { at: open.at, spanningAt: i } };
    }
    if (header) quotedHeaders.push(i);
    fenced[i] = true;
    if (fence && fence[1][0] === open.char && fence[1].length >= open.len && fence[2].trim() === '') open = null;
  }
  if (open !== null) return { reopen: { at: open.at, spanningAt: -1 } };
  return { reopen: null, fenced, boundaries, proseHeaders, quotedHeaders };
}

function scanRecordedFences(lines, expected, warn) {
  const disabled = new Set();
  for (;;) {
    const pass = scanRecordedPass(lines, expected, disabled);
    if (pass.reopen === null) return pass;
    disabled.add(pass.reopen.at);
    warn(pass.reopen.spanningAt === -1
      ? `an unclosed code fence opens at body line ${pass.reopen.at + 1}; read as ordinary text so the turns after it are not lost.`
      : `the code fence opened at body line ${pass.reopen.at + 1} is still open at the turn header on body line ${pass.reopen.spanningAt + 1}; a fence does not span a turn, so it was read as ordinary text and that turn was kept.`);
  }
}

// gbrain's own title precedence, minus the filename fallback this script must
// not use: frontmatter `title:` first, then the body's first H1.
function titleFromBody(lines, fenced) {
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const m = /^#(?!#)\s+(.+?)\s*$/.exec(lines[i]);
    if (m) return m[1].replace(/\s+#+\s*$/, '').trim();
  }
  return '';
}

// The timeline cut and the slice-into-messages step, shared by both paths.
// `anchors` carries each accepted boundary's line; `build` turns a boundary and
// its raw text into a message or null (null = dropped, already warned).
function cutAndSlice(lines, anchors, fenced, warn, stripLegacySeparator, build) {
  const sentinels = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    if (TIMELINE_SENTINELS.has(lines[i].trim())) sentinels.push(i);
  }

  // Cut only at a sentinel that no accepted turn follows. gbrain writes the
  // timeline after the whole body, so a sentinel with turns below it is a
  // message quoting the marker - the case that used to destroy every later
  // turn in silence.
  const lastAnchor = anchors.length > 0 ? anchors[anchors.length - 1].line : -1;
  let cut = lines.length;
  let hasTimeline = false;
  for (const at of sentinels) {
    if (at > lastAnchor) {
      cut = at;
      hasTimeline = true;
      break;
    }
    warn(`the line \`${lines[at].trim()}\` at body line ${at + 1} has speaker turns after it, so it is message text and not a timeline boundary; the body was not cut there.`);
  }

  const messages = [];
  for (const [i, anchor] of anchors.entries()) {
    const hasNext = i + 1 < anchors.length;
    const end = hasNext ? anchors[i + 1].line : cut;
    let raw = lines.slice(anchor.line + 1, end).join('\n');
    if (hasNext && stripLegacySeparator) {
      // Between two turns the legacy importer wrote exactly one `---`
      // separator line. Strip that one occurrence, never a `---` the message
      // itself ended with after the last turn.
      raw = `${raw}\n`.replace(/\n\n---\n\n$/, '');
    }
    const message = build(anchor, i, raw.trim());
    if (message !== null) messages.push(message);
  }
  return { messages, hasTimeline };
}

function readPageBody(body, warn) {
  const lines = body.split('\n');
  const { fenced, headers, quotedHeaders } = scanFencesAndHeaders(lines, warn);

  // Reported for the same reason a quoted timeline sentinel is: the script made
  // a call about what a line means, and the operator gets to see it.
  for (const at of quotedHeaders) {
    warn(`the line \`${lines[at].trim()}\` at body line ${at + 1} sits inside a fenced code block, so it was read as sample text and not as a turn.`);
  }

  let droppedEmpty = 0;
  let nulledTimestamps = 0;
  const { messages, hasTimeline } = cutAndSlice(lines, headers, fenced, warn, true, (header, _i, text) => {
    const id = header.match[3];
    if (text === '') {
      droppedEmpty += 1;
      warn(`message ${JSON.stringify(id)} has no text; dropped (envelope-v0 requires at least one character).`);
      return null;
    }
    // The legacy importer wrote the literal `no timestamp` when the envelope
    // had none. Read it back as the null the schema asks for, not as prose.
    let ts = null;
    if (header.match[2] !== NO_TIMESTAMP) {
      ts = asRfc3339DateTime(header.match[2]);
      if (ts === null) {
        nulledTimestamps += 1;
        warn(`message ${JSON.stringify(id)} carries ${JSON.stringify(header.match[2])} where a turn header's timestamp goes; it is not an RFC 3339 date-time, so ts was written as null.`);
      }
    }
    return { id, role: header.match[1] === 'Me' ? 'user' : 'assistant', ts, text };
  });

  return { messages, title: titleFromBody(lines, fenced), hasTimeline, droppedEmpty, nulledTimestamps };
}

/**
 * The recorded path: identity from the frontmatter record, speaker and text
 * from the body. Returns `{ mismatch, anchored }` when the body does not
 * anchor exactly one turn per recorded message - the caller skips the page
 * loudly; a positional join over the wrong count assigns real ids to the
 * wrong text, which is worse than refusing.
 */
function readRecordedBody(body, record, pageDate, warn) {
  const lines = body.split('\n');
  // The clock the importer wrote for each recorded message: derived from its
  // `ts` where one is usable, else the page-date fallback the importer used.
  const expected = record.map((r) => {
    const clock = headerClock(r.ts);
    return clock === null ? `${pageDate} 00:00` : clock;
  });
  const { fenced, boundaries, proseHeaders, quotedHeaders } = scanRecordedFences(lines, expected, warn);

  for (const at of quotedHeaders) {
    warn(`the line \`${lines[at].trim()}\` at body line ${at + 1} sits inside a fenced code block, so it was read as sample text and not as a turn.`);
  }
  for (const at of proseHeaders) {
    warn(`the line \`${lines[at].trim()}\` at body line ${at + 1} is shaped like a turn header but does not carry the clock the messages record expects next, so it was read as prose.`);
  }

  if (boundaries.length !== record.length) {
    return { mismatch: true, anchored: boundaries.length };
  }

  let droppedEmpty = 0;
  let nulledTimestamps = 0;
  const { messages, hasTimeline } = cutAndSlice(lines, boundaries, fenced, warn, false, (anchor, i, text) => {
    const { id, ts } = record[i];
    if (text === '') {
      // The `{id, ts}` entry is dropped with its turn, so the join between the
      // remaining turns and their entries stays aligned.
      droppedEmpty += 1;
      warn(`message ${JSON.stringify(id)} has no text; dropped (envelope-v0 requires at least one character).`);
      return null;
    }
    let outTs = null;
    if (ts !== null) {
      outTs = asRfc3339DateTime(ts);
      if (outTs === null) {
        nulledTimestamps += 1;
        warn(`message ${JSON.stringify(id)} records ${JSON.stringify(ts)} as its timestamp; it is not an RFC 3339 date-time, so ts was written as null.`);
      }
    }
    return { id, role: anchor.speaker === 'Me' ? 'user' : 'assistant', ts: outTs, text };
  });

  return { mismatch: false, messages, title: titleFromBody(lines, fenced), hasTimeline, droppedEmpty, nulledTimestamps };
}

const files = markdownFiles(pagesDir);
const conversations = [];
const providers = [];
const seenIds = new Set();
let skippedNotConversation = 0;
let skippedNoFrontmatter = 0;
let skippedNoMessages = 0;
let skippedUnreadableRecord = 0;
let skippedJoinMismatch = 0;
let droppedEmptyMessages = 0;
let droppedTimelines = 0;
let nulledTimestamps = 0;
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
  const warn = (message) => console.warn(`warning: ${file} - ${message}`);

  let read;
  const record = parseMessagesRecord(page.front);
  if (record.present) {
    if (record.error) {
      skippedUnreadableRecord += 1;
      warn(`the messages record could not be read (${record.error}); skipped rather than joined wrong.`);
      continue;
    }
    if (record.items.length === 0) {
      skippedNoMessages += 1;
      warn('the messages record is empty; skipped (envelope-v0 requires at least one message per conversation).');
      continue;
    }
    const badId = record.items.findIndex((item) => typeof item.id !== 'string');
    if (badId !== -1) {
      skippedUnreadableRecord += 1;
      const shown = record.items[badId].id === null ? 'null' : JSON.stringify(record.items[badId].id.nonString);
      warn(`messages[${badId}] records ${shown} where its id goes; envelope-v0 requires a string message id and inventing one is the synthesis the spec forbids, so the page was skipped.`);
      continue;
    }
    // A non-string `ts` (an unquoted number, say) is what the importer writes
    // for a non-conforming envelope; it is not a clock the header could have
    // been derived from, so it takes the fallback-clock path and comes back
    // null like every other unusable timestamp.
    const items = record.items.map((item) => ({
      id: item.id,
      ts: typeof item.ts === 'string' || item.ts === null ? item.ts : item.ts.nonString,
    }));
    const pageDate = typeof front.date === 'string' && HEADER_DATE.test(front.date) ? front.date : EPOCH_DATE;
    read = readRecordedBody(page.body, items, pageDate, warn);
    if (read.mismatch) {
      skippedJoinMismatch += 1;
      warn(`the frontmatter records ${record.items.length} message(s) but the body anchors ${read.anchored} turn(s); a positional join over unequal counts would assign identity to the wrong text, so the page was skipped.`);
      continue;
    }
  } else {
    read = readPageBody(page.body, warn);
  }

  droppedEmptyMessages += read.droppedEmpty;
  nulledTimestamps += read.nulledTimestamps;
  if (read.hasTimeline) droppedTimelines += 1;
  if (read.messages.length === 0) {
    skippedNoMessages += 1;
    warn('no speaker turns found; skipped (envelope-v0 requires at least one message per conversation).');
    continue;
  }
  if (typeof front.source === 'string' && front.source.trim() !== '') providers.push(front.source.trim());
  // Never synthesize. An absent id is null, which the schema permits and the
  // spec requires of converters.
  // Trimmed for the same reason the title is: a block scalar's chomping can
  // leave a trailing newline on a value that never had one, and an id has to
  // compare equal to the one the envelope carried.
  const id = typeof front.memvelope_conversation_id === 'string' && front.memvelope_conversation_id.trim() !== ''
    ? front.memvelope_conversation_id.trim()
    : null;
  // envelope-v0 says ids should be unique within an envelope and that consumers
  // must tolerate duplicates. Emit both conversations and say so, rather than
  // dropping one to keep the field clean.
  if (id !== null && seenIds.has(id)) {
    warn(`conversation id ${JSON.stringify(id)} already used by another page; both are emitted.`);
  }
  if (id !== null) seenIds.add(id);
  // Frontmatter first, then the body's H1 - gbrain's own precedence - so a
  // title that js-yaml folded into a block scalar has a second way home.
  const title = (typeof front.title === 'string' && front.title.trim() !== '' ? front.title.trim() : read.title)
    || 'Untitled conversation';
  conversations.push({
    id,
    title,
    // The page's `date` is a day, not a date-time, so it cannot fill these.
    // First and last message timestamps are the only date-times on the page.
    created_at: read.messages[0].ts,
    updated_at: read.messages[read.messages.length - 1].ts,
    messages: read.messages,
  });
  messageCount += read.messages.length;
}

const distinctProviders = [...new Set(providers)];
if (distinctProviders.length > 1) {
  console.warn(`warning: pages name ${distinctProviders.length} source providers (${distinctProviders.join(', ')}); an envelope carries one. Using ${JSON.stringify(distinctProviders[0])}.`);
}
// envelope-v0 requires meta.source_provider, so it cannot be omitted the way
// meta.source_export_date is. Minting a token no registry defines is a guess,
// and a guess gets reported like every other lossy edge in this script.
if (distinctProviders.length === 0) {
  console.warn(`warning: no page carries a \`source:\` key, and envelope-v0 requires meta.source_provider; wrote the placeholder ${JSON.stringify(FALLBACK_PROVIDER)}, which is not a registered provider token. Set \`source:\` on the pages to name the real provider.`);
}
const envelope = {
  memvelope: 'envelope-v0',
  meta: {
    source_provider: distinctProviders[0] || FALLBACK_PROVIDER,
    conversation_count: conversations.length,
    message_count: messageCount,
  },
  conversations,
};

writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n');
console.log(`wrote ${conversations.length} conversation(s), ${messageCount} message(s) to ${outPath}`);
// Every page that did not become a conversation is accounted for on stderr, so
// a mistargeted directory reads as a diagnosis rather than an empty file.
if (skippedNoFrontmatter || skippedNotConversation || skippedNoMessages || skippedUnreadableRecord || skippedJoinMismatch || droppedEmptyMessages) {
  console.warn(`scanned ${files.length} markdown file(s): ${skippedNoFrontmatter} without frontmatter, ${skippedNotConversation} not type conversation, ${skippedNoMessages} without speaker turns, ${skippedUnreadableRecord} with a messages record that could not be read, ${skippedJoinMismatch} whose body does not match their messages record, ${droppedEmptyMessages} empty message(s) dropped.`);
}
// Two losses that leave the output conforming and would otherwise be invisible.
if (droppedTimelines) {
  console.warn(`note: ${droppedTimelines} page(s) carried a gbrain timeline section; envelope-v0 has no field for it, so it was not exported.`);
}
if (nulledTimestamps) {
  console.warn(`note: ${nulledTimestamps} turn timestamp(s) were not RFC 3339 date-times and were written as null.`);
}
