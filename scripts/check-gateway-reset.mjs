#!/usr/bin/env node
/**
 * CI guard: fail if a test file calls a gateway test-seam mutator
 * (`configureGateway(`, `__setEmbedTransportForTests(`,
 * `__setChatTransportForTests(`, `__setGenerateTextTransportForTests(`,
 * `__setRerankTransportForTests(`) without a file-level `afterAll(...)` block
 * that calls `resetGateway(`.
 *
 * Background (#3066): master shard 6 broke twice, deterministically, because
 * test/ai/adaptive-embed-batch.test.ts left the global gateway configured
 * with a remote provider + fake key past its own file boundary — the next
 * embed-triggering file in the same shard process made a live HTTP call.
 * That specific leaker was fixed in #3065, but an audit found ~70 test
 * files call configureGateway()/__setEmbedTransportForTests() and, at the
 * time, only test/ai/gateway.test.ts reset it in an afterAll. Bun's parallel
 * runner loads multiple test files into one process per shard; module-level
 * gateway state set by one file is visible to every file that runs after it
 * in the same shard process, and shard composition shifts every time a file
 * is added/removed/reordered — so this class of leak is silent until a
 * specific shard lineup happens to make it fatal. It is not hypothetical:
 * PR #3238's test(9) failed with "expected 1280 dimensions, not 1536" in the
 * eval-trajectory CLI group — a live instance of exactly this class, from an
 * unrelated PR shifting shard composition.
 *
 * `resetGateway()` (src/core/ai/gateway.ts) clears ALL of the above test-seam
 * state in one call (_config, _embedTransport, _generateTextTransport,
 * _chatTransport, caches) — so any one of the five setters left unreset can
 * leak into the next file, not just configureGateway()/
 * __setEmbedTransportForTests() (the two named in the original #3066 report).
 *
 * This is the same "state leaks across file boundaries within a shard
 * process" family that check-test-isolation.sh's R3/R4 already guards for
 * PGLiteEngine, using a simple whole-file co-occurrence heuristic (does
 * afterAll( appear, does .disconnect( appear, ANYWHERE in the file). A first
 * cut of this guard tried the identical heuristic for resetGateway() and it
 * produced false negatives: several real files have BOTH an afterAll( — for
 * unrelated cleanup, e.g. engine.disconnect() — AND a resetGateway( call
 * elsewhere in the file (typically in beforeEach, which resets state FOR THE
 * NEXT TEST but does nothing after the file's LAST test runs) — exactly the
 * leak shape, invisible to co-occurrence.
 *
 * So this scanner:
 *  1. Builds a single "code mask" of the whole file — same length as the
 *     source, with every `//` comment, `/* *\/` comment, string literal,
 *     template literal, and regex literal blanked to spaces (quote/comment
 *     delimiters included). This is what both the trigger check AND the
 *     afterAll/resetGateway matching run against, so neither a commented-out
 *     `// afterAll(...)` nor a string that happens to contain the text
 *     "resetGateway(" can produce a false positive/negative. Regex-literal
 *     detection uses the standard "previous significant token" heuristic
 *     (division only follows an identifier/number/`)`/`]`/`this`; anything
 *     else — including known prefix keywords like `return`/`typeof`/`case` —
 *     means the next `/` opens a regex) used by lightweight JS tokenizers;
 *     it is not a full parser, but it is materially stronger than the
 *     regex-only findSpan in check-jsonb-params.mjs, which this scanner's
 *     span-walking approach was originally adapted from.
 *  2. Finds every top-level `afterAll(...)` call on the mask and extracts
 *     its balanced-paren span (masked parens/braces are untouched by the
 *     masking pass, so depth-counting is unaffected by content that used to
 *     be a string/comment/regex).
 *  3. Requires `resetGateway(` to appear inside at least one such span (on
 *     the mask, so a match can only come from real code).
 *
 * Scope mirrors check-test-isolation.sh: recursively scans test/**\/*.test.ts,
 * skips *.serial.test.ts (serial files run one-at-a-time, never sharing a
 * process with another file) and test/e2e/** (scripts/run-e2e.sh explicitly
 * spins up "a fresh bun process" per E2E file — confirmed by reading that
 * script — so cross-file gateway leaks are structurally impossible there).
 * Both exclusions remove the exact precondition for this leak (file B
 * running in the same process as file A).
 *
 * Heuristic by design (like every scripts/check-*.sh in this repo) — it is
 * whole-callback-span correlation, not full data-flow. A resetGateway( call
 * inside a nested helper function DEFINED elsewhere and merely INVOKED from
 * the afterAll span (e.g. `afterAll(() => teardown())`) will not be seen;
 * write the reset call directly in the afterAll body (as every fixed file in
 * this repo does), or add a `gateway-reset-guard-ok` comment inside the
 * afterAll span as an explicit, reviewable opt-out.
 *
 * Usage: node scripts/check-gateway-reset.mjs [dir ...]   (default: test)
 * Exit:  0 when clean, 1 when violations found.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['test'];

// Every gateway test-seam mutator that resetGateway() clears (see
// src/core/ai/gateway.ts's resetGateway() body). No `\s*` before the call
// paren: a real call is always `name(...)` with no space (this repo's
// formatting convention). The mask (below) already removes prose like a test
// description `'works WITHOUT configureGateway (reads registry...'` before
// this regex ever sees it, but the tightened paren match is kept as a
// second, independent line of defense.
const CONFIG_CALL_RE =
  /\b(configureGateway|__setEmbedTransportForTests|__setChatTransportForTests|__setGenerateTextTransportForTests|__setRerankTransportForTests)\(/;
// Teardown hook: afterAll (fires once, after the file's last test) OR a
// MODULE-SCOPE afterEach (fires after EVERY test, including the file's
// last one — so it gives the same file-teardown guarantee as afterAll for
// this purpose). This is NOT the same shape as the beforeEach-only false
// negative this guard exists to catch: beforeEach runs BEFORE a test, so it
// never runs again after the file's last test finishes; afterEach runs
// AFTER, so it always does. Several already-safe files in this repo use
// exactly this afterEach pattern (e.g. test/notability-eval.test.ts).
const TEARDOWN_HOOK_RE = /\b(afterAll|afterEach)\(/g;
// A valid reset is resetGateway( itself, or a call that resets one of the
// individual test-seam setters back to its real implementation by passing
// null (the exact form resetGateway() uses internally for each of them —
// see src/core/ai/gateway.ts). Several files clean up only the one seam
// they touched this way instead of calling the broader resetGateway();
// functionally equivalent for that seam, so it counts.
const RESET_RE =
  /\bresetGateway\(|\b__set(?:EmbedTransportForTests|ChatTransportForTests|GenerateTextTransportForTests|RerankTransportForTests)\(\s*null\b/;
const OPT_OUT_RE = /gateway-reset-guard-ok/;

// Tokens after which a following `/` cannot be division — i.e. it opens a
// regex literal. Mirrors the common lightweight-tokenizer heuristic: a `/`
// is division only immediately after an identifier/number/`)`/`]`/`this` (a
// completed expression); every other preceding token (including these
// keywords, which end in an identifier character but are not values) means
// the `/` starts a regex.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/** Build a same-length "code mask" of src: every // comment, block comment,
 *  string literal, template literal, and regex literal is blanked to spaces
 *  (newlines preserved), so downstream regex/paren-depth logic only ever
 *  sees real code structure. */
