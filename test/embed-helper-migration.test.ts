/**
 * Structural regression test for the embed.ts → worker-pool migration
 * (v0.41.15.0, T3, REGRESSION per IRON RULE).
 *
 * What this test asserts:
 *   1. embed.ts imports `runSlidingPool` from `../core/worker-pool.ts`.
 *   2. Both pre-migration sliding-pool sites are GONE:
 *      - the `let nextIdx = 0; async function worker() {}` shape
 *      - the `Promise.all(Array.from({ length: numWorkers }, () => worker()))`
 *        shape (which paired with the above).
 *   3. Both migration sites call `runSlidingPool({ items: ..., workers: CONCURRENCY, ... })`.
 *   4. The legacy `CONCURRENCY = parseInt(process.env.GBRAIN_EMBED_CONCURRENCY...)`
 *      default is preserved (codex finding #13 — embed's pre-existing default
 *      pre-dates autoConcurrency; the migration must NOT route it through
 *      resolveWorkersWithClamp). This is the load-bearing back-compat for
 *      every existing brain that relies on the 20-worker embed sweep.
 *
 * Why structural rather than end-to-end:
 *   Per codex finding #16/#17, embed.ts byte-equality via stubbed transport
 *   was overclaimed in the original plan — it can't prove provider retry
 *   behavior, SDK usage accounting, or progress event ordering preservation.
 *   The pre-migration sliding pool didn't have any of those guarantees either;
 *   it just had a small inline `while (nextIdx < pages.length)` loop. The
 *   honest contract is "the same pages still get embedded by the same workers
 *   reading from the same queue, just through a helper now." That's a
 *   structural property — easiest to pin by source grep.
 *
 *   The helper's contracts (atomic claim, abort propagation, failures[]
 *   shape, BudgetExhausted bypass) are exhaustively tested in
 *   test/worker-pool.test.ts; embed inherits those by import.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const EMBED_PATH = resolve(REPO_ROOT, 'src/commands/embed.ts');
const EMBED_SOURCE = readFileSync(EMBED_PATH, 'utf-8');

describe('embed.ts → worker-pool migration (T3)', () => {
  test('imports runSlidingPool from worker-pool helper', () => {
    expect(EMBED_SOURCE).toMatch(
      /import\s*\{\s*runSlidingPool\s*\}\s*from\s*['"]\.\.\/core\/worker-pool\.ts['"]/,
    );
  });

  test('calls runSlidingPool at least twice (embedAll + embedAllStale paths)', () => {
    const matches = EMBED_SOURCE.match(/runSlidingPool\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test('pre-migration `let nextIdx = 0; async function worker()` shape is gone', () => {
    // The exact shape the migration replaced. Either token alone could
    // legitimately appear in a comment or string literal; both together
    // on adjacent lines indicates a regression to the inline pool.
    const inlinePool =
      /let\s+nextIdx\s*=\s*0\s*;\s*\n\s*async\s+function\s+worker\s*\(/;
    expect(EMBED_SOURCE).not.toMatch(inlinePool);
  });

  test('pre-migration `Promise.all(Array.from({ length: numWorkers }, () => worker()))` is gone', () => {
    // Migration-specific shape from the original inline pool. The
    // generic `Promise.all(...)` pattern is still allowed elsewhere
    // (gateway, etc.); only the worker-pool-fanout shape is banned.
    const fanout =
      /Promise\.all\(Array\.from\(\{\s*length:\s*numWorkers\s*\}/;
    expect(EMBED_SOURCE).not.toMatch(fanout);
  });

  test('preserves GBRAIN_EMBED_CONCURRENCY default of 20 (codex #13)', () => {
    // The pre-migration default must survive: env override or 20.
    // Routing through resolveWorkersWithClamp would change this behavior
    // (autoConcurrency returns 1 for small file counts even on Postgres),
    // breaking every existing brain that relies on the 20-worker default.
    expect(EMBED_SOURCE).toMatch(
      /parseInt\(process\.env\.GBRAIN_EMBED_CONCURRENCY\s*\|\|\s*['"]20['"]/,
    );
  });

  test('runSlidingPool call sites pass `workers: CONCURRENCY`', () => {
    // The migrated calls must thread the pre-existing CONCURRENCY value
    // through, not invent a new default. Catches the regression where
    // a future contributor swaps `workers: CONCURRENCY` for a literal.
    // Allow optional commas/whitespace — match both call sites' shape.
    const callSites = EMBED_SOURCE.match(
      /runSlidingPool\(\s*\{[\s\S]*?workers:\s*CONCURRENCY/g,
    );
    expect(callSites?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('embedAllStale path still threads budgetSignal into pool', () => {
    // The pre-migration code checked `!budgetSignal.aborted` in the
    // worker loop. The migration moves that check into the helper via
    // the `signal` option. If a future refactor drops the signal, the
    // wall-clock budget cancellation regresses.
    expect(EMBED_SOURCE).toMatch(
      /runSlidingPool\(\s*\{[\s\S]*?signal:\s*budgetSignal[\s\S]*?\}\)/,
    );
  });

  test('failureLabel projector uses page.slug (memory bound on large brains)', () => {
    // Per codex #10 + D7, failures[] must not store full Page objects.
    // We can't test the runtime behavior without a full mock engine, but
    // we CAN assert the call sites pass the projector explicitly.
    expect(EMBED_SOURCE).toMatch(/failureLabel:\s*\(page\)\s*=>\s*page\.slug/);
  });
});
