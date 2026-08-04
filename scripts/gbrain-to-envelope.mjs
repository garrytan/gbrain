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
 *   A single-provider page set writes [out.mve.json] itself. A set spanning
 *   several providers writes one envelope per provider beside it
 *   (out.chatgpt.mve.json, out.claude.mve.json, ...), each named on stdout
 *   with its own counts; see the source_provider notes below.
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
 * clock is recomputed from its `ts` - the same derivation the importer used
 * to write it (headerClock below is a code-identical copy from
 * envelope-to-gbrain.mjs, comments elided; keep them in lockstep) - and a
 * header-shaped line is a boundary ONLY when
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
 * the end of the turn it opened in. On the recorded path the scan runs in
 * stages so that balanced fences genuinely win: the first honors every fence
 * that closes, keeping even a quoted line that carries the next expected
 * clock as sample text - a pasted transcript quoting this very conversation
 * must not steal a boundary from outside its fence. Only when that stage
 * anchors fewer turns than the record holds is some fence plausibly
 * swallowing a real boundary, and then each fence is tried ALONE: the fence
 * to lose is the one whose demotion by itself anchors every recorded turn,
 * which is what keeps a balanced fence that merely quotes a boundary from
 * being demoted when a different fence caused the shortfall. Only if no
 * single demotion suffices does a greedy pass demote every fence still open
 * at a next-expected-clock line. Each demotion is warned, naming the line
 * the fence opened on; a fence still open at the end of the page is demoted
 * in every stage. All of it is the same trade: a fence must never be allowed
 * to swallow the turns after it, and a spurious stretch of ordinary text is
 * a far smaller failure than a turn deleted in silence. On
 * the legacy path the fence-versus-boundary signal is the blank / `---` /
 * blank separator the old importer wrote between turns, as before - and note
 * the demotion's reach, which an earlier revision of this header overstated:
 * the separator decides only WHETHER a spanning fence loses. Once it has
 * lost, every header-shaped line it had covered is read as an ordinary turn
 * header, separator above it or not, so a header-shaped line quoted inside
 * the demoted stretch does become a turn. (Measured: a fence spanning one
 * separator-preceded header with a separatorless header-shaped line above it
 * yields three messages, the middle one lifted from the quoted line, with the
 * demotion warned on stderr.) On the recorded path the same demotion is
 * narrower: an exposed line still becomes a boundary only by carrying the
 * next expected clock.
 *
 * The body is cut at a gbrain timeline sentinel, in all four forms gbrain's
 * own findTimelineSplitIndex accepts (src/core/markdown.ts, mirrored in
 * timelineSentinelAt below): `<!-- timeline -->`, `<!--timeline-->`, the
 * decorated rule under /^---\s+timeline\s+---$/i in any case and spacing, and
 * a bare `---` with content above it whose next non-blank line is a
 * `## Timeline` or `## History` heading. So a page's timeline never becomes
 * message text under any spelling gbrain itself would split on. Only a
 * sentinel with no accepted turn after it is treated as a boundary; one with
 * turns below it is message text and is reported rather than cut at - where
 * gbrain's parser cuts at the FIRST hit and truncates every turn below, the
 * one deliberate divergence, made because a quoted sentinel must not delete
 * the turns after it. A sentinel standing alone on its line INSIDE the final
 * message still cuts - from this side of the page it is indistinguishable
 * from gbrain's real delimiter, and gbrain's own parser reads that page the
 * same way - and the cut is what the timeline note on stderr is counting.
 * The bare-`---` form is safe against the legacy turn separator because of
 * its heading lookahead: a separator's next non-blank line is a turn header,
 * never the Timeline/History heading, and a final message ending in a plain
 * `---` with prose (or nothing) below keeps its bytes.
 *
 * Frontmatter is read line by line: top-level scalars only, in the plain,
 * single-quoted, double-quoted (escapes decoded, including `\U` beyond the
 * BMP), folded (`>`) and literal (`|`) block forms - plus, alone among
 * nested structures, the `messages:` block sequence described above. A UTF-8
 * BOM is stripped and CRLF normalized before any of it, as gray-matter does.
 * Trailing `# comments` are stripped the way js-yaml strips them - a reader
 * that kept them read `type: conversation # imported` as a different type
 * and `id: # placeholder` as an invented string id. Items accept the
 * importer's JSON-quoted scalars, the single-quoted / plain / block-scalar
 * forms gbrain's js-yaml rewrite produces (including `|-` literal ids
 * carrying newlines and whitespace-only content lines, verified against
 * js-yaml's own emissions), items at column 0 or indented, and `null`;
 * member keys beyond `id` and `ts` are ignored so a future third field does
 * not break the read; a quoted scalar that does not close on its own line is
 * refused (js-yaml folds long values into block scalars rather than wrapping
 * quotes, so that shape indicates a page this script does not understand).
 * One stated limit: this line reader is more PERMISSIVE than js-yaml - a
 * page whose frontmatter js-yaml rejects outright (an unknown escape, a
 * plain scalar opening with `@` or a backtick) may still export here under
 * this reader's simpler rules, where gbrain itself would call the page a
 * parse error.
 *
 * `title` falls back to the body's first H1 when frontmatter carries none,
 * the same precedence gbrain's own parser uses (src/core/markdown.ts,
 * inferTitleFromBody), and only then to `Untitled conversation` - a
 * whitespace-only title takes that fallback too, so a conversation titled
 * with pure whitespace comes back renamed. `title` and `source` are trimmed;
 * `memvelope_conversation_id` is VERBATIM, like the recorded message ids and
 * timestamps - the importer records ids verbatim precisely so that values
 * differing only by surrounding whitespace stay distinct, and trimming here
 * would collapse them back together on the way out.
 *
 * What survives the round trip envelope -> envelope-to-gbrain.mjs -> here,
 * measured on the recorded format (see STATUS for the corpus):
 *   - conversation id and title, including a null id
 *   - message id, role, timestamp and text, verbatim - including ids carrying
 *     newlines, YAML syntax, or a whole frontmatter block, and timestamps at
 *     full sub-second resolution with their original offsets
 *   - meta.source_provider, per envelope: every conversation travels in the
 *     envelope of its own page's `source:`
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
 *     which is read as the title fallback described above. Reported on
 *     stderr when non-blank content is dropped this way.
 *   - Everything after a timeline sentinel that no accepted turn follows -
 *     a real gbrain timeline, or the tail of a final message that quoted
 *     the sentinel - in any of the four forms above, the bare-`---` form
 *     included: a final message that legitimately ends with `---` and a
 *     `## Timeline` heading is cut, because gbrain's own parser reads that
 *     page the same way. envelope-v0 has no field for a timeline. Each cut
 *     is warned per page, naming the body line, and tallied in the closing
 *     note.
 *   - A recorded `ts` that is not a strict RFC 3339 `date-time` - which is
 *     what the schema's `format: date-time` names. Emitted as null, with a
 *     warning, rather than as a value that fails validation. That includes a
 *     second of 60 anywhere but the instant a leap second is inserted; see
 *     asRfc3339DateTime below. A recorded `ts: null` stays null, silently -
 *     that is the agreed spelling of "the export had no timestamp", not a
 *     loss. On the legacy path the same rule judges the header parenthetical,
 *     and the literal `no timestamp` is the agreed null there.
 *   - A message whose text contains a line shaped like a turn header and
 *     carrying the very minute the NEXT message is recorded at. That line
 *     still steals the boundary, and the damage is worse than a tidy split:
 *     the forged line itself is consumed as the boundary (those bytes are
 *     deleted from the text); the stolen turn's ROLE comes from the forged
 *     line's speaker, not from any record, so an assistant message can come
 *     back as user or vice versa; the real header below is read as prose
 *     into the wrong turn's text; and a message left with NO text - one
 *     whose whole text was the forged line - is dropped outright with its
 *     `{id, ts}` entry, taking created_at/updated_at with it when it sat at
 *     an end. Every step is warned on stderr, and the ids and timestamps of
 *     the surviving messages stay aligned. This is the residue of defect D2,
 *     and the bar for forging is lower than "predict the future": two
 *     messages inside one minute make the next expected clock equal the
 *     current header's own clock, and a null-or-unusable `ts` makes it the
 *     page date at 00:00 - visible on the page itself.
 *   - CRLF line endings, normalized to LF on read.
 *
 * A page with no `memvelope_conversation_id` emits `id: null` rather than a
 * synthesized id. envelope-v0 permits null there and tells converters not to
 * invent one.
 *
 * `meta.source_provider` names ONE provider for a whole envelope, so a page
 * set spanning several is written as one envelope per provider - a mixed
 * directory cannot be described by one file without falsifying someone's
 * `source:`. (This script used to keep the first provider in sorted path
 * order for everyone; re-importing that envelope stamped the winner onto
 * every losing page's `source:` at exit 0, and envelope-v0 carries no
 * per-conversation provider field that could keep the truth.) The filename
 * token is the provider with everything outside [A-Za-z0-9._-] replaced by
 * `-`, deduplicated case-insensitively, so a hostile `source:` cannot steer
 * the write and case-only twins still get two files. A single-provider set is
 * unchanged: one file, at the path asked for.
 *
 * Pages carrying no `source:` key are their own group, never folded into a
 * named provider's envelope - absence of evidence is not membership, and the
 * fold would stamp the neighbour's provider onto them at re-import, the same
 * falsification through absence rather than collision. They ride under the
 * literal `unknown` - required because meta.source_provider cannot be
 * omitted, defined by no provider registry - warned on stderr naming the
 * token, in `out.unknown.mve.json` when named providers are present or at
 * the asked-for path when nothing in the set names one. Round trip,
 * measured: every conversation carrying a `memvelope_conversation_id`
 * re-imports into the very directory it came from and refreshes its page in
 * place, byte-identical - check 2 matches per-conversation ids - so no
 * page's `source:` changes hands. The residue sits on id-less pages: a
 * native gbrain page has no memvelope id, its conversation travels as
 * `id: null`, and re-importing the `unknown` envelope cannot find the
 * original page to refresh - it writes a NEW positional page
 * (`<date>-conv-N.md`) carrying `source: "unknown"` and leaves the original
 * untouched. A duplicate page, never a falsified one - the importer's
 * standing behavior for a null id, not new here.
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
 * STATUS: measured 2026-08-02 against gbrain v0.42.72.1, on two paths - the
 * short one (envelope -> envelope-to-gbrain.mjs -> here) and the long one
 * through a throwaway HOME-redirected PGLite brain (envelope -> importer ->
 * `gbrain import` -> `gbrain export --dir` -> here), so the pages read are
 * the ones gbrain's own parseMarkdown / serializeMarkdown pair really
 * produces. The repo's sample fixture round-trips deep-equal on both paths
 * with zero stderr bytes. A 3-conversation / 17-message probe - ids carrying
 * an embedded newline, a whole `---`/`type:`/`---` block, a middle dot,
 * trailing space, emoji, and a folding-length 79-character value; timestamps
 * with microseconds, a +05:30 offset, and null; two messages sharing one
 * minute; a whole-line quoted sentinel mid-conversation; fences spanning
 * turns - comes back with 17/17 messages and every id, role, ts and text
 * verbatim on both paths. gbrain's serializer hands the array back as
 * literal (`|-`) block-scalar ids, a folded (`>-`) long id, single-quoted
 * timestamps and reordered top-level keys; all of it reads. The only fields
 * that moved are the documented ones: created_at / updated_at (replaced by
 * the first and last message timestamps) and one message's trailing newline
 * (trimmed). One long-path caveat sits UPSTREAM of this script: gbrain's own
 * parse/serialize pair re-spaces a whole-line HTML comment inside message
 * text (blank lines inserted around a sentinel written tight against its
 * neighbours) and swallows a sentinel on the last line of a body with no
 * real timeline - the probe's quoted sentinel was blank-padded, the one
 * spacing gbrain preserves, so those movements do not show above; they are
 * gbrain's, not this reader's.
 *
 * STATUS ADDENDUM, 2026-08-04, after the rebase onto the master that merged
 * the importer (#3788): the short path above re-verified against the merged
 * importer - the sample fixture round-trips deep-equal, zero stderr. The
 * per-provider fan-out measured on a mixed directory (chatgpt + claude
 * imports plus a native source-less page): three envelopes, every one
 * schema-conforming; re-importing all three into the same directory left
 * both id-carrying pages byte-identical and the native page untouched, plus
 * the one documented duplicate a null id mints. The sentinel closure is
 * canonical-path-invisible by construction: gbrain's serializer emits only
 * `<!-- timeline -->` (measured 2026-08-03 against a real brain), so the
 * decorated and bare-rule forms arrive only on hand-edited or legacy pages -
 * which is where they were exporting a timeline as message text.
 *
 * Conformance in CI is checked by test/gbrain-to-envelope.test.ts, which
 * validates against the published envelope-v0 JSON Schema vendored
 * byte-for-byte at test/fixtures/memvelope/envelope-v0.schema.json (sha256
 * 423813d563de394cde2798848e90fdadc85ba52458f5c18b1da897e6c8ae52b9, identical
 * across memvelope.com, raw.githubusercontent.com/memvelope/memvelope@main and
 * the memvelope package). The test walks those bytes with a draft-07 subset it
 * implements in full and refuses any keyword it does not, so a constraint added
 * upstream turns the suite red instead of going unchecked. No validator
 * dependency is added. Both round-trip outputs above additionally validate
 * under ajv + ajv-formats in full mode, with the validator first proven
 * non-trivial on a known-bad document.
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
  if (chomping === 'keep') {
    // The final content line contributes one break only if there IS content:
    // `|+` over a single empty line is the value "\n", not "\n\n".
    return value + '\n'.repeat(trailingBlanks + (contentLines.length > 0 ? 1 : 0));
  }
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
      // A whitespace-only line's content beyond the block indent is real:
      // js-yaml writes the ` ` segment of "a\n \nb" as indent plus one space,
      // and collapsing it to an empty line silently corrupted the value. At
      // or below the indent (or before the indent is known) it is empty.
      collected.push(indent !== -1 && lines[j].length > indent ? lines[j].slice(indent) : '');
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
    // The `s` flag lets `.` cross U+2028/U+2029. JSON.stringify does not
    // escape those two line terminators, so a conforming envelope value can
    // put one RAW inside a frontmatter line; without the flag the line
    // silently failed to parse and the id or title vanished with zero stderr.
    const m = /^([A-Za-z_][A-Za-z0-9_-]*): ?(.*)$/s.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const raw = stripTrailingComment(m[2].trim());

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

// What a plain (unquoted) YAML scalar means to js-yaml 3.14's default schema
// - the reader and writer gbrain actually uses: null, boolean and number
// forms are not strings. The importer JSON-quotes every string it takes from
// an envelope and js-yaml re-quotes any string that resolves to one of these
// on the way back out, so an unquoted `id: 123` really is a number and
// refusing it is correct - reading it as the string "123" would fabricate an
// id the record does not hold. The int and float checks below are ports of
// js-yaml 3.14's own resolveYamlInteger / resolveYamlFloat (an approximating
// regex here once refused `089` - a STRING to js-yaml, which its dumper
// re-emits unquoted - and dropped the whole conversation after one brain
// cycle). js-yaml's octal is the 1.1 leading-zero form, `0o` is a string,
// trailing underscores make a string, and `yes`/`no`/`on`/`off` are strings.
const DEC_DIGIT = /[0-9]/;

function isJsYamlInteger(data) {
  const max = data.length;
  let index = 0;
  let hasDigits = false;
  if (max === 0) return false;
  let ch = data[index];
  if (ch === '-' || ch === '+') ch = data[(index += 1)];
  if (ch === '0') {
    if (index + 1 === max) return true;
    ch = data[(index += 1)];
    if (ch === 'b') {
      for (index += 1; index < max; index += 1) {
        ch = data[index];
        if (ch === '_') continue;
        if (ch !== '0' && ch !== '1') return false;
        hasDigits = true;
      }
      return hasDigits && ch !== '_';
    }
    if (ch === 'x') {
      for (index += 1; index < max; index += 1) {
        ch = data[index];
        if (ch === '_') continue;
        if (!/[0-9a-fA-F]/.test(ch)) return false;
        hasDigits = true;
      }
      return hasDigits && ch !== '_';
    }
    for (; index < max; index += 1) {
      ch = data[index];
      if (ch === '_') continue;
      if (!/[0-7]/.test(ch)) return false;
      hasDigits = true;
    }
    return hasDigits && ch !== '_';
  }
  if (ch === '_') return false;
  for (; index < max; index += 1) {
    ch = data[index];
    if (ch === '_') continue;
    if (ch === ':') break;
    if (!DEC_DIGIT.test(ch)) return false;
    hasDigits = true;
  }
  if (!hasDigits || ch === '_') return false;
  if (ch !== ':') return true;
  return /^(:[0-5]?[0-9])+$/.test(data.slice(index));
}

const JS_YAML_FLOAT = new RegExp(
  '^(?:[-+]?(?:0|[1-9][0-9_]*)(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?' +
  '|\\.[0-9_]+(?:[eE][-+]?[0-9]+)?' +
  '|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\\.[0-9_]*' +
  '|[-+]?\\.(?:inf|Inf|INF)' +
  '|\\.(?:nan|NaN|NAN))$',
);

function isPlainNonString(data) {
  if (data === 'true' || data === 'True' || data === 'TRUE') return true;
  if (data === 'false' || data === 'False' || data === 'FALSE') return true;
  if (isJsYamlInteger(data)) return true;
  return JS_YAML_FLOAT.test(data) && data[data.length - 1] !== '_';
}

// A YAML comment starts at a `#` that opens the value or follows whitespace,
// outside any quoted run. js-yaml strips comments on read, so a reader that
// kept them was inventing values: `type: conversation # imported` must read
// as `conversation`, and `id: # placeholder` is a null id, not the string
// "# placeholder".
function stripTrailingComment(raw) {
  if (raw.startsWith('#')) return '';
  let quote = null;
  let escaped = false;
  let closedQuoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        quote = null;
        closedQuoted = true;
      }
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        if (raw[i + 1] === "'") i += 1;
        else {
          quote = null;
          closedQuoted = true;
        }
      }
      continue;
    }
    // A quote only opens a quoted scalar at the start of the value; later it
    // is ordinary content of a plain scalar.
    if (i === 0 && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }
    // In a plain scalar a comment needs whitespace before the '#'; after a
    // closed quoted scalar YAML ends the value at a '#' with or without one
    // ('"a"# c' reads as "a" to js-yaml).
    if (ch === '#' && (closedQuoted || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i).trim();
    }
  }
  return raw;
}

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
  if (isPlainNonString(raw)) return { value: { nonString: raw } };
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

  const inline = stripTrailingComment((/^messages: ?(.*)$/s.exec(lines[at]))[1].trim());
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

    // Items may sit at column 0 (valid YAML, the noArrayIndent style) or
    // indented (what the importer and js-yaml's default write); the first
    // item fixes the indent for the rest.
    const item = /^(\s*)- (.*)$/s.exec(line);
    if (item && (itemLead === -1 || item[1].length === itemLead)) {
      if (itemLead === -1) itemLead = item[1].length;
      current = {};
      items.push(current);
      const first = readMember(item[2].trim(), itemLead + 2);
      if (first.error) return { present: true, error: first.error };
      continue;
    }
    // A new top-level key ends the sequence.
    if (lead === 0) break;
    if (current === null) return { present: true, error: `a line before the first item (${JSON.stringify(line)})` };
    if (lead <= itemLead) return { present: true, error: `an indentation this script does not read (${JSON.stringify(line)})` };
    const member = readMember(line.trim(), lead);
    if (member.error) return { present: true, error: member.error };
  }

  // One member line, already trimmed, belonging to `current`. `memberLead` is
  // the column its key starts at, needed when its value is a block scalar.
  function readMember(text, memberLead) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*): ?(.*)$/s.exec(text);
    if (!m) return { error: `an item line that is not a key: value pair (${JSON.stringify(text)})` };
    const key = m[1];
    const raw = stripTrailingComment(m[2].trim());
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
// The header-clock derivation, a code-identical copy from
// envelope-to-gbrain.mjs (that file's longer comments elided) so the expected
// clock recomputed here is the clock the importer wrote. If one of these
// functions changes, change both files - the round-trip tests fail loudly (a
// clock mismatch skips the page) if they drift.
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
// gbrain's findTimelineSplitIndex (src/core/markdown.ts) accepts four forms;
// the set holds the exact spellings, DECORATED_SENTINEL the case/space-tolerant
// `--- timeline ---` family, and timelineSentinelAt adds the fourth - a bare
// `---` whose next non-blank line is a `## Timeline`/`## History` heading.
const TIMELINE_SENTINELS = new Set(['<!-- timeline -->', '<!--timeline-->', '--- timeline ---']);
const DECORATED_SENTINEL = /^---\s+timeline\s+---$/i;
const TIMELINE_HEADING = /^##\s+(timeline|history)\b/i;

