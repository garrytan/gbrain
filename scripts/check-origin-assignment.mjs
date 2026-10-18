#!/usr/bin/env node
/**
 * #6948 CI guard: every write that records a page origin (`pages.source_path`)
 * goes through src/core/persistence/origin-guard.ts (`bindOrigin`, or
 * `assertOriginUnclaimed` in the same transaction), so no writer can give a
 * second live page of a source an origin another page already records.
 *
 * Flags, in non-test source files:
 *   (a) an `UPDATE pages ... SET` whose SET clause assigns `source_path` a value
 *       other than NULL (a clear is not an assignment);
 *   (b) an `INSERT INTO pages (...)` whose column list carries `source_path`;
 *   (c) an `UPDATE pages ... SET` that assigns `slug`: a rename carries the
 *       page's recorded origin to a new identity, so each such statement is
 *       reviewed and marked with why it adds no claimant.
 * origin-guard.ts itself is exempt. A guarded site that must keep its SQL
 * inline carries `origin-guard-ok: <reason>` on the statement's line or one
 * of the three lines above it.
 *
 * Exit 0 = clean, 1 = violations. Runs under node or bun. Roots: argv
 * (fixtures for the self-test) or src/.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOTS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['src'];
const OWNER = 'src/core/persistence/origin-guard.ts';
const MARKER = 'origin-guard-ok:';
const UPDATE_RE = /UPDATE\s+pages\b(?:\s+(?:AS\s+)?(?!SET\b)[A-Za-z_]\w*)?\s+SET\b([\s\S]{0,2000}?)(?=\bWHERE\b|\bRETURNING\b|`|$)/gi;
const INSERT_RE = /INSERT\s+INTO\s+pages\s*\(([^)]*)\)/gi;
const ASSIGN_RE = /\bsource_path\s*=\s*(?!NULL\b)\S/i;
const SLUG_RE = /\bslug\s*=/i;

function files(path) {
  const st = statSync(path);
  if (st.isFile()) return path.endsWith('.ts') || path.endsWith('.mjs') ? [path] : [];
  return readdirSync(path).sort().flatMap(entry => files(join(path, entry)));
}

const violations = [];
for (const root of ROOTS) {
  for (const file of files(root)) {
    const rel = relative(process.cwd(), file).split(sep).join('/');
    if (rel.endsWith(OWNER) || /\.test\.ts$/.test(file)) continue;
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const report = (index, what) => {
      const line = src.slice(0, index).split('\n').length;
      const text = lines[line - 1].trim();
      if (text.startsWith('*') || text.startsWith('//') || text.startsWith('/*')) return;
      if (lines.slice(Math.max(0, line - 4), line).some(l => l.includes(MARKER))) return;
      violations.push(`${rel}:${line}: ${what}`);
    };
    for (const m of src.matchAll(UPDATE_RE)) {
      if (ASSIGN_RE.test(m[1])) report(m.index, 'UPDATE pages assigns source_path outside origin-guard.ts');
      if (SLUG_RE.test(m[1])) report(m.index, 'UPDATE pages renames a slug, carrying its source_path, without the origin guard');
    }
    for (const m of src.matchAll(INSERT_RE)) if (/\bsource_path\b/i.test(m[1])) report(m.index, 'INSERT INTO pages carries source_path outside origin-guard.ts');
  }
}

if (violations.length) {
  console.error('check-origin-assignment: page origin writes that skip the origin guard (#6948):');
  for (const v of violations) console.error(`  ${v}`);
  console.error(`Route the write through bindOrigin (src/core/persistence/origin-guard.ts), or run assertOriginUnclaimed in the same transaction and mark the statement \`${MARKER} <reason>\`.`);
  process.exit(1);
}
console.log('check-origin-assignment: clean (every page origin write goes through the origin guard)');