function maskNonCode(src) {
  const out = new Array(src.length);
  let mode = 'code'; // code | line | block | sq | dq | tpl | regex
  let regexInClass = false;
  // Tracks the most recent contiguous run of [A-Za-z0-9_$] seen in code
  // mode, and the single most recent non-space "value-ish" punctuation
  // (`)` or `]`) — used to decide whether a `/` is division or a regex.
  let lastWord = '';
  let lastSignificant = ''; // last non-whitespace char emitted as real code

  const blank = (i) => { out[i] = src[i] === '\n' ? '\n' : ' '; };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];

    if (mode === 'line') {
      blank(i);
      if (c === '\n') mode = 'code';
      continue;
    }
    if (mode === 'block') {
      blank(i);
      if (c === '*' && n === '/') { blank(i + 1); i++; mode = 'code'; }
      continue;
    }
    if (mode === 'sq' || mode === 'dq' || mode === 'tpl') {
      const quote = mode === 'sq' ? "'" : mode === 'dq' ? '"' : '`';
      if (c === '\\') { blank(i); blank(i + 1); i++; continue; }
      if (c === quote) { blank(i); mode = 'code'; lastSignificant = quote; lastWord = ''; continue; }
      blank(i);
      continue;
    }
    if (mode === 'regex') {
      if (c === '\\') { blank(i); blank(i + 1); i++; continue; }
      if (c === '[') { regexInClass = true; blank(i); continue; }
      if (c === ']') { regexInClass = false; blank(i); continue; }
      if (c === '/' && !regexInClass) {
        blank(i);
        mode = 'code';
        // Consume trailing flags (a-z) as part of the literal.
        let j = i + 1;
        while (j < src.length && /[a-z]/i.test(src[j])) { blank(j); j++; }
        i = j - 1;
        lastSignificant = '/';
        lastWord = '';
        continue;
      }
      blank(i);
      continue;
    }

    // mode === 'code'
    if (c === '/' && n === '/') { mode = 'line'; blank(i); blank(i + 1); i++; continue; }
    if (c === '/' && n === '*') { mode = 'block'; blank(i); blank(i + 1); i++; continue; }
    if (c === "'") { mode = 'sq'; blank(i); continue; }
    if (c === '"') { mode = 'dq'; blank(i); continue; }
    if (c === '`') { mode = 'tpl'; blank(i); continue; }
    if (c === '/') {
      const divisionContext =
        /[A-Za-z0-9_$]/.test(lastSignificant) && !REGEX_PRECEDING_KEYWORDS.has(lastWord) ||
        lastSignificant === ')' ||
        lastSignificant === ']';
      if (!divisionContext) {
        mode = 'regex';
        regexInClass = false;
        out[i] = c; // keep the opening slash itself as real code (harmless)
        lastSignificant = '/';
        lastWord = '';
        continue;
      }
      // division operator: fall through, keep as real code.
    }

    out[i] = c;
    if (/[A-Za-z0-9_$]/.test(c)) {
      lastWord += c;
      lastSignificant = c;
    } else {
      if (!/\s/.test(c)) { lastSignificant = c; }
      lastWord = '';
    }
  }
  return out.join('');
}

