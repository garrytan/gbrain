#!/usr/bin/env node
// sql-move-check.mjs: byte-identical SQL move gate for engine-sql modules.
//
// Usage:
//   node scripts/sql-move-check.mjs --base <ref> --head <ref> [--modules a,b,c] [--report-ws]
//   e.g. node scripts/sql-move-check.mjs --base origin/master --head HEAD --removed-paths none
//
// With no --modules it checks every engine-sql module the diff adds or changes. A change that copies statements
// without removing the originals (the callers still hold their text) has nothing to re-home: pass
// `--removed-paths none` to skip the removed-statement half.
//
// For every SQL statement (backtick literal containing SQL keywords, in any letter case) in the
// target engine-sql modules at <head>, it reports:
//   IDENTICAL       byte-identical text to a statement in <base>'s src/ or test/ tree
//   NOT-IDENTICAL   no byte-identical origin (whitespace-only matches are called out
//                   with --report-ws; they still fail, because the rule is byte-identical)
// For every statement in <base> that the diff removes from src/ or test/ (its text no
// longer appears anywhere in <head>'s src/ or test/ tree), it reports:
//   NO-NEW-HOME     no byte-identical copy in a <head> engine-sql module
//   (a removed statement that has a new home is not reported)
//
// Exit 0 when every statement is IDENTICAL and every removed statement has a new home.
// Exit 1 on any NOT-IDENTICAL or NO-NEW-HOME line. Exit 2 on usage or git errors.
//
// Scope notes:
//   - Literals are read with the TypeScript parser (the repo's own `typescript` dev dependency), so comments, regular
//     expressions and JSX text are never mistaken for SQL, and SQL is never hidden by them.
//   - Only the literal shapes the lexer sees are checked: backtick templates and single- or
//     double-quoted strings that contain SQL keywords and one of FROM/INTO/SET/WHERE/VALUES/TABLE/RETURNING/JOIN/...
//   - ${...} interpolations are compared as part of the text, so a changed interpolation
//     expression makes the statement NOT-IDENTICAL.
//   - Comments inside a template are part of the text and compared byte for byte.
//   - Read-only: writes nothing to the repo.

import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const BASE = arg('--base');
const HEAD = arg('--head');
const MODULES_ARG = arg('--modules');
const REPORT_WS = args.includes('--report-ws');
const REPO = arg('--repo') || process.cwd();
// Path prefixes (comma list) whose removed statements this landing must re-home. Default: every touched src/ or test/ file.
const REMOVED_PATHS = arg('--removed-paths') ? arg('--removed-paths').split(',').map((s) => s.trim()).filter(Boolean) : null;

if (!BASE || !HEAD) {
  console.error('usage: node scripts/sql-move-check.mjs --base <ref> --head <ref> [--modules a,b] [--report-ws] [--repo <dir>]');
  process.exit(2);
}

