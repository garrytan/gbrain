#!/usr/bin/env node
/**
 * CI guard: fail if a test file calls `configureGateway(` or
 * `__setEmbedTransportForTests(` without a file-level `afterAll(...)` block
 * that calls `resetGateway(`.
 *
 * Background (#3066): master shard 6 broke twice, deterministically, because
 * test/ai/adaptive-embed-batch.test.ts left the global gateway configured
 * with a remote provider + fake key past its own file boundary — the next
 * embed-triggering file in the same shard process made a live HTTP call.
 * That specific leaker was fixed in #3065, but an audit found ~70 test
 * files call `configureGateway()`/`__setEmbedTransportForTests()` and, at
 * the time, only test/ai/gateway.test.ts reset it in an `afterAll`. Bun's
 * parallel runner loads multiple test files into one process per shard;
 * module-level gateway state set by one file is visible to every file that
 * runs after it in the same shard process, and shard composition shifts
 * every time a file is added/removed/reordered — so this class of leak is
 * silent until a specific shard lineup happens to make it fatal.
 *
 * This is the same "state leaks across file boundaries within a shard
 * process" family that check-test-isolation.sh's R3/R4 already guards for
 * PGLiteEngine. That guard uses a simple whole-file co-occurrence heuristic
 * (does `afterAll(` appear, does `.disconnect(` appear). A first cut of
 * this guard tried the identical heuristic for resetGateway() and it
 * produced false negatives: several real files here have BOTH an
 * `afterAll(` (for unrelated cleanup, e.g. `engine.disconnect()`) AND a
 * `resetGateway(` call elsewhere in the file (typically in a `beforeEach`,
 * which resets STATE FOR THE NEXT TEST but does nothing after the file's
 * LAST test runs) — i.e. exactly the leak shape, invisible to a co-occurrence
 * check. So this scanner extracts the balanced-paren span of every
 * `afterAll(...)` call (reusing the findSpan approach from
 * check-jsonb-params.mjs: a small state machine that tracks string/
 * template/comment context so nested `(`/`)`/`{`/`}` inside the callback
 * body do not confuse the span boundary) and requires `resetGateway(` to
 * appear INSIDE at least one such span.
 *
 * Scope mirrors check-test-isolation.sh: recursively scans `test/**\/*.test.ts`,
 * skips `*.serial.test.ts` (serial files run one-at-a-time, never sharing a
 * process with another file) and `test/e2e/**` (its own sequential runner,
 * not in the parallel shard pool). Both exclusions remove the exact
 * precondition for this leak (file B running in the same process as file A).
 *
 * Heuristic by design (like every scripts/check-*.sh in this repo) — it is
 * whole-callback-span correlation, not full data-flow. A `resetGateway(`
 * call inside a nested helper function DEFINED elsewhere and merely
 * INVOKED from the afterAll span (e.g. `afterAll(() => teardown())`) will
 * not be seen; write the reset call directly in the afterAll body (as
 * every fixed file in this repo does), or add a `gateway-reset-guard-ok`
 * comment inside the afterAll span as an explicit, reviewable opt-out.
 *
 * Usage: node scripts/check-gateway-reset.mjs [dir ...]   (default: test)
 * Exit:  0 when clean, 1 when violations found.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['test'];

// No `\s*` before the call paren: a real call is always `name(...)` with no
// space (this repo's formatting convention). Without this tightening, prose
// like a test description `'works WITHOUT configureGateway (reads registry...'`
// false-positives (the regex would match across the space into the
// unrelated parenthetical). Real calls never have a space there.
const CONFIG_CALL_RE = /\b(configureGateway|__setEmbedTransportForTests)\(/;
const AFTERALL_RE = /\bafterAll\(/g;
const RESET_RE = /\bresetGateway\(/;
const OPT_OUT_RE = /gateway-reset-guard-ok/;

/** Balanced-span walk from the '(' at openIdx, respecting strings, template
 *  literals, and comments (adapted from scripts/check-jsonb-params.mjs). */
function findSpan(src, openIdx) {
  let depth = 0;
  let mode = 'code'; // code | line | block | sq | dq | tpl
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'line') { if (c === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i++; } continue; }
    if (mode === 'sq') { if (c === '\\') { i++; continue; } if (c === "'") mode = 'code'; continue; }
    if (mode === 'dq') { if (c === '\\') { i++; continue; } if (c === '"') mode = 'code'; continue; }
    if (mode === 'tpl') { if (c === '\\') { i++; continue; } if (c === '`') mode = 'code'; continue; }
    // mode === 'code'
    if (c === '/' && n === '/') { mode = 'line'; i++; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i++; continue; }
    if (c === "'") { mode = 'sq'; continue; }
    if (c === '"') { mode = 'dq'; continue; }
    if (c === '`') { mode = 'tpl'; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return [openIdx + 1, i]; }
  }
  return [openIdx + 1, src.length];
}

function stripComments(s) {
  return s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Returns true if `resetGateway(` (or the explicit opt-out comment) appears
 *  inside the balanced span of any top-level afterAll(...) call in src. */
function hasGatewayResetInAfterAll(src) {
  AFTERALL_RE.lastIndex = 0;
  let m;
  while ((m = AFTERALL_RE.exec(src))) {
    const openIdx = m.index + m[0].length - 1;
    const [s, e] = findSpan(src, openIdx);
    const span = stripComments(src.slice(s, e));
    const rawSpan = src.slice(s, e);
    if (RESET_RE.test(span) || OPT_OUT_RE.test(rawSpan)) return true;
  }
  return false;
}

const violations = [];

function scanFile(file) {
  const src = readFileSync(file, 'utf8');
  // Strip comments before the trigger check — several files document the
  // convention with `configureGateway()` (immediate paren) inside a // or
  // /* */ comment, which would otherwise self-trigger the guard on a file
  // that merely talks about the pattern.
  if (!CONFIG_CALL_RE.test(stripComments(src))) return;
  if (hasGatewayResetInAfterAll(src)) return;
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
  console.error('Gateway state leak risk (#3066 class): file(s) call configureGateway()/__setEmbedTransportForTests()');
  console.error('but have no afterAll(...) block that calls resetGateway():\n');
  for (const v of violations) console.error('  ' + v);
  console.error(
    `\n${violations.length} violation(s). Fix: add ` +
      "`afterAll(() => resetGateway());` (or fold resetGateway() into an existing " +
      'afterAll callback body). Without it, whatever gateway config this file last ' +
      'set stays live for the next file that shares its shard process.',
  );
  process.exit(1);
}
console.log('check-gateway-reset: clean (every configureGateway()/__setEmbedTransportForTests() caller resets in afterAll)');
