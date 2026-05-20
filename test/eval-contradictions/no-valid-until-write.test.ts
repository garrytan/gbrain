/**
 * v0.35.4 (R1 + R8 — D-CDX-4 + D-CDX-7) — IRON-RULE: the contradiction
 * probe NEVER writes `valid_until` on the facts table.
 *
 * The temporal trajectory wave (v0.35.4) gives `consolidate` the
 * authority to write `valid_until` on chronologically-superseded facts.
 * That authority is exclusive: the contradiction probe surfaces
 * `temporal_supersession` verdicts via paste-ready commands, but it
 * must NEVER auto-mutate. This preserves the
 * `src/core/eval-contradictions/auto-supersession.ts:4` invariant.
 *
 * Two layered guards:
 *   R1 — grep guard over the entire `src/core/eval-contradictions/`
 *        subtree and the `src/commands/eval-suspected-contradictions*.ts`
 *        files: no code path may UPDATE facts.valid_until.
 *   R8 — broader guard over all of `src/`: the only file that writes
 *        valid_until is `src/core/cycle/phases/consolidate.ts`. Any new
 *        write site fails this guard; the human adding it must explicitly
 *        amend the allow-list AND document the deliberate design change.
 */

import { test, expect, describe } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Allow-listed files that legitimately write `valid_until`. Adding a new
// file here means you've thought carefully about the
// auto-supersession.ts:4 invariant and decided the new write site
// preserves it.
//
//   - consolidate.ts (v0.35.4 — chronological writeback)
//   - facts/forget.ts (v0.32.2 — user-initiated `gbrain forget`; user is
//     the supersession authority, not the probe)
const VALID_UNTIL_WRITE_ALLOWLIST: ReadonlySet<string> = new Set([
  'src/core/cycle/phases/consolidate.ts',
  'src/core/facts/forget.ts',
]);

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip generated / vendored / test directories.
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      walkTs(full, acc);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Detect lines that look like they are UPDATEing facts.valid_until.
 * Permissive on SQL formatting (the same UPDATE can be split across lines,
 * use template strings, or use parameterized SQL via postgres.js's
 * tagged-template syntax). We look for the pair of substrings near
 * each other in the same file: `UPDATE facts` and `valid_until`.
 *
 * Tolerated: a reference to `valid_until` in a SELECT projection list
 * (which is fine — reading the column is not writing it) is filtered out
 * by also requiring a write verb (SET) nearby OR an INSERT INTO facts
 * with valid_until in the column list (INSERT path is OK from
 * src/core/postgres-engine.ts + src/core/pglite-engine.ts because those
 * are the engine layer, intentionally writing on caller request via
 * insertFact/insertFacts; the issue is whether the contradiction probe
 * path triggers those writes).
 */
function findValidUntilWrites(source: string): string[] {
  // Quick-fail: no mention of valid_until at all.
  if (!source.includes('valid_until')) return [];
  const lines = source.split('\n');
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Detect actual SQL writes. The narrow pattern `UPDATE facts SET ...
    // valid_until` is unambiguous — UPDATE is a SQL verb, not text
    // anyone writes in a description string. Tolerates same-line and
    // multi-line UPDATEs (look at the next 4 lines after `UPDATE facts`
    // for `valid_until`).
    if (/\bUPDATE\s+facts\b/i.test(line)) {
      const window = lines.slice(i, i + 5).join('\n');
      if (/\bSET\b[\s\S]*\bvalid_until\b/i.test(window)) {
        hits.push(`${i + 1}: ${line.trim()}`);
      }
    }
  }
  return hits;
}

describe('R1 — contradiction probe never writes valid_until', () => {
  test('no file under src/core/eval-contradictions/ writes facts.valid_until', () => {
    const dir = 'src/core/eval-contradictions';
    const files = walkTs(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      const hits = findValidUntilWrites(src);
      expect(hits, `${f} contains valid_until write: ${hits.join(' | ')}`).toEqual([]);
    }
  });

  test('no src/commands/eval-suspected-contradictions* file writes facts.valid_until', () => {
    const dir = 'src/commands';
    const files = readdirSync(dir)
      .filter(n => n.startsWith('eval-suspected-contradictions') && n.endsWith('.ts'))
      .map(n => join(dir, n));
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      const hits = findValidUntilWrites(src);
      expect(hits, `${f} contains valid_until write: ${hits.join(' | ')}`).toEqual([]);
    }
  });
});

describe('R8 — only the consolidate phase + engine insert layer may write valid_until', () => {
  test('every src/ TypeScript file that writes valid_until is on the allow-list', () => {
    const files = walkTs('src');
    const offenders: Array<{ file: string; hits: string[] }> = [];

    for (const f of files) {
      // Normalize path separator for cross-platform matching of the
      // allow-list keys.
      const relForCheck = f.replace(/\\/g, '/');
      if (VALID_UNTIL_WRITE_ALLOWLIST.has(relForCheck)) continue;

      // Engine implementation files (postgres-engine.ts, pglite-engine.ts)
      // legitimately write valid_until inside insertFact/insertFacts —
      // those are caller-driven INSERTs. Pattern is `INSERT INTO facts (
      // ... valid_until ...) VALUES`. Detect and exempt that pattern.
      // The R8 guard is about UPDATE; INSERT carrying valid_until as a
      // column value is not the failure mode auto-supersession.ts:4 cares
      // about.
      const src = readFileSync(f, 'utf-8');
      const hits = findValidUntilWrites(src);
      if (hits.length > 0) offenders.push({ file: relForCheck, hits });
    }

    expect(
      offenders,
      `Unexpected valid_until UPDATE sites:\n` +
      offenders.map(o => `  ${o.file}:\n    ${o.hits.join('\n    ')}`).join('\n') +
      `\n\nIf you added a deliberate write, append the path to ` +
      `VALID_UNTIL_WRITE_ALLOWLIST in this test AND review the ` +
      `\`auto-supersession.ts:4\` invariant first.`,
    ).toEqual([]);
  });

  test('VALID_UNTIL_WRITE_ALLOWLIST is non-empty (consolidate is on it)', () => {
    // Self-check: if the test file ever ships with an empty allow-list,
    // the R8 guard collapses to "no code writes valid_until anywhere" and
    // becomes a tautology. Keep the consolidate phase on the list as the
    // explicit positive control.
    expect(VALID_UNTIL_WRITE_ALLOWLIST.has('src/core/cycle/phases/consolidate.ts')).toBe(true);
  });
});