// Decision-identical to gbrain's own reading (findTimelineSplitIndex; keep in
// lockstep like headerClock): a bare `---` is a sentinel only when something
// stands above it and the next non-blank line is the Timeline/History heading.
// The two conditions are checked heading-first here because a legacy body puts
// a `---` separator between every pair of turns, and the lookahead ends at the
// very next non-blank line where the leading-content scan walks the whole
// prefix. The caller keeps its fence mask: a fenced line is sample text, never
// a candidate - the one deliberate divergence from gbrain's fence-blind parser,
// and it predates this predicate.
function timelineSentinelAt(lines, i) {
  const trimmed = lines[i].trim();
  if (TIMELINE_SENTINELS.has(trimmed) || DECORATED_SENTINEL.test(trimmed)) return true;
  if (trimmed !== '---') return false;
  for (let j = i + 1; j < lines.length; j += 1) {
    const next = lines[j].trim();
    if (next.length === 0) continue;
    if (!TIMELINE_HEADING.test(next)) return false;
    // gbrain skips a rule with nothing above it, so a body OPENING on
    // `---` + `## Timeline` is content there and stays content here.
    return lines.slice(0, i).join('\n').trim().length > 0;
  }
  return false;
}
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
// `2026-12-31T23:59:60+01:00` both fail it, and both are rejected by ajv +
// ajv-formats 3.0.1 in strict/full mode - which is what a consumer validating
// the published schema runs. The whole 11-value boundary set was measured
// against ajv 8.20.0 on 2026-08-02 and re-measured against 8.18.0 the same
// day; both agree with this function value for value.
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

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/s;

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
// for position k. When `demoteOnClock` is set, that same rule is the
// fence-demotion signal - a fence still open at a line carrying the next
// expected clock loses; when it is not set, such a line stays sample text.
// A fence still open at the end of the body is demoted either way (it would
// otherwise mask the timeline and title scans with no turn to bound it).
function scanRecordedPass(lines, expected, disabled, demoteOnClock) {
  const fenced = new Array(lines.length).fill(false);
  const boundaries = [];
  const proseHeaders = [];
  const quotedHeaders = [];
  const openers = [];
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
        open = { char: fence[1][0], len: fence[1].length, at: i, entry: { at: i, closedAt: -1 } };
        openers.push(open.entry);
        fenced[i] = true;
      }
      continue;
    }
    const header = RECORDED_HEADER.exec(lines[i]);
    if (demoteOnClock && header && boundaries.length < expected.length && header[2] === expected[boundaries.length]) {
      return { reopen: { at: open.at, spanningAt: i } };
    }
    if (header) quotedHeaders.push(i);
    fenced[i] = true;
    if (fence && fence[1][0] === open.char && fence[1].length >= open.len && fence[2].trim() === '') {
      open.entry.closedAt = i;
      open = null;
    }
  }
  if (open !== null) return { reopen: { at: open.at, spanningAt: -1 } };
  return { reopen: null, fenced, boundaries, proseHeaders, quotedHeaders, openers };
}

