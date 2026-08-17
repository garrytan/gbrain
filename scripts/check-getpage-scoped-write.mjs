#!/usr/bin/env node
/**
 * CI guard for the unscoped-check/scoped-write source-isolation bug class.
 *
 * The trap: `engine.getPage(slug)` with NO opts matches the slug in ANY
 * source (first row wins), while the paired write (`putPage` /
 * `importFromContent` / `tx.putPage`) defaults to the 'default' source. A
 * page that exists only in source B makes the existence check "succeed",
 * and the write then targets a DIFFERENT row — duplicates, clobbers, or
 * crashes (this class broke dream cycles for weeks; the writer/slug-registry
 * variant forced spurious slug disambiguation).
 *
 * Heuristic (deliberately file-scoped, same posture as
 * check-source-scope-onboard.sh): flag any non-test source file that contains
 * BOTH
 *   (a) a getPage/tx.getPage call whose balanced argument span has no second
 *       argument at all, OR a conditional second argument whose false branch
 *       is undefined/null/{} — shorthand (`x ? { sourceId } : undefined`) and
 *       expanded (`x ? { sourceId: x } : undefined`) forms alike (any-source
 *       when unset — the read half of the bug),
 *   AND
 *   (b) any write-path call: putPage( / importFromContent( / importFromFile(.
 *
 * The fix pattern (operations.ts): `getPage(slug, { sourceId: x ?? 'default' })`
 * — mirror the write's schema default on the read.
 *
 * Opt-out: a `gbrain-allow-unscoped-getpage: <reason>` comment ANYWHERE in the
 * getPage call span or on the line above it (for genuinely read-only,
 * first-match-semantics callers).
 *
 * Exit 0 = clean, 1 = violations. Runs under node or bun.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Default scan roots; overridable via argv so the guard's self-test can point
// it at fixtures (`node check-getpage-scoped-write.mjs /tmp/fixtures`).
const ROOTS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['src'];

const GETPAGE_RE = /\.\s*getPage\s*(?:<[^>;]*>)?\s*\(/g;
const WRITE_RE = /\b(putPage|importFromContent|importFromFile)\s*(?:<[^>;]*>)?\s*\(/;
const OPT_OUT = 'gbrain-allow-unscoped-getpage';

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

/** Blank out comments so commented examples don't trip the probes. */
function stripComments(s) {
  return s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Split a balanced span into top-level arguments (commas at depth 0 only). */
function topLevelArgs(span) {
  const args = [];
  let depth = 0;
  let mode = 'code';
  let cur = '';
  for (let i = 0; i < span.length; i++) {
    const c = span[i];
    const n = span[i + 1];
    if (mode === 'line') { if (c === '\n') mode = 'code'; cur += c; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; cur += '*/'; i++; continue; } cur += c; continue; }
    if (mode === 'sq') { if (c === '\\') { cur += c + (n ?? ''); i++; continue; } if (c === "'") mode = 'code'; cur += c; continue; }
    if (mode === 'dq') { if (c === '\\') { cur += c + (n ?? ''); i++; continue; } if (c === '"') mode = 'code'; cur += c; continue; }
    if (mode === 'tpl') { if (c === '\\') { cur += c + (n ?? ''); i++; continue; } if (c === '`') mode = 'code'; cur += c; continue; }
    if (c === '/' && n === '/') { mode = 'line'; cur += c; continue; }
    if (c === '/' && n === '*') { mode = 'block'; cur += c; continue; }
    if (c === "'") { mode = 'sq'; cur += c; continue; }
    if (c === '"') { mode = 'dq'; cur += c; continue; }
    if (c === '`') { mode = 'tpl'; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim().length > 0) args.push(cur);
  return args;
}

/** True when the getPage second argument is the any-source-when-unset shape. */
function isUnscopedRead(span) {
  const args = topLevelArgs(span);
  if (args.length < 2) return true; // no opts at all → unscoped
  const opts = stripComments(args[1]).trim();
  // Ternary opts whose false branch is undefined/null/{} — any-source when
  // unset. Covers BOTH the shorthand (`x ? { sourceId } : undefined`) and the
  // expanded form (`x ? { sourceId: x } : undefined`): the object-literal
  // colon in the expanded form defeated a naive [^:]* regex, so this checks
  // "mentions sourceId + ends in a bare-empty false branch" instead.
  if (opts.includes('sourceId') && /\?[\s\S]*:\s*(undefined|null|\{\s*\})\s*$/.test(opts)) return true;
  if (/^(undefined|null|\{\s*\})$/.test(opts)) return true;
  return false;
}

const violations = [];

function scanFile(file) {
  const src = readFileSync(file, 'utf8');
  if (!WRITE_RE.test(stripComments(src))) return; // no write path in this file → read-only semantics allowed
  GETPAGE_RE.lastIndex = 0;
  let m;
  while ((m = GETPAGE_RE.exec(src))) {
    const openIdx = m.index + m[0].length - 1;
    const [s, e] = findSpan(src, openIdx);
    const span = src.slice(s, e);
    // Opt-out marker inside the span, on the lines just before the call, or
    // in a trailing comment on the closing-paren line.
    const before = src.slice(Math.max(0, m.index - 300), m.index);
    const afterEnd = src.indexOf('\n', e);
    const tail = src.slice(e, afterEnd === -1 ? src.length : afterEnd);
    if (
      span.includes(OPT_OUT) ||
      before.split('\n').slice(-3).join('\n').includes(OPT_OUT) ||
      tail.includes(OPT_OUT)
    ) continue;
    if (!isUnscopedRead(span)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    violations.push(
      `${file}:${line}  unscoped getPage(...) in a file that also writes (putPage/importFromContent) — ` +
      `scope the read to the write's source: getPage(slug, { sourceId: x ?? 'default' })`,
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
  console.error('Unscoped-getPage-with-write violations (source-isolation bug class):\n');
  for (const v of violations) console.error('  ' + v);
  console.error(
    `\n${violations.length} violation(s). Fix: pass { sourceId: x ?? 'default' } on the read ` +
    `(mirrors putPage's schema default), or mark genuinely read-only first-match calls with ` +
    `a '${OPT_OUT}: <reason>' comment.`,
  );
  process.exit(1);
}
console.log('check-getpage-scoped-write: clean (no unscoped getPage in write-path files)');