/** Balanced-span walk from the '(' at openIdx over an already-masked source
 *  (parens/braces in masked source are always real code, so plain depth
 *  counting is sufficient — no string/comment/regex state needed here). */
function findSpan(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return [openIdx + 1, i]; }
  }
  return [openIdx + 1, masked.length];
}

/** Returns true if a valid reset (see RESET_RE) appears inside the balanced
 *  span of any top-level afterAll(...) or module-scope afterEach(...) call.
 *  `masked` is the code-only mask (for matching); `raw` is the original
 *  source (only used to let the `gateway-reset-guard-ok` opt-out be written
 *  as a real comment, since that phrase is deliberately looked for in the
 *  RAW span). */
function hasGatewayResetInTeardownHook(masked, raw) {
  TEARDOWN_HOOK_RE.lastIndex = 0;
  let m;
  while ((m = TEARDOWN_HOOK_RE.exec(masked))) {
    const openIdx = m.index + m[0].length - 1;
    const [s, e] = findSpan(masked, openIdx);
    if (RESET_RE.test(masked.slice(s, e)) || OPT_OUT_RE.test(raw.slice(s, e))) return true;
  }
  return false;
}

const violations = [];

function scanFile(file) {
  const src = readFileSync(file, 'utf8');
  const masked = maskNonCode(src);
  if (!CONFIG_CALL_RE.test(masked)) return;
  if (hasGatewayResetInTeardownHook(masked, src)) return;
  violations.push(file);
}

function walk(dir) {
  let ents;
  try { ents = readdirSync(dir); } catch { return; }
  for (const ent of ents) {
    if (ent === 'node_modules') continue;
    const p = join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (relative('.', p).split('/').includes('e2e')) continue;
      walk(p);
    } else if (p.endsWith('.test.ts') && !p.endsWith('.serial.test.ts')) {
      scanFile(p);
    }
  }
}

for (const root of ROOTS) walk(root);

if (violations.length) {
  console.error('Gateway state leak risk (#3066 class): file(s) call a gateway test-seam');
  console.error('mutator (configureGateway/__set*TransportForTests) without an afterAll(...)');
  console.error('or module-scope afterEach(...) block that resets it:\n');
  for (const v of violations) console.error('  ' + v);
  console.error(
    `\n${violations.length} violation(s). Fix: add ` +
      "`afterAll(() => resetGateway());` (or fold resetGateway() into an existing " +
      'afterAll callback body). Without it, whatever gateway/transport state this file ' +
      'last set stays live for the next file that shares its shard process.',
  );
  process.exit(1);
}
console.log('check-gateway-reset: clean (every gateway test-seam mutator resets in afterAll/afterEach)');
