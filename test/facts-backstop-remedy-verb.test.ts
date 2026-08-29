// #4489 — the facts backstop thin-client-fallback warning must name a REAL
// CLI remedy. It used to say "Configure local_path via `gbrain sources
// update`", but the sources dispatcher has no `update` case — the actual
// remedy is the #3903 non-destructive attach: `gbrain sources add <id>
// --path <dir>` (sources-ops.ts UPDATEs local_path when the existing row is
// path-less).
//
// Source-text pin: cheap, hermetic, and cross-checked against the dispatcher
// so the warning can never drift back to a verb that doesn't exist.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
// test-reads-source-ok: comment-contract pin — the warning's remedy TEXT is
// the product surface; cross-checked against the dispatcher's case labels.
const backstopSrc = readFileSync(join(REPO_ROOT, 'src/core/facts/backstop.ts'), 'utf-8');
// test-reads-source-ok: same pin — dispatcher side of the cross-check above.
const sourcesSrc = readFileSync(join(REPO_ROOT, 'src/commands/sources.ts'), 'utf-8');

describe('facts backstop thin-client-fallback remedy verb (#4489)', () => {
  test('warning does not name the nonexistent `gbrain sources update` verb', () => {
    expect(backstopSrc).not.toContain('gbrain sources update');
  });

  test('warning names the real attach remedy (`gbrain sources add ... --path`)', () => {
    // The fallback warning block should point at sources add with --path.
    const idx = backstopSrc.indexOf('facts:thin-client-fallback');
    expect(idx).toBeGreaterThan(-1);
    const windowText = backstopSrc.slice(idx, idx + 600);
    expect(windowText).toContain('gbrain sources add');
    expect(windowText).toContain('--path');
  });

  test('every `gbrain sources <verb>` the backstop recommends exists in the dispatcher', () => {
    // Extract each "gbrain sources <verb>" mention from the backstop and
    // assert the sources dispatcher has a matching `case '<verb>':`.
    const mentions = [...backstopSrc.matchAll(/gbrain sources ([a-z-]+)/g)].map((m) => m[1]!);
    expect(mentions.length).toBeGreaterThan(0);
    for (const verb of new Set(mentions)) {
      expect(sourcesSrc).toContain(`case '${verb}':`);
    }
  });
});
