/**
 * pglite-engine.ts search path timeout — parity with postgres-engine.ts.
 *
 * Regression guard for R8-F1 (engine-parity DoS gap, 2026-04-20):
 * postgres-engine.ts wraps `searchKeyword` and `searchVector` in
 * `sql.begin` + `SET LOCAL statement_timeout = '8s'` so that a pathological
 * tsquery or similarity scan can't freeze the pooled connection. PGLite
 * auto-commits each `.query()` call so `SET LOCAL` is a no-op, and prior
 * to this fix there was NO equivalent protection on PGLite — a single slow
 * query would hang the single-threaded WASM event loop and with it the
 * MCP session, `gbrain jobs work` daemon, and autopilot cycle.
 *
 * The fix wraps the two search queries in a `queryWithTimeout` helper that
 * uses `Promise.race` against an 8s timer. The WASM query keeps running to
 * completion in the background (PGLite has no cancel API at 0.4.x) but the
 * awaiting caller is freed, matching the Postgres engine's 8s ceiling.
 *
 * Two coverage layers:
 *   1. Source-level: the search paths call `queryWithTimeout`, not raw
 *      `this.db.query`.
 *   2. Functional: a fake PGLite whose `.query()` never resolves triggers
 *      the timeout path and rejects with the documented error.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'core', 'pglite-engine.ts'),
  'utf-8',
);

// Strip comments so commentary mentioning the anti-pattern doesn't false-positive.
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

describe('pglite-engine / search path timeout (R8-F1)', () => {
  test('queryWithTimeout helper exists with an 8s default cap', () => {
    const stripped = stripComments(SRC);
    expect(stripped).toContain('SEARCH_QUERY_TIMEOUT_MS = 8000');
    expect(stripped).toMatch(/async function queryWithTimeout/);
  });

  test('searchKeyword routes through queryWithTimeout', () => {
    const stripped = stripComments(SRC);
    // Grab just the searchKeyword method body.
    const match = stripped.match(/async searchKeyword[\s\S]*?^\s\s\}/m);
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).toContain('queryWithTimeout');
    expect(body).not.toMatch(/\bthis\.db\.query\(/);
  });

  test('searchVector routes through queryWithTimeout', () => {
    const stripped = stripComments(SRC);
    const match = stripped.match(/async searchVector[\s\S]*?^\s\s\}/m);
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).toContain('queryWithTimeout');
    expect(body).not.toMatch(/\bthis\.db\.query\(/);
  });

  test('queryWithTimeout rejects when the underlying query never resolves', async () => {
    // Import the module and pull out the helper via a test seam. Since
    // queryWithTimeout is module-local, we exercise it via the exported
    // engine class with a fake db.
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    // Inject a fake db whose .query() never resolves. Cast through unknown
    // to bypass the private field type; the test is validating the timeout,
    // not the engine's type hygiene.
    const hangingDb = {
      query: () => new Promise(() => {}),
    };
    (engine as unknown as { _db: unknown })._db = hangingDb;

    // searchKeyword must reject within well under 8s. Use a tight 1s test
    // deadline to keep the suite fast — the helper's own 8000ms cap still
    // governs the engine's behavior in production; we just don't want the
    // test to wait that long. Patch the helper's timeout for this call by
    // monkey-patching the timer: easier to wait 8s than to refactor the
    // constant for test injection, so we just trust the cap and check that
    // the rejection path fires rather than hanging forever.
    const start = Date.now();
    let threw: Error | null = null;
    try {
      // Race the engine call against a 9s test timer so a bug that removes
      // the timeout surfaces as a test-level timeout rather than a hang.
      await Promise.race([
        engine.searchKeyword('ignored'),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('test harness bail: engine.searchKeyword did not reject within 9s')), 9000),
        ),
      ]);
    } catch (err) {
      threw = err as Error;
    }
    const elapsedMs = Date.now() - start;
    expect(threw).not.toBeNull();
    expect(threw!.message).toMatch(/pglite searchKeyword query exceeded|test harness bail/);
    // Sanity: the 8s cap should fire well before the 9s test bail.
    expect(elapsedMs).toBeLessThan(8500);
  }, 15000);
});
