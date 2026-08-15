/**
 * Structural test for `gbrain extract --workers N` wiring (v0.41.15.0, T7).
 *
 * Per codex #16/#17 the high-value assertion for a CPU-bound migration
 * is that the helper is wired in, not byte-equality. extract is CPU-
 * bound (markdown parse + regex), so the speedup is moderate; the
 * primary contract is "API surface exists + threads correctly +
 * existing serial behavior preserved when --workers is omitted."
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const EXTRACT_SRC = readFileSync(
  resolve(REPO_ROOT, 'src/commands/extract.ts'),
  'utf-8',
);

describe('extract.ts → workers wiring (T7)', () => {
  test('imports runSlidingPool from worker-pool helper', () => {
    expect(EXTRACT_SRC).toMatch(
      /import\s*\{\s*runSlidingPool\s*\}\s*from\s*['"]\.\.\/core\/worker-pool\.ts['"]/,
    );
  });

  test('imports parseWorkers + resolveWorkersWithClamp', () => {
    expect(EXTRACT_SRC).toMatch(
      /parseWorkers,\s*resolveWorkersWithClamp/,
    );
  });

  test('ExtractOpts type carries optional workers field', () => {
    expect(EXTRACT_SRC).toMatch(/workers\?:\s*number/);
  });

  test('runExtractCore resolves workers via the PGLite-clamp wrapper', () => {
    expect(EXTRACT_SRC).toMatch(/resolveWorkersWithClamp\(\s*engine,\s*opts\.workers/);
  });

  test('CLI runExtract parses --workers via parseWorkers (loud-fail on invalid)', () => {
    // The parsed value must come from parseWorkers (validates >=1
    // integer) AND must thread into runExtractCore opts.
    expect(EXTRACT_SRC).toMatch(/parseWorkers\(args\[/);
    expect(EXTRACT_SRC).toMatch(/workers,?\s*\}\);/);
  });

  test('all three inner loops accept the workers parameter', () => {
    // extractForSlugs, extractLinksFromDir, extractTimelineFromDir all
    // receive workers (default 1 for back-compat).
    expect(EXTRACT_SRC).toMatch(/extractForSlugs[\s\S]*?workers:\s*number/);
    expect(EXTRACT_SRC).toMatch(/extractLinksFromDir[\s\S]*?workers:\s*number/);
    expect(EXTRACT_SRC).toMatch(/extractTimelineFromDir[\s\S]*?workers:\s*number/);
  });

  test('all three inner loops call runSlidingPool', () => {
    // 3 inner loops × 1 runSlidingPool call each = 3 occurrences total
    // (extract.ts has no other runSlidingPool callers).
    const calls = EXTRACT_SRC.match(/runSlidingPool\(/g) ?? [];
    expect(calls.length).toBe(3);
  });

  test('legacy `for (let i = 0; i < files.length; i++)` per-file loops are gone', () => {
    // The pre-T7 serial loops would fight the worker-pool semantics.
    // After migration only one such loop may remain (acceptable: the
    // dir-walker itself which isn't per-file work). We assert <= 1.
    const serialLoops = EXTRACT_SRC.match(/for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*files\.length/g) ?? [];
    expect(serialLoops.length).toBeLessThanOrEqual(1);
  });

  test('extractForSlugs (the CLI/cycle path) is migrated to the pool', () => {
    // Two legacy `for (const slug of slugs)` loops survive in
    // extractLinksForSlugs + extractTimelineForSlugs — the sync-integration
    // hooks. Those are out of T7 scope (called from sync.ts post-sync, not
    // from the user-facing `gbrain extract` CLI). T7 covers extractForSlugs
    // + extractLinksFromDir + extractTimelineFromDir which carry --workers
    // from the CLI surface.
    const legacyCount = (EXTRACT_SRC.match(/for\s*\(\s*const\s+slug\s+of\s+slugs\)/g) ?? []).length;
    expect(legacyCount).toBeLessThanOrEqual(2);
    // The migrated extractForSlugs uses runSlidingPool over `slugs`, not
    // a for-of loop. Confirm by checking that one of the 3 runSlidingPool
    // call sites operates on `slugs`.
    expect(EXTRACT_SRC).toMatch(/runSlidingPool\(\s*\{\s*items:\s*slugs/);
  });

  test('CLI threads workers into runExtractCore call', () => {
    // The opts-object passed to runExtractCore must include the workers
    // field; without this the parsed CLI flag would silently drop on
    // the FS-source happy path.
    expect(EXTRACT_SRC).toMatch(
      /runExtractCore\(engine,\s*\{[\s\S]*?workers,[\s\S]*?\}\)/,
    );
  });
});
