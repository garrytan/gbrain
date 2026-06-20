#!/usr/bin/env node
/**
 * CI guard (companion to check-jsonb-pattern.sh): catch the PARAMETERIZED
 * jsonb double-encode that the bash guard misses.
 *
 * The bash guard only catches the interpolated template form
 * `${JSON.stringify(x)}::jsonb`. But the same data-loss bug occurs with
 * positional params:
 *
 *     engine.executeRaw(`INSERT ... VALUES ($1::jsonb)`, [JSON.stringify(obj)])
 *
 * postgres.js re-encodes the already-stringified value into a jsonb *string*
 * scalar (PGLite hides it), so jsonb_each / ->> / jsonb_array_elements break.
 * The fix is to pass the RAW object (postgres.js serializes it to proper jsonb
 * on both engines). See CLAUDE.md "JSONB" invariant.
 *
 * For each executeRaw / .unsafe( / .query( call we extract the *balanced*
 * argument list (skipping strings, template literals, and comments so SQL
 * parens/braces don't confuse the matcher), then flag it when the args contain
 * both a `$N::jsonb` placeholder and a `JSON.stringify(`. The intentional
 * `to_jsonb($N::text)` form (deliberately building a jsonb string element) is
 * allowed.
 *
 * Exit: 0 clean, 1 on findings.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
// Method-call form only (`.executeRaw(`, `.unsafe(`, `.query(`) — every DB call
// in this codebase is a method invocation, so requiring the leading `.` avoids
// matching the bare word "query" in prose/identifiers.
const CALL_RE = /\.(executeRaw|unsafe|query)\s*(?:<[^>]*>)?\s*\(/g;

/**
 * Blank out // and /* *\/ comments (replace their chars with spaces, keeping
 * newlines so line numbers stay accurate). String/template literals are copied
 * through untouched — the SQL with `$N::jsonb` lives there. This stops comment
 * prose (which often *describes* the JSON.stringify/jsonb anti-pattern) from
 * registering as a real finding.
 */
function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], c2 = text[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += c; i++;
      while (i < text.length) { out += text[i]; if (text[i] === '\\') { i++; if (i < text.length) out += text[i]; i++; continue; } if (text[i] === q) break; i++; }
      continue;
    }
    if (c === '/' && c2 === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } if (i < text.length) out += '\n'; continue; }
    if (c === '/' && c2 === '*') { const end = text.indexOf('*/', i + 2); const stop = end === -1 ? text.length : end + 2; for (; i < stop; i++) out += text[i] === '\n' ? '\n' : ' '; i--; continue; }
    out += c;
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('/test/')) out.push(p);
  }
  return out;
}

/**
 * Given source text and the index of an opening '(', return the substring
 * through its matching ')'. Skips '...' "..." `...` strings (with escapes) and
 * // line + block comments so parens inside SQL/strings don't break balancing.
 */
function extractBalanced(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '/' && c2 === '/') { const nl = text.indexOf('\n', i); if (nl === -1) return text.slice(openIdx); i = nl; continue; }
    if (c === '/' && c2 === '*') { const end = text.indexOf('*/', i + 2); if (end === -1) return text.slice(openIdx); i = end + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === q) break; i++; }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return text.slice(openIdx);
}

const findings = [];
for (const file of walk(SRC)) {
  const text = stripComments(readFileSync(file, 'utf8'));
  for (const m of text.matchAll(CALL_RE)) {
    const openIdx = text.indexOf('(', m.index + m[0].length - 1);
    if (openIdx === -1) continue;
    const args = extractBalanced(text, openIdx);
    if (!/\$\d+::jsonb/.test(args)) continue;
    const argsNoToJsonb = args.replace(/to_jsonb\([^)]*\)/g, '');
    if (!/JSON\.stringify\(/.test(argsNoToJsonb)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    findings.push(`${file.replace(ROOT + '/', '')}:${line}  (${m[1]} binds JSON.stringify(...) into a $N::jsonb param)`);
  }
}

if (findings.length) {
  console.error('ERROR: parameterized JSON.stringify(...) into a $N::jsonb bind (double-encode):');
  for (const f of findings) console.error('  ' + f);
  console.error('\n  postgres.js re-encodes the string into a jsonb string scalar (PGLite hides it),');
  console.error('  breaking jsonb_each / ->> / jsonb_array_elements. Pass the RAW object instead.');
  console.error('  See CLAUDE.md "JSONB" invariant and src/core/search/query-cache.ts for the pattern.');
  process.exit(1);
}
console.log('OK: no parameterized JSON.stringify(x)::jsonb double-encode in src/');
