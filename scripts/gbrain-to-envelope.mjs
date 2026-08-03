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
 *   - Fenced code blocks (``` or ~~~, up to three leading spaces) are not
 *     scanned for turn headers, timeline sentinels or the H1 - but a fence
 *     reaches only to the end of the turn it opened in. A fence still open at
 *     the next turn header, or at the end of the page, is read as ordinary text
 *     instead, with a warning naming the line it opened on. Both are the same
 *     trade: a fence must never be allowed to swallow the turns after it, and a
 *     spurious extra message is a far smaller failure than a turn deleted in
 *     silence. `**Me** (…):` written at column 0 inside a still-open fence is
 *     taken as the next turn only when the blank / `---` / blank separator this
 *     script's own importer writes between turns sits directly above it; that
 *     separator is the one signal on the page that tells a real boundary from a
 *     transcript pasted into a code block.
 *   - The body is cut at a gbrain timeline sentinel - a line that is exactly
 *     `<!-- timeline -->`, `<!--timeline-->` or `--- timeline ---` after
 *     trimming - so a page's timeline never becomes message text. Only a
 *     sentinel with no speaker turn after it is treated as a boundary; a line
 *     that merely quotes one, mid-sentence or above a later turn, is message
 *     text and is reported rather than cut at. The fourth form gbrain's own
 *     parser accepts (a bare `---` followed by `## Timeline`) is deliberately
 *     NOT recognized here, because `---` is also the separator this script's
 *     own importer writes between two turns.
 *   - Frontmatter is read line by line: top-level scalars only, in the plain,
 *     single-quoted, double-quoted (escapes decoded, including `\U` beyond the
 *     BMP), folded (`>`) and literal (`|`) block forms. Block chomping is
 *     honored: `-` strips the trailing newline, the default clips to one, `+`
 *     keeps them. Sequences, nested mappings and comments are ignored - none of
 *     the four keys this script reads (`type`, `title`, `source`,
 *     `memvelope_conversation_id`) is ever written as one - which is what keeps
 *     it free of a YAML dependency.
 *   - `title` falls back to the body's first H1 when frontmatter carries none,
 *     the same precedence gbrain's own parser uses (src/core/markdown.ts,
 *     inferTitleFromBody), and only then to `Untitled conversation`.
 *   - `title`, `source` and `memvelope_conversation_id` are trimmed, which
 *     matters only for a block scalar: its chomping indicator can leave a
 *     trailing newline on a value that never carried one.
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
 *     envelope-v0 requires text of at least one character. meta.message_count
 *     follows what was written, so it drops too.
 *   - Anything before the first turn header except the `# Title` heading, which
 *     is read as the title fallback described above.
 *   - A gbrain timeline section. envelope-v0 has no field for it. Every page
 *     that carried one is counted on stderr.
 *   - Text that itself contains a line shaped like a turn header, OUTSIDE a
 *     fenced block. It still splits into two messages, and the second one's id
 *     comes from that line. Inside a fenced block that opens and closes within
 *     one turn it does not split, and the line is reported on stderr as having
 *     been read as sample text. The remaining ambiguity is a fenced block whose
 *     content itself carries the blank / `---` / blank turn separator: that
 *     does split, and is reported.
 *   - A turn timestamp that is not a strict RFC 3339 `date-time` - which is
 *     what the schema's `format: date-time` names, and what a header-shaped
 *     line lifted out of prose produces. Emitted as null, with a warning,
 *     rather than as a value that fails validation. That includes a second of
 *     60 anywhere but the instant a leap second is inserted; see
 *     asRfc3339DateTime below. The literal `no timestamp` the importer writes
 *     for an absent timestamp becomes null silently: that is the agreed
 *     spelling, not a loss.
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
 * STATUS: verified against gbrain v0.42.72.1 on 2026-08-02. The sample fixture
 * round-trips through the importer and back deep-equal. Conformance in CI is
 * checked by test/gbrain-to-envelope.test.ts, which validates against the
 * published envelope-v0 JSON Schema vendored byte-for-byte at
 * test/fixtures/memvelope/envelope-v0.schema.json (sha256
 * 423813d563de394cde2798848e90fdadc85ba52458f5c18b1da897e6c8ae52b9, identical
 * across memvelope.com, raw.githubusercontent.com/memvelope/memvelope@main and
 * the memvelope package). The test walks those bytes with a draft-07 subset it
 * implements in full and refuses any keyword it does not, so a constraint added
 * upstream turns the suite red instead of going unchecked. No validator
 * dependency is added; the D4 and R4 regression tests guard both halves.
 *
 * The long path was re-run on 2026-08-02 after this file's turn parser was
 * rewritten a second time (the fence-per-turn fix below), against a throwaway
 * PGLite brain under a redirected HOME: envelope -> envelope-to-gbrain.mjs ->
 * `gbrain import` -> `gbrain export --dir` -> here. A two-conversation probe
 * carrying a 94-character title, an 85-character id, a message quoting
 * `<!-- timeline -->` mid-sentence, a 23:59:60Z leap second, three fences that
 * span a turn boundary and one balanced 4-backtick nest came back with all 8
 * messages, and every id, role, timestamp and message text identical to the
 * envelope it started from. The only field that moved is the documented one:
 * `updated_at`, which is taken from the last message. That path is what
 * produced three of the bugs this parser handles: `gbrain export --dir`
 * serializes frontmatter through js-yaml at the default lineWidth of 80, so a
 * title or id of 80-odd characters arrives as a folded block scalar (measured:
 * the first fold is at 80 characters of `key: value`), and the body is handed
 * back verbatim, quoted sentinel and all.
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

