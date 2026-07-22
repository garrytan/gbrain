#!/usr/bin/env node
/**
 * CI guard: fail if a test file calls a gateway test-seam mutator
 * (`configureGateway(`, `__setEmbedTransportForTests(`,
 * `__setChatTransportForTests(`, `__setGenerateTextTransportForTests(`,
 * `__setRerankTransportForTests(`) without a module-scope `afterAll(...)` or
 * `afterEach(...)` block that actually clears whatever it configured.
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
 * `resetGateway()` (src/core/ai/gateway.ts) clears ALL of _config,
 * _embedTransport, _generateTextTransport, _chatTransport, and caches in one
 * call — so any of the five setters left unreset can leak into the next
 * file, not just configureGateway()/__setEmbedTransportForTests() (the two
 * named in the original #3066 report).
 *
 * This is the same "state leaks across file boundaries within a shard
 * process" family that check-test-isolation.sh's R3/R4 already guards for
 * PGLiteEngine, using a simple whole-file co-occurrence heuristic (does
 * afterAll( appear, does .disconnect( appear, ANYWHERE in the file, over raw
 * source). Two rounds of review against that starting point found — and
 * this scanner fixes — three distinct unsound-heuristic failure modes:
 *
 *  1. CO-OCCURRENCE ISN'T ENOUGH. Several real files have BOTH an afterAll(
 *     — for unrelated cleanup, e.g. engine.disconnect() — AND a
 *     resetGateway( call elsewhere (typically beforeEach, which resets
 *     state FOR THE NEXT TEST but does nothing after the file's LAST test
 *     runs). Fix: extract the balanced-paren span of every teardown-hook
 *     call and require the reset call to appear INSIDE that span, not just
 *     anywhere in the file.
 *  2. RAW-SOURCE REGEXES AREN'T LEXICALLY SAFE. A commented-out
 *     `// afterAll(() => resetGateway())`, or resetGateway( mentioned only
 *     inside a string literal, would otherwise be accepted as real. Fix:
 *     build one same-length "code mask" of the whole file — every comment,
 *     string literal, template literal, and regex literal blanked to spaces
 *     — and run every regex + the span walk against THAT, never raw source.
 *     Regex-literal detection uses the standard division-vs-regex
 *     "previous significant token" heuristic (a `/` is division only right
 *     after a completed value — identifier/number/`)`/`]` — everything else,
 *     including keywords like `return`/`typeof`/`case` that LOOK like a
 *     completed identifier but aren't a value, means the `/` opens a
 *     regex); the token lookback deliberately survives intervening
 *     whitespace (`return /foo/` must still see `return`, not lose it to
 *     the space before the slash).
 *  3. "FILE-WIDE" AND "MATCHING RESET" MUST BE ENFORCED, NOT ASSERTED. A
 *     hook nested inside one of SEVERAL sibling describe()s only tears down
 *     that describe's own tests, not the whole file — a parallel
 *     `braceDepth` array (built in the same lexing pass) lets the scanner
 *     require the hook be at true module scope (depth 0), UNLESS the file
 *     has exactly one top-level describe(...) wrapping its entire suite (an
 *     extremely common convention), in which case a hook at depth 1 inside
 *     that sole describe is equally file-wide — there is nothing else at
 *     depth 0 for it to miss. Either way this is enforced from real
 *     structure, not just trusted indentation convention. Separately, a
 *     bare `__setChatTransportForTests(null)` clears only
 *     _chatTransport — it does NOT clear _config, so it must not be
 *     accepted as satisfying a file that also called configureGateway().
 *     The scanner checks PER TRIGGER: any configureGateway( anywhere in the
 *     file requires resetGateway( specifically (the only call that clears
 *     _config); a file using ONLY setter mutators (no configureGateway) may
 *     satisfy each one via resetGateway( OR that SAME setter called with
 *     null in a teardown-hook span.
 *
 * This remains a best-effort static scanner (like every scripts/check-*.sh
 * in this repo) — not a full parser. It does not track nested template
 * literals (`` `${`nested`}` ``) or code executed inside a template
 * interpolation (`` `${configureGateway(...)}` ``); check-jsonb-params.mjs's
 * findSpan, which this scanner's span-walking approach builds on, has the
 * same limitation. Neither shape appears anywhere in this codebase's test
 * suite today. A resetGateway( call inside a nested helper function DEFINED
 * elsewhere and merely INVOKED from the hook span (e.g.
 * `afterAll(() => teardown())`) will also not be seen; write the reset call
 * directly in the hook body (as every fixed file in this repo does), or add
 * a `gateway-reset-guard-ok` comment inside the hook span as an explicit,
 * reviewable opt-out (the opt-out is matched against comment TEXT only, via
 * its own mask pass, so it cannot be satisfied by a string literal).
 *
 * Scope mirrors check-test-isolation.sh: recursively scans test/**\/*.test.ts,
 * skips *.serial.test.ts (serial files run one-at-a-time, never sharing a
 * process with another file) and test/e2e/** (scripts/run-e2e.sh explicitly
 * spins up "a fresh bun process" per E2E file — confirmed by reading that
 * script — so cross-file gateway leaks are structurally impossible there).
 * Both exclusions remove the exact precondition for this leak (file B
 * running in the same process as file A).
 *
 * Usage: node scripts/check-gateway-reset.mjs [dir ...]   (default: test)
 * Exit:  0 when clean, 1 when violations found.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['test'];

// Every gateway test-seam mutator that leaves state live until something
// resets it (see src/core/ai/gateway.ts's resetGateway() body — it clears
// all of these). No `\s*` before the call paren: a real call is always
// `name(...)` with no space (this repo's formatting convention); the mask
// (below) already removes prose like a test description
// `'works WITHOUT configureGateway (reads registry...'` before this regex
// ever sees it, but the tightened paren match is kept as a second,
// independent line of defense.
const SETTER_NAMES = [
  'EmbedTransportForTests',
  'ChatTransportForTests',
  'GenerateTextTransportForTests',
  'RerankTransportForTests',
];
const CONFIGURE_RE = /\bconfigureGateway\(/;
const SETTER_CALL_RE = new RegExp(`\\b__set(${SETTER_NAMES.join('|')})\\(`, 'g');

// Teardown hook: afterAll (fires once, after the file's last test) OR a
// MODULE-SCOPE afterEach (fires after EVERY test, including the file's last
// one — so it gives the same file-teardown guarantee as afterAll for this
// purpose). This is NOT the same shape as the beforeEach-only false negative
// this guard exists to catch: beforeEach runs BEFORE a test, so it never
// runs again after the file's last test finishes; afterEach runs AFTER, so
// it always does. "Module-scope" is enforced via the braceDepth check in
// hasResetInTeardownHook, not merely asserted here.
const TEARDOWN_HOOK_RE = /\b(afterAll|afterEach)\(/g;
const RESET_GATEWAY_RE = /\bresetGateway\(/;
const OPT_OUT_RE = /gateway-reset-guard-ok/;

// Tokens after which a following `/` cannot be division — i.e. it opens a
// regex literal. Mirrors the common lightweight-tokenizer heuristic: a `/`
// is division only immediately after an identifier/number/`)`/`]` (a
// completed expression); every other preceding token (including these
// keywords, which end in an identifier character but are not values) means
// the `/` starts a regex.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * Single-pass lexical scan of src producing three same-length parallel
 * outputs:
 *  - `masked`   — real code only; every comment/string/template/regex is
 *                 blanked to spaces (newlines preserved). All structural
 *                 regex matching + paren-depth walking runs against this.
 *  - `comments` — the inverse: ONLY comment text is preserved (everything
 *                 else, including string/regex/template content, is
 *                 blanked). Used solely so the `gateway-reset-guard-ok`
 *                 opt-out can only be satisfied by a real comment, never by
 *                 a string literal that happens to contain the phrase.
 *  - `braceDepth` — the `{`/`}` nesting depth of real code in effect at
 *                 each index (0 = module scope, not inside any describe()/
 *                 function/block). Used to enforce that a teardown hook is
 *                 genuinely file-wide rather than merely trusting
 *                 indentation convention.
 */