// Balanced fences genuinely win, in two stages. Stage 1 honors every fence
// that closes: even a quoted line carrying the next expected clock stays
// sample text inside one - a pasted transcript quoting this very
// conversation must not steal a boundary from outside its fence. (Fences
// still open at the end of the body are demoted in every stage.) Only when
// stage 1 anchors fewer turns than the record holds is some fence plausibly
// swallowing a real boundary - and then each fence is tried ALONE: the fence
// to lose is the one whose demotion by itself anchors every recorded turn.
// Trying them one at a time is what keeps a balanced fence that merely
// QUOTES a boundary from being demoted when a different fence caused the
// shortfall: demoting the quoting fence cannot recover the turn the other
// fence swallowed, so its trial fails and the right fence is found. Only if
// no single demotion suffices (two swallowing fences, or a genuinely
// mismatched body) does the greedy clock-armed demotion run as a last
// resort. Warnings are buffered per attempt and only the attempt whose
// result is used speaks.
function scanRecordedFences(lines, expected, warn) {
  const runToCompletion = (seed, demoteOnClock) => {
    const disabled = new Set(seed);
    const buffered = [];
    for (;;) {
      const pass = scanRecordedPass(lines, expected, disabled, demoteOnClock);
      if (pass.reopen === null) return { pass, buffered };
      disabled.add(pass.reopen.at);
      buffered.push(pass.reopen.spanningAt === -1
        ? `an unclosed code fence opens at body line ${pass.reopen.at + 1}; read as ordinary text so the turns after it are not lost.`
        : `the code fence opened at body line ${pass.reopen.at + 1} is still open at the turn header on body line ${pass.reopen.spanningAt + 1}; a fence does not span a turn, so it was read as ordinary text and that turn was kept.`);
    }
  };
  const first = runToCompletion([], false);
  if (first.pass.boundaries.length === expected.length) {
    for (const message of first.buffered) warn(message);
    return first.pass;
  }
  for (const opener of first.pass.openers) {
    // The opener and its closer are disabled TOGETHER: dropping only the
    // opener re-pairs every later fence line (the old closer becomes a new
    // opener), which let a wrong trial anchor the right COUNT of turns on
    // the wrong lines. Removing the pair leaves every other fence exactly
    // where the first stage saw it, so a wrong trial genuinely fails.
    const seed = opener.closedAt === -1 ? [opener.at] : [opener.at, opener.closedAt];
    const trial = runToCompletion(seed, false);
    if (trial.pass.boundaries.length === expected.length) {
      warn(`the code fence opened at body line ${opener.at + 1} hides the header of a recorded turn; a fence does not span a turn, so it was read as ordinary text and that turn was kept.`);
      for (const message of trial.buffered) warn(message);
      return trial.pass;
    }
  }
  const second = runToCompletion([], true);
  for (const message of second.buffered) warn(message);
  return second.pass;
}