function git(argv, input) {
  try {
    return execFileSync('git', argv, {
      cwd: REPO,
      input,
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.error(`git ${argv.join(' ')} failed: ${e.stderr ? e.stderr.toString() : e.message}`);
    process.exit(2);
  }
}

function resolveRev(ref) {
  return git(['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim();
}

// List blobs under a tree for given paths: returns Map path -> blob sha.
function lsTree(rev, paths) {
  const out = git(['ls-tree', '-r', '--full-tree', rev, '--', ...paths]).toString();
  const m = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [, type, sha] = line.slice(0, tab).split(/\s+/);
    if (type !== 'blob') continue;
    m.set(line.slice(tab + 1), sha);
  }
  return m;
}

// Read many blobs in one git call. Returns Map sha -> utf8 string.
function readBlobs(shas) {
  const unique = [...new Set(shas)];
  const out = new Map();
  if (!unique.length) return out;
  const buf = git(['cat-file', '--batch'], unique.join('\n') + '\n');
  let pos = 0;
  for (let k = 0; k < unique.length; k++) {
    const nl = buf.indexOf(0x0a, pos);
    const header = buf.slice(pos, nl).toString();
    pos = nl + 1;
    const parts = header.split(' ');
    if (parts[1] === 'missing') { out.set(unique[k], ''); continue; }
    const size = Number(parts[2]);
    out.set(unique[k], buf.slice(pos, pos + size).toString('utf8'));
    pos += size + 1; // trailing newline
  }
  return out;
}

function listFiles(rev, paths) {
  return lsTree(rev, paths);
}

function changedPaths(base, head, paths) {
  const out = git(['diff', '--name-status', '-M', base, head, '--', ...paths]).toString();
  return out.split('\n').filter(Boolean).map((l) => l.split('\t'));
}

// ---- SQL literal lexer (mirrors the lexer used by the prior scans) ----
const KW = /\b(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP)\b/i;
const SHAPE = /\b(FROM|INTO|SET|WHERE|VALUES|TABLE|UPDATE|INSERT|SELECT|RETURNING|JOIN|WITH|UNION|DELETE)\b/i;

// The literals come from the TypeScript parser, not a hand-written scanner: a scanner has to guess whether a '/' starts a
// regular expression or a division (or a comment), and every wrong guess hides the rest of the line, SQL included.
function literals(src, file = 'x.ts') {
  const out = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const keep = (node) => {
    const start = node.getStart(sf);
    const raw = src.slice(start + 1, node.end - 1);
    if (KW.test(raw) && SHAPE.test(raw)) out.push({ line: ts.getLineAndCharacterOfPosition(sf, start).line + 1, raw });
  };
  const visit = (node) => {
    if (ts.isStringLiteral(node)) return keep(node);
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) return keep(node); // ${...} stays part of the text
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

// ---- main ----
const baseRev = resolveRev(BASE);
const headRev = resolveRev(HEAD);

const ENGINE_SQL = 'src/core/engine-sql/';
const allEngineSql = [...listFiles(headRev, [ENGINE_SQL]).keys()].filter((p) => p.endsWith('.ts'));
let targets;
if (MODULES_ARG) {
  const wanted = MODULES_ARG.split(',').map((s) => s.trim()).filter(Boolean);
  targets = wanted.map((m) => (m.startsWith(ENGINE_SQL) ? m : `${ENGINE_SQL}${m.replace(/\.ts$/, '')}.ts`));
  for (const t of targets) {
    if (!allEngineSql.includes(t)) { console.error(`module not found at head: ${t}`); process.exit(2); }
  }
} else {
  // default: engine-sql modules that are new or changed between base and head
  const changed = changedPaths(baseRev, headRev, [ENGINE_SQL]).filter(([s]) => s !== 'D');
  targets = changed.map((cols) => cols[cols.length - 1]).filter((p) => p.endsWith('.ts'));
}

// Build corpora
const baseTrees = listFiles(baseRev, ['src', 'test']);
const headTrees = listFiles(headRev, ['src', 'test']);
const baseTS = [...baseTrees.entries()].filter(([p]) => p.endsWith('.ts'));
const headTS = [...headTrees.entries()].filter(([p]) => p.endsWith('.ts'));
const baseBlobs = readBlobs(baseTS.map(([, s]) => s));
const headBlobs = readBlobs(headTS.map(([, s]) => s));

// Base literal index: raw text -> [{file,line}] (src first, then test)
const baseIndex = new Map();
const baseNormIndex = new Map();
const baseLits = [];
for (const [path, sha] of baseTS) {
  for (const { line, raw } of literals(baseBlobs.get(sha) || '')) {
    const rec = { file: path, line, raw };
    baseLits.push(rec);
    if (!baseIndex.has(raw)) baseIndex.set(raw, []);
    baseIndex.get(raw).push(rec);
    const nn = norm(raw);
    if (!baseNormIndex.has(nn)) baseNormIndex.set(nn, []);
    baseNormIndex.get(nn).push(rec);
  }
}
const pick = (recs) => (recs.find((r) => r.file.startsWith('src/')) || recs[0]);

// Head engine-sql index (for NO-NEW-HOME)
const headEngineSqlRaw = new Map();
const headEngineSqlLits = [];
for (const [path, sha] of headTS.filter(([p]) => p.startsWith(ENGINE_SQL))) {
  for (const { line, raw } of literals(headBlobs.get(sha) || '')) {
    headEngineSqlLits.push({ file: path, line, raw });
    if (!headEngineSqlRaw.has(raw)) headEngineSqlRaw.set(raw, []);
    headEngineSqlRaw.get(raw).push({ file: path, line });
  }
}
// Head anywhere in src/test (a removed statement is one that no longer appears here at all)
const headAllRaw = new Set();
for (const [, sha] of headTS) for (const { raw } of literals(headBlobs.get(sha) || '')) headAllRaw.add(raw);

const rows = [];
const counts = { IDENTICAL: 0, 'NOT-IDENTICAL': 0, 'NO-NEW-HOME': 0, wsOnly: 0, newStatements: 0 };

// 1) Head statements in the target modules
for (const path of targets) {
  const sha = headTrees.get(path);
  if (!sha) { rows.push({ module: path, stmt: '(module missing at head)', cls: 'NOT-IDENTICAL', origin: '-' }); counts['NOT-IDENTICAL']++; continue; }
  const lits = literals(headBlobs.get(sha) || '');
  for (const { line, raw } of lits) {
    const snippet = norm(raw).slice(0, 120);
    const hits = baseIndex.get(raw);
    if (hits) {
      const o = pick(hits);
      rows.push({ module: path, line, stmt: snippet, cls: 'IDENTICAL', origin: `${o.file}:${o.line}` });
      counts.IDENTICAL++;
    } else {
      const wsHits = baseNormIndex.get(norm(raw));
      counts.newStatements++;
      if (wsHits) {
        const o = pick(wsHits);
        rows.push({ module: path, line, stmt: snippet, cls: 'NOT-IDENTICAL', origin: `${o.file}:${o.line} (whitespace-only)`, ws: true });
        counts.wsOnly++;
      } else {
        rows.push({ module: path, line, stmt: snippet, cls: 'NOT-IDENTICAL', origin: 'none (new or changed text)' });
      }
      counts['NOT-IDENTICAL']++;
    }
  }
}

// 2) Removed statements: base literals whose text no longer appears in any head src/test file,
//    and that have no byte-identical home in a head engine-sql module.
// Scope: only files under src/ or test/ that the base..head diff touches (modified, renamed-from or deleted).
const touchedBase = new Set(
  changedPaths(baseRev, headRev, ['src', 'test']).map((cols) => cols[1]).filter((p) => p && p.endsWith('.ts')),
);
const seenRemoved = new Set();
for (const rec of baseLits) {
  if (!touchedBase.has(rec.file)) continue;       // removed side is limited to files this diff touches
  if (REMOVED_PATHS && !REMOVED_PATHS.some((p) => rec.file.startsWith(p))) continue; // landing scope
  if (headAllRaw.has(rec.raw)) continue;          // still present somewhere -> not removed
  if (seenRemoved.has(rec.raw)) continue;
  seenRemoved.add(rec.raw);
  if (headEngineSqlRaw.has(rec.raw)) continue;    // has a new home
  // Only report removed statements from files that the diff touches (keeps the list to this move)
  rows.push({ module: '(removed)', line: rec.line, stmt: norm(rec.raw).slice(0, 120), cls: 'NO-NEW-HOME', origin: `${rec.file}:${rec.line}` });
  counts['NO-NEW-HOME']++;
}

// Output
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
console.log(`base ${baseRev.slice(0, 10)}  head ${headRev.slice(0, 10)}  modules ${targets.length}`);
console.log(pad('CLASS', 15) + pad('MODULE', 52) + pad('ORIGIN', 60) + 'STATEMENT');
for (const r of rows) {
  const where = r.line ? `${r.module}:${r.line}` : r.module;
  const origin = r.origin;
  if (r.cls === 'IDENTICAL' && !REPORT_WS) {
    console.log(pad(r.cls, 15) + pad(where, 52) + pad(origin, 60) + r.stmt);
  } else if (r.cls === 'IDENTICAL' && REPORT_WS) {
    console.log(pad(r.cls, 15) + pad(where, 52) + pad(origin, 60) + r.stmt);
  } else {
    console.log(pad(r.cls, 15) + pad(where, 52) + pad(origin, 60) + r.stmt);
  }
}
console.log('');
console.log(`IDENTICAL (byte-identical): ${counts.IDENTICAL}`);
console.log(`NOT-IDENTICAL: ${counts['NOT-IDENTICAL']}  (of which whitespace-only matches: ${counts.wsOnly})`);
console.log(`NO-NEW-HOME (removed, no byte-identical home in engine-sql): ${counts['NO-NEW-HOME']}`);
const fail = counts['NOT-IDENTICAL'] > 0 || counts['NO-NEW-HOME'] > 0;
console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(fail ? 1 : 0);
