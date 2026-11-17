#!/usr/bin/env node
/**
 * CI guard for the "two-dot folder name" path-containment bug class.
 *
 * The trap: `relative(root, p).startsWith('..')` is meant to ask "does p leave
 * root?", but it also matches a legal first folder whose name starts with two
 * dots (`..drafts/a`, `..x`, `...`). A file that is inside the root is then
 * refused, or reported as outside, or (worse) a scope silently widens.
 *
 * The fix pattern: `relativeEscapesRoot(rel)` from src/core/path-confine.ts,
 * which checks the first path component exactly (`..`, `../`, `..` + sep, or an
 * absolute path), or `resolvedPrefixContained` over resolved paths.
 *
 * Heuristic: flag any `.startsWith('..')` call (single, double or backtick
 * quotes) on a code line of a source file. Comment lines (starting with `//`,
 * `*` or `/*`) are skipped. `startsWith('../')` and `startsWith(`..${sep}`)`
 * are component-aware and are not flagged.
 *
 * Opt-out: a `gbrain-allow-dotdot-prefix: <reason>` comment on the line or the
 * line above, for a check that is not about path containment.
 *
 * Exit 0 = clean, 1 = violations. Runs under node or bun. The scan root is
 * argv[2], else GBRAIN_GUARD_ROOT, else `src` (the self-test points it at
 * test/fixtures/guards/check-relative-dotdot.mjs/{bad,good}).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.argv[2] || process.env.GBRAIN_GUARD_ROOT || 'src';
const PATTERN = /\.startsWith\(\s*(['"`])\.\.\1\s*\)/;
const OPT_OUT = 'gbrain-allow-dotdot-prefix';

// Temporary exception, paths relative to the scan root. Remove each entry when
// its condition holds; a stale entry prints a note so the removal is not missed.
const TEMPORARY = new Map([]);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

if (!existsSync(ROOT)) {
  console.error(`check-relative-dotdot: scan root ${ROOT} does not exist`);
  process.exit(1);
}

const violations = [];
const used = new Set();
for (const file of walk(ROOT, [])) {
  const rel = relative(ROOT, file).split('\\').join('/');
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (!PATTERN.test(line)) return;
    if (line.includes(OPT_OUT) || (i > 0 && lines[i - 1].includes(OPT_OUT))) return;
    if (TEMPORARY.has(rel)) { used.add(rel); return; }
    violations.push(`${join(ROOT, rel)}:${i + 1}: ${t}`);
  });
}

for (const [rel, why] of TEMPORARY) {
  if (!used.has(rel) && existsSync(join(ROOT, rel))) console.log(`note: temporary exception ${rel} no longer matches (${why}); delete it from scripts/check-relative-dotdot.mjs`);
}

if (violations.length) {
  console.error('ERROR: `.startsWith(\'..\')` also matches a legal folder name such as `..drafts`.');
  console.error('Use relativeEscapesRoot(rel) from src/core/path-confine.ts (or resolvedPrefixContained).');
  console.error(`Opt out only for a check that is not about paths: // ${OPT_OUT}: <reason>`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log('OK: no prefix-only `..` containment checks');