function lex(src) {
  const masked = new Array(src.length);
  const comments = new Array(src.length);
  const braceDepth = new Array(src.length);
  let depth = 0;
  let mode = 'code'; // code | line | block | sq | dq | tpl | regex
  let regexInClass = false;
  // lastWord: the most recently completed contiguous run of [A-Za-z0-9_$],
  // surviving intervening whitespace (so `return /foo/` still sees
  // `return` when it reaches the slash — whitespace must NOT clear this,
  // only a real punctuation character does). lastSignificant: the most
  // recent non-whitespace character emitted as real code.
  let lastWord = '';
  let lastSignificant = '';

  const put = (i, ch) => {
    masked[i] = ch;
    comments[i] = ' ';
    braceDepth[i] = depth;
  };
  const putComment = (i) => {
    masked[i] = src[i] === '\n' ? '\n' : ' ';
    comments[i] = src[i];
    braceDepth[i] = depth;
  };
  const blank = (i) => {
    masked[i] = src[i] === '\n' ? '\n' : ' ';
    comments[i] = ' ';
    braceDepth[i] = depth;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = i + 1 < src.length ? src[i + 1] : '';

    if (mode === 'line') {
      putComment(i);
      if (c === '\n') mode = 'code';
      continue;
    }
    if (mode === 'block') {
      putComment(i);
      if (c === '*' && n === '/') { i++; if (i < src.length) putComment(i); mode = 'code'; }
      continue;
    }
    if (mode === 'sq' || mode === 'dq' || mode === 'tpl') {
      const quote = mode === 'sq' ? "'" : mode === 'dq' ? '"' : '`';
      if (c === '\\') { blank(i); if (i + 1 < src.length) { i++; blank(i); } continue; }
      if (c === quote) { blank(i); mode = 'code'; lastSignificant = quote; lastWord = ''; continue; }
      blank(i);
      continue;
    }
    if (mode === 'regex') {
      if (c === '\\') { blank(i); if (i + 1 < src.length) { i++; blank(i); } continue; }
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
    if (c === '/' && n === '/') { mode = 'line'; putComment(i); i++; if (i < src.length) putComment(i); continue; }
    if (c === '/' && n === '*') { mode = 'block'; putComment(i); i++; if (i < src.length) putComment(i); continue; }
    if (c === "'") { mode = 'sq'; blank(i); continue; }
    if (c === '"') { mode = 'dq'; blank(i); continue; }
    if (c === '`') { mode = 'tpl'; blank(i); continue; }
    if (c === '/') {
      const divisionContext =
        (/[A-Za-z0-9_$]/.test(lastSignificant) && !REGEX_PRECEDING_KEYWORDS.has(lastWord)) ||
        lastSignificant === ')' ||
        lastSignificant === ']';
      if (!divisionContext) {
        mode = 'regex';
        regexInClass = false;
        put(i, c); // keep the opening slash itself as real code (harmless)
        lastSignificant = '/';
        lastWord = '';
        continue;
      }
      // division operator: fall through, keep as real code.
    }

    put(i, c);
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (/[A-Za-z0-9_$]/.test(c)) {
      lastWord += c;
      lastSignificant = c;
    } else if (!/\s/.test(c)) {
      lastWord = '';
      lastSignificant = c;
    }
    // whitespace: deliberately leave lastWord/lastSignificant untouched.
  }
  return { masked: masked.join(''), comments: comments.join(''), braceDepth };
}

/** Balanced-span walk from the '(' at openIdx over the masked source (parens
 *  in masked source are always real code, so plain depth counting is
 *  sufficient — no string/comment/regex state needed here). */
function findSpan(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return [openIdx + 1, i]; }
  }
  return [openIdx + 1, masked.length];
}

