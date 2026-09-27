#!/usr/bin/env node
/**
 * CI guard for the ASCII-only normalisation bug class (#9, #12, #13, #21).
 *
 * The trap: `.toLowerCase().replace(/[^a-z0-9]+/g, '-')` looks like a slug
 * grammar, but every non-Latin letter is outside the class, so text written
 * only in Cyrillic (or any non-Latin script) loses every letter — empty
 * slugs, `untitled` collisions, dropped labels. The shared grammar lives in
 * src/core/cjk.ts: `slugifyText` for a hyphenated slug segment, or
 * `foldSlugText` + `SLUG_WORD_CHARS` (with the `u` flag) for other shapes.
 *
 * Heuristic: flag any `.replace(` / `.replaceAll(` whose first argument is a
 * regex literal starting with a NEGATED character class that names an ASCII
 * letter range (`a-z`, `A-Z`) or `\w` (ASCII-only in JS) and no Unicode
 * property escape (`\p{…}`).
 *
 * Opt-out: `gbrain-allow-ascii-class: <reason>` on the flagged line or the
 * line above, for machine identifiers where ASCII is intended (filenames,
 * launchd labels, API tool names, model ids). The reason is required.
 *
 * Exit 0 = clean, 1 = violations. Runs under node or bun. Scan roots default
 * to src/ and are overridable via argv (the guard self-test points it at
 * test/fixtures/guards/check-ascii-slug-class.mjs/{bad,good}).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['src'];

const REPLACE_NEGATED_CLASS_RE = /\.replace(?:All)?\(\s*\/\[\^((?:\\.|[^\]\\])*)\]/g;
const OPT_OUT_RE = /gbrain-allow-ascii-class:\s*\S/;

function isAsciiOnlyClass(body) {
  if (body.includes('\\p{')) return false;
  return /a-z|A-Z/.test(body) || /(^|[^\\])\\w/.test(body);
}

const violations = [];

function scanFile(path) {
  const lines = readFileSync(path, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(REPLACE_NEGATED_CLASS_RE)) {
      if (!isAsciiOnlyClass(m[1])) continue;
      if (OPT_OUT_RE.test(line) || (i > 0 && OPT_OUT_RE.test(lines[i - 1]))) continue;
      violations.push(`${path.replace(/\\/g, '/')}:${i + 1}: ${line.trim()}`);
    }
  });
}

function walk(dir) {
  let ents;
  try { ents = readdirSync(dir); } catch { return; }
  for (const name of ents) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs|js)$/.test(p) && !/\.test\.tsx?$/.test(p)) scanFile(p);
  }
}

for (const root of ROOTS) walk(root);

if (violations.length > 0) {
  console.error('ASCII-only character classes in replace() (drops non-Latin text):\n');
  for (const v of violations) console.error('  ' + v);
  console.error(
    '\nFix: mint slugs with slugifyText, or fold with foldSlugText and build the class from\n' +
    'SLUG_WORD_CHARS with the `u` flag (src/core/cjk.ts). For a machine identifier where\n' +
    'ASCII is intended, add `// gbrain-allow-ascii-class: <reason>` on that line or the line above.',
  );
  process.exit(1);
}
console.log('check-ascii-slug-class: clean (no unmarked ASCII-only replace() classes)');