// gbrain's own title precedence, minus the filename fallback this script must
// not use: frontmatter `title:` first, then the body's first H1.
function titleFromBody(lines, fenced) {
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const m = /^#(?!#)\s+(.+?)\s*$/s.exec(lines[i]);
    if (m) return m[1].replace(/\s+#+\s*$/, '').trim();
  }
  return '';
}

// The timeline cut and the slice-into-messages step, shared by both paths.
// `anchors` carries each accepted boundary's line; `build` turns a boundary and
// its raw text into a message or null (null = dropped, already warned).
function cutAndSlice(lines, anchors, fenced, warn, stripLegacySeparator, build) {
  // Body content ahead of the first turn header (except the H1, which is the
  // title fallback) is not exported - a documented loss, but it was the one
  // loss class with no stderr trace at all, so it is reported here.
  if (anchors.length > 0) {
    let h1Seen = false;
    const preamble = [];
    for (let i = 0; i < anchors[0].line; i += 1) {
      if (fenced[i] || lines[i].trim() === '') continue;
      if (!h1Seen && /^#(?!#)\s+/.test(lines[i])) {
        h1Seen = true;
        continue;
      }
      preamble.push(i);
    }
    if (preamble.length > 0) {
      warn(`${preamble.length} line(s) of body content before the first turn header were not exported (first at body line ${preamble[0] + 1}).`);
    }
  }

  const sentinels = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    if (timelineSentinelAt(lines, i)) sentinels.push(i);
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
      // Named per page, not only tallied in the aggregate note: the tail cut
      // away here may be a real gbrain timeline or the end of a message that
      // quoted the sentinel - either way the operator can find the page.
      warn(`the body was cut at the timeline sentinel on body line ${at + 1}; nothing after it was exported.`);
      break;
    }
    warn(`the line \`${lines[at].trim()}\` at body line ${at + 1} has speaker turns after it, so it is not a timeline boundary; the body was not cut there.`);
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
      // remaining turns and their entries stays aligned. Worded as what this
      // side can see: the SOURCE message may well have had text - a message
      // whose whole text was consumed as a forged boundary, or cut away at a
      // sentinel, lands here too, and "has no text" would be false about it.
      droppedEmpty += 1;
      warn(`no text remained for message ${JSON.stringify(id)} between its turn header and the next boundary; dropped (envelope-v0 requires at least one character). If the source message had text, it was consumed as a boundary line or cut at a sentinel.`);
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
// provider (the page's trimmed `source:`, or null when it carries none) ->
// { conversations, messageCount }. Insertion order is first appearance in
// sorted path order - what the old "first provider" collapse meant by first;
// the difference is that nobody wins anymore.
const groups = new Map();
const seenIds = new Set();
let skippedNotConversation = 0;
let skippedNoFrontmatter = 0;
let skippedNoMessages = 0;
let sawSourceKey = false;
let skippedUnreadableRecord = 0;
let skippedJoinMismatch = 0;
let droppedEmptyMessages = 0;
let droppedTimelines = 0;
let nulledTimestamps = 0;