const DESCRIBE_RE = /\bdescribe\(/g;

/** Every teardown-hook span whose enclosing scope is genuinely file-wide, as
 *  [start, end) offsets into `masked`. "File-wide" means either true module
 *  scope (braceDepth 0) OR — the extremely common convention of wrapping a
 *  file's entire suite in one outer describe(...) — depth 1 when the file
 *  has EXACTLY ONE top-level describe(. In that shape a depth-1 hook still
 *  covers every test in the file (there is nothing else at depth 0 for it
 *  to miss); with two or more sibling top-level describes, a depth-1 hook
 *  only covers its own describe's tests, so depth 0 is required. A hook
 *  nested two or more levels deep (inside a NESTED describe, or inside a
 *  function) is never treated as file-wide. */
function fileWideTeardownSpans(masked, braceDepth) {
  DESCRIBE_RE.lastIndex = 0;
  let topLevelDescribeCount = 0;
  let dm;
  while ((dm = DESCRIBE_RE.exec(masked))) {
    if (braceDepth[dm.index] === 0) topLevelDescribeCount++;
  }
  const maxFileWideDepth = topLevelDescribeCount === 1 ? 1 : 0;

  const spans = [];
  TEARDOWN_HOOK_RE.lastIndex = 0;
  let m;
  while ((m = TEARDOWN_HOOK_RE.exec(masked))) {
    if (braceDepth[m.index] > maxFileWideDepth) continue;
    const openIdx = m.index + m[0].length - 1;
    spans.push(findSpan(masked, openIdx));
  }
  return spans;
}

function anySpanMatches(masked, comments, spans, re) {
  return spans.some(([s, e]) => re.test(masked.slice(s, e)) || OPT_OUT_RE.test(comments.slice(s, e)));
}

const violations = [];

function scanFile(file) {
  const src = readFileSync(file, 'utf8');
  const { masked, comments, braceDepth } = lex(src);

  const callsConfigure = CONFIGURE_RE.test(masked);
  SETTER_CALL_RE.lastIndex = 0;
  const settersUsed = new Set();
  let sm;
  while ((sm = SETTER_CALL_RE.exec(masked))) settersUsed.add(sm[1]);

  if (!callsConfigure && settersUsed.size === 0) return; // nothing to reset

  const spans = fileWideTeardownSpans(masked, braceDepth);
  if (spans.length === 0) { violations.push(file); return; }

  // configureGateway() sets _config, which ONLY resetGateway() clears — a
  // bare __setXForTests(null) does not touch it. So if the file calls
  // configureGateway() anywhere, resetGateway( specifically is required.
  if (callsConfigure) {
    if (anySpanMatches(masked, comments, spans, RESET_GATEWAY_RE)) return;
    violations.push(file);
    return;
  }

  // No configureGateway() in this file: each individual setter that was
  // used must be satisfied, either by the blanket resetGateway( or by that
  // SAME setter called with null in a teardown-hook span.
  for (const name of settersUsed) {
    const perSetterReset = new RegExp(`\\b__set${name}\\(\\s*null\\b`);
    const ok = anySpanMatches(masked, comments, spans, RESET_GATEWAY_RE) ||
      anySpanMatches(masked, comments, spans, perSetterReset);
    if (!ok) { violations.push(file); return; }
  }
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
  console.error('mutator (configureGateway/__set*TransportForTests) without a module-scope');
  console.error('afterAll(...)/afterEach(...) block that actually clears it:\n');
  for (const v of violations) console.error('  ' + v);
  console.error(
    `\n${violations.length} violation(s). Fix: add ` +
      "`afterAll(() => resetGateway());` (or fold resetGateway() into an existing " +
      'afterAll/afterEach callback body). Without it, whatever gateway/transport state ' +
      'this file last set stays live for the next file that shares its shard process.',
  );
  process.exit(1);
}
console.log('check-gateway-reset: clean (every gateway test-seam mutator resets in afterAll/afterEach)');