// Top-level scalars only. gbrain writes these through js-yaml, which quotes
// with single quotes, escapes with double quotes, and folds anything long into
// a block scalar; the importer writes them through JSON.stringify, which quotes
// with double quotes. All of those are read here, along with the unquoted form.
// A line that is indented belongs to a nested value or to a block scalar's
// content and is never read as a key.
function parseFrontmatter(lines) {
  const out = {};
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*): ?(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim();

    // `key: >-`, `key: |`, `key: >2-`: the value is the indented block below.
    const block = /^([|>])([+-]?[0-9]?|[0-9][+-]?)$/.exec(raw);
    if (block) {
      const style = block[1];
      const chomping = raw.includes('+') ? 'keep' : raw.includes('-') ? 'strip' : 'clip';
      const explicit = /[0-9]/.exec(raw);
      let indent = explicit ? Number(explicit[0]) : -1;
      const collected = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        if (lines[j].trim() === '') {
          collected.push('');
          continue;
        }
        const lead = lines[j].length - lines[j].trimStart().length;
        if (lead === 0) break;
        if (indent === -1) indent = lead;
        if (lead < indent) break;
        collected.push(lines[j].slice(indent));
      }
      let trailingBlanks = 0;
      while (collected.length > 0 && collected[collected.length - 1] === '') {
        collected.pop();
        trailingBlanks += 1;
      }
      out[key] = joinBlockScalar(collected, style, chomping, trailingBlanks);
      i = j - 1;
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

// The turn header the importer writes, matched one line at a time so a fenced
// block can be excluded. The timestamp group is lazy so the first middle dot
// separates it from the message id, which leaves an id free to contain one.
const TURN_HEADER = /^\*\*(Me|Assistant)\*\* \((.*?) · (.*)\):$/;
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

// The separator envelope-to-gbrain.mjs writes between two turns: a blank line,
// a `---` rule, a blank line. It is the one structural signal on the page that
// separates a real turn boundary from a transcript pasted into a code block,
// and it decides the only case fence state cannot decide on its own - a
// header-shaped line reached while a fence is open.
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

function readPageBody(body, warn) {
  const lines = body.split('\n');
  const { fenced, headers, quotedHeaders } = scanFencesAndHeaders(lines, warn);

  // Reported for the same reason a quoted timeline sentinel is: the script made
  // a call about what a line means, and the operator gets to see it.
  for (const at of quotedHeaders) {
    warn(`the line \`${lines[at].trim()}\` at body line ${at + 1} sits inside a fenced code block, so it was read as sample text and not as a turn.`);
  }

  const sentinels = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    if (TIMELINE_SENTINELS.has(lines[i].trim())) sentinels.push(i);
  }

  // Cut only at a sentinel that no speaker turn follows. gbrain writes the
  // timeline after the whole body, so a sentinel with turns below it is a
  // message quoting the marker - the case that used to destroy every later
  // turn in silence.
  const lastHeader = headers.length > 0 ? headers[headers.length - 1].line : -1;
  let cut = lines.length;
  let hasTimeline = false;
  for (const at of sentinels) {
    if (at > lastHeader) {
      cut = at;
      hasTimeline = true;
      break;
    }
    warn(`the line \`${lines[at].trim()}\` at body line ${at + 1} has speaker turns after it, so it is message text and not a timeline boundary; the body was not cut there.`);
  }

  const messages = [];
  let droppedEmpty = 0;
  let nulledTimestamps = 0;
  for (const [i, header] of headers.entries()) {
    const hasNext = i + 1 < headers.length;
    const end = hasNext ? headers[i + 1].line : cut;
    // Rebuild the exact slice between two headers, trailing newline included,
    // so the separator strip below sees what the importer wrote.
    let raw = lines.slice(header.line + 1, end).join('\n');
    if (hasNext) {
      // Between two turns the importer writes exactly one `---` separator line.
      // Strip that one occurrence, never a `---` the message itself ended with
      // after the last turn.
      raw = `${raw}\n`.replace(/\n\n---\n\n$/, '');
    }
    const id = header.match[3];
    const text = raw.trim();
    if (text === '') {
      droppedEmpty += 1;
      warn(`message ${JSON.stringify(id)} has no text; dropped (envelope-v0 requires at least one character).`);
      continue;
    }
    // The importer writes the literal `no timestamp` when the envelope had
    // none. Read it back as the null the schema asks for, not as prose.
    let ts = null;
    if (header.match[2] !== NO_TIMESTAMP) {
      ts = asRfc3339DateTime(header.match[2]);
      if (ts === null) {
        nulledTimestamps += 1;
        warn(`message ${JSON.stringify(id)} carries ${JSON.stringify(header.match[2])} where a turn header's timestamp goes; it is not an RFC 3339 date-time, so ts was written as null.`);
      }
    }
    messages.push({ id, role: header.match[1] === 'Me' ? 'user' : 'assistant', ts, text });
  }

  return { messages, title: titleFromBody(lines, fenced), hasTimeline, droppedEmpty, nulledTimestamps };
}

const files = markdownFiles(pagesDir);
const conversations = [];
const providers = [];
const seenIds = new Set();
let skippedNotConversation = 0;
let skippedNoFrontmatter = 0;
let skippedNoMessages = 0;
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
  const read = readPageBody(page.body, warn);
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
if (skippedNoFrontmatter || skippedNotConversation || skippedNoMessages || droppedEmptyMessages) {
  console.warn(`scanned ${files.length} markdown file(s): ${skippedNoFrontmatter} without frontmatter, ${skippedNotConversation} not type conversation, ${skippedNoMessages} without speaker turns, ${droppedEmptyMessages} empty message(s) dropped.`);
}
// Two losses that leave the output conforming and would otherwise be invisible.
if (droppedTimelines) {
  console.warn(`note: ${droppedTimelines} page(s) carried a gbrain timeline section; envelope-v0 has no field for it, so it was not exported.`);
}
if (nulledTimestamps) {
  console.warn(`note: ${nulledTimestamps} turn timestamp(s) were not RFC 3339 date-times and were written as null.`);
}