for (const file of files) {
  // Normalize to LF up front. Every match below is line-anchored, so a page
  // saved with CRLF would otherwise fail to parse as a whole and be reported as
  // frontmatter-less. The cost is stated in the header: CRLF inside a message
  // comes back as LF.
  // A UTF-8 BOM is stripped like CRLF is normalized: gray-matter strips it
  // too, so a BOM page is a first-class conversation to gbrain, and refusing
  // to see its frontmatter made the whole conversation vanish into the
  // "without frontmatter" count.
  const page = splitPage(readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'));
  if (!page) {
    skippedNoFrontmatter += 1;
    continue;
  }
  const front = parseFrontmatter(page.front);
  if (front.type !== 'conversation') {
    skippedNotConversation += 1;
    continue;
  }
  // Noted before any skip below, so the no-provider warning can tell "no page
  // carries a source: key" apart from "the pages that carry one were skipped".
  if (typeof front.source === 'string' && front.source.trim() !== '') sawSourceKey = true;
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
  const provider = typeof front.source === 'string' && front.source.trim() !== '' ? front.source.trim() : null;
  // Never synthesize. An absent id is null, which the schema permits and the
  // spec requires of converters.
  // VERBATIM, not trimmed. The importer records the id verbatim precisely so
  // that two ids differing only by surrounding whitespace stay distinct -
  // trimming here re-collapsed them on the way out, the exact ambiguity that
  // once let one import destroy another. (Blank-or-absent still maps to null:
  // the importer never writes the key for an id that trims to nothing.)
  const id = typeof front.memvelope_conversation_id === 'string' && front.memvelope_conversation_id.trim() !== ''
    ? front.memvelope_conversation_id
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
  let group = groups.get(provider);
  if (group === undefined) {
    group = { conversations: [], messageCount: 0 };
    groups.set(provider, group);
  }
  group.conversations.push({
    id,
    title,
    // The page's `date` is a day, not a date-time, so it cannot fill these.
    // First and last message timestamps are the only date-times on the page.
    created_at: read.messages[0].ts,
    updated_at: read.messages[read.messages.length - 1].ts,
    messages: read.messages,
  });
  group.messageCount += read.messages.length;
}

// One envelope per provider. meta.source_provider names ONE provider for a
// whole envelope, so a mixed directory cannot be described by one file without
// falsifying someone's `source:` - the old collapse-to-first did exactly that,
// and re-importing the collapsed envelope stamped the winner onto every losing
// page at exit 0, with nothing on disk retaining the truth. Pages with no
// `source:` at all are their own group under the placeholder: absence of
// evidence is not membership in whichever provider the directory also holds,
// and folding them in would be the same falsification arriving through
// absence rather than collision.
const named = [...groups.keys()].filter((p) => p !== null);

function envelopeFor(provider, group) {
  return {
    memvelope: 'envelope-v0',
    meta: {
      source_provider: provider ?? FALLBACK_PROVIDER,
      conversation_count: group.conversations.length,
      message_count: group.messageCount,
    },
    conversations: group.conversations,
  };
}

// `out.mve.json` -> `out.<token>.mve.json`, keeping whichever json suffix the
// operator chose. The token is the provider with everything outside
// [A-Za-z0-9._-] replaced by `-`, so a hostile `source:` cannot steer the
// write out of the output directory, then deduplicated case-insensitively so
// providers differing only by case still get two files on the
// case-insensitive filesystems macOS ships - and the same two names
// everywhere else.
function providerOutPath(basePath, token) {
  const mve = /^(.*)\.mve\.json$/.exec(basePath);
  if (mve) return `${mve[1]}.${token}.mve.json`;
  const json = /^(.*)\.json$/.exec(basePath);
  if (json) return `${json[1]}.${token}.json`;
  return `${basePath}.${token}`;
}

if (groups.size <= 1) {
  // A single-provider page set (or an empty one): one file, the same name and
  // the same words as before the fan-out existed.
  const provider = named[0] ?? null;
  const group = groups.get(provider) ?? { conversations: [], messageCount: 0 };
  // envelope-v0 requires meta.source_provider, so it cannot be omitted the way
  // meta.source_export_date is. Minting a token no registry defines is a
  // guess, and a guess gets reported like every other lossy edge here.
  if (provider === null) {
    // Two different situations, two true statements: pages with no source: key
    // at all, versus sourced pages that were all skipped before they could
    // contribute one - telling the second audience to "set source:" would be
    // advice about a key they already set.
    console.warn(sawSourceKey
      ? `warning: every page carrying a \`source:\` key was skipped before it could contribute one, and envelope-v0 requires meta.source_provider; wrote the placeholder ${JSON.stringify(FALLBACK_PROVIDER)}, which is not a registered provider token. Fix the skipped pages to name the real provider.`
      : `warning: no page carries a \`source:\` key, and envelope-v0 requires meta.source_provider; wrote the placeholder ${JSON.stringify(FALLBACK_PROVIDER)}, which is not a registered provider token. Set \`source:\` on the pages to name the real provider.`);
  }
  writeFileSync(outPath, JSON.stringify(envelopeFor(provider, group), null, 2) + '\n');
  console.log(`wrote ${group.conversations.length} conversation(s), ${group.messageCount} message(s) to ${outPath}`);
} else {
  if (named.length > 1) {
    console.warn(`note: pages name ${named.length} source providers (${named.join(', ')}); wrote one envelope per provider.`);
  }
  const usedTokens = new Set();
  const ordered = groups.has(null) ? [...named, null] : named;
  for (const provider of ordered) {
    const group = groups.get(provider);
    const base = (provider ?? FALLBACK_PROVIDER).replace(/[^A-Za-z0-9._-]/g, '-');
    let token = base;
    for (let n = 2; usedTokens.has(token.toLowerCase()); n += 1) token = `${base}-${n}`;
    usedTokens.add(token.toLowerCase());
    const file = providerOutPath(outPath, token);
    if (provider === null) {
      console.warn(`warning: ${group.conversations.length} page(s) carry no \`source:\` key; their conversation(s) were written to ${file} with the placeholder ${JSON.stringify(FALLBACK_PROVIDER)}, which is not a registered provider token. Set \`source:\` on the pages to name the real provider.`);
    }
    writeFileSync(file, JSON.stringify(envelopeFor(provider, group), null, 2) + '\n');
    console.log(`wrote ${group.conversations.length} conversation(s), ${group.messageCount} message(s) to ${file} (provider ${JSON.stringify(provider ?? FALLBACK_PROVIDER)})`);
  }
}
// Every page that did not become a conversation is accounted for on stderr, so
// a mistargeted directory reads as a diagnosis rather than an empty file.
if (skippedNoFrontmatter || skippedNotConversation || skippedNoMessages || skippedUnreadableRecord || skippedJoinMismatch || droppedEmptyMessages) {
  console.warn(`scanned ${files.length} markdown file(s): ${skippedNoFrontmatter} without frontmatter, ${skippedNotConversation} not type conversation, ${skippedNoMessages} without speaker turns, ${skippedUnreadableRecord} with a messages record that could not be read, ${skippedJoinMismatch} whose body does not match their messages record, ${droppedEmptyMessages} empty message(s) dropped.`);
}
// Two losses that leave the output conforming and would otherwise be invisible.
// Worded as what happened - a cut at a sentinel - not as an assertion that a
// timeline was really there: a message that ends by quoting the sentinel on
// its own line is cut identically, and a note claiming it "carried a timeline"
// would be false about that page.
if (droppedTimelines) {
  console.warn(`note: ${droppedTimelines} page(s) were cut at a timeline sentinel; envelope-v0 has no field for a timeline, so nothing after the sentinel was exported.`);
}
if (nulledTimestamps) {
  console.warn(`note: ${nulledTimestamps} turn timestamp(s) were not RFC 3339 date-times and were written as null.`);
}
