#!/usr/bin/env node
/**
 * CI guard for the POSITIONAL jsonb double-encode footgun (#2339 / #2324 class).
 *
 * The legacy scripts/check-jsonb-pattern.sh only catches the template-tag form
 * (`${JSON.stringify(x)}::jsonb`). It MISSES the positional-param form:
 *
 *     engine.executeRaw(`... $3::jsonb ...`, [a, b, JSON.stringify(x)])
 *
 * Under postgres.js `.unsafe(sql, params)` a JS STRING bound to a `$N::jsonb`
 * param double-encodes — the text→jsonb cast wraps the already-JSON string into a
 * jsonb *string scalar*. PGLite parses it silently, so the bug is invisible in
 * unit tests and only bites on real Postgres (it aborted every sync in #2339).
 *
 * This scanner flags any executeRaw / executeRawDirect / .unsafe(...) call whose
 * balanced argument span contains BOTH a positional `$N::jsonb` cast
 * (NOT `$N::text::jsonb`, NOT `$N::text[]`) AND a `JSON.stringify(` — the exact
 * double-encode shape. It is heuristic by design (whole-span correlation); the
 * real backstop is the DATABASE_URL-gated e2e parity test. Keep both.
 *
 * Allowed forms (NOT flagged):
 *   - `$N::text::jsonb` + JSON.stringify  (the fix: binds as text, cast parses it)
 *   - `$N::text[]`                        (the unnest path — arrays bind fine)
 *   - executeRawJsonb(...)               (passes raw objects, not strings)
 *   - sql.json(x)                         (postgres.js native jsonb serializer)
 *   - a `jsonb-guard-ok` comment anywhere in the call span (explicit opt-out)
 *
 * Exit 0 = clean, 1 = violations found. Runs under node or bun.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Default scan roots; overridable via argv so the guard's own test can point it
// at a fixture dir (e.g. `node check-jsonb-params.mjs /tmp/fixtures`).
const ROOTS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['src', 'scripts'];
// executeRawDirect must precede executeRaw in the alternation so the longer name
// wins; executeRawJsonb is deliberately excluded (it passes objects). The
// optional `<...>` handles generic type args, e.g. `executeRaw<{ id: string }>(`.
//
// Only the postgres.js raw path is scanned (executeRaw/executeRawDirect/.unsafe).
// PGLite's native `this.db.query(...)` is intentionally NOT matched: its driver
// parses a text→jsonb cast natively, so the double-encode that bites postgres.js
// `.unsafe()` does not occur there (the `pglite-masks` invariant). The engine
// parity test pins that the resulting jsonb_typeof agrees across both engines.
const CALL_RE = /\b(executeRawDirect|executeRaw|unsafe)\s*(?:<[^>;]*>)?\s*\(/g;

/** Walk from the '(' at openIdx and return [start,end) of the balanced span,
 *  respecting strings, template literals, and comments. */
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

/** Blank out comments so a commented-out example doesn't trip the JSON.stringify probe. */
function stripComments(s) {
  return s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const violations = [];

function scanFile(file) {
  const src = readFileSync(file, 'utf8');
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(src))) {
    const method = m[1];
    const openIdx = m.index + m[0].length - 1; // index of the '('
    const [s, e] = findSpan(src, openIdx);
    const span = src.slice(s, e);
    if (/jsonb-guard-ok/.test(span)) continue;
    if (!/JSON\.stringify\s*\(/.test(stripComments(span))) continue;
    // A positional `$N::jsonb` that is NOT `$N::text::jsonb`.
    const jsonbRe = /\$\d+\s*::\s*jsonb\b/g;
    let j;
    let badText = '';
    while ((j = jsonbRe.exec(span))) {
      const pre = span.slice(Math.max(0, j.index - 12), j.index);
      if (/::\s*text\s*$/.test(pre)) continue; // $N::text::jsonb is the fix — allowed
      badText = j[0].replace(/\s+/g, '');
      break;
    }
    if (!badText) continue;
    const line = src.slice(0, s).split('\n').length;
    violations.push(
      `${file}:${line}  ${method}(...) binds JSON.stringify into ${badText} — use $N::text::jsonb or pass a raw object (executeRawJsonb / sql.json)`,
    );
  }
}

function walk(dir) {
  let ents;
  try { ents = readdirSync(dir); } catch { return; }
  for (const ent of ents) {
    if (ent === 'node_modules') continue;
    const p = join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) scanFile(p);
  }
}

for (const root of ROOTS) walk(root);

if (violations.length) {
  console.error('JSONB positional double-encode violations (#2339 class):\n');
  for (const v of violations) console.error('  ' + v);
  console.error(`\n${violations.length} violation(s). Fix: bind through $N::text::jsonb (keeping JSON.stringify), or pass a raw object via executeRawJsonb / sql.json. See docs/ENGINES.md.`);
  process.exit(1);
}
console.log('check-jsonb-params: clean (no positional $N::jsonb + JSON.stringify double-encodes)');
