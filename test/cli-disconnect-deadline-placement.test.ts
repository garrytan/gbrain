/**
 * #1775 — the op-dispatch hard-deadline timer must bound TEARDOWN ONLY.
 *
 * cli.ts installs an unref'd setTimeout that force-exits the process if
 * drain + engine.disconnect() hang (defense-in-depth C13, PGLite WASM
 * teardown). When that timer is armed BEFORE the op handler runs, it is
 * accidentally a whole-run deadline: any shared op slower than 10s total
 * (search/query against remote Postgres, a reranker pass, a query with
 * LLM expansion) gets process.exit() mid-handler — empty stdout, exit 0,
 * and a misleading "engine.disconnect() did not return" warning for a
 * disconnect that never ran. Slow handlers are bounded piecemeal by the
 * layers underneath (query-embed deadline, AI gateway deadlines, Postgres
 * statement_timeout); the hard deadline's only contract is bounding
 * teardown.
 *
 * Placement is the load-bearing property, so this is a source-shape test
 * (same rationale as test/fix-wave-structural.test.ts): a behavioral
 * repro would need a >10s op against a live engine just to observe the
 * timer fire, and a mocked handler would hide the regression behind the
 * test seam.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

describe('#1775 — disconnect hard-deadline is armed at teardown, never before the op handler', () => {
  const src = readFileSync('src/cli.ts', 'utf8');
  const start = src.indexOf('async function main()');
  const end = src.indexOf('function hasHelpFlag');
  const main = src.slice(start, end);

  test('anchors exist (guards against refactors silently vacating the test)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(main).toContain('await op.handler(ctx, params)');
    expect(main).toContain('forceExitTimer = setTimeout(');
    expect(main).toContain('drainAllBackgroundWorkForCliExit({ timeoutMs: 1000 })');
  });

  test('timer is armed after the op handler and before the drain it bounds', () => {
    const handlerIdx = main.indexOf('await op.handler(ctx, params)');
    const armIdx = main.indexOf('forceExitTimer = setTimeout(');
    const drainIdx = main.indexOf('drainAllBackgroundWorkForCliExit({ timeoutMs: 1000 })');
    const disconnectIdx = main.indexOf('await engine.disconnect()', drainIdx);

    // Armed in the teardown path (after the handler), immediately ahead of
    // the drain + disconnect it exists to bound.
    expect(armIdx).toBeGreaterThan(handlerIdx);
    expect(armIdx).toBeLessThan(drainIdx);
    expect(disconnectIdx).toBeGreaterThan(drainIdx);

    // Exactly one arming site in main() — no second pre-handler copy can
    // reintroduce the whole-run deadline.
    expect(main.indexOf('forceExitTimer = setTimeout(', armIdx + 1)).toBe(-1);
  });

  test('teardown still clears the timer after a successful disconnect', () => {
    const drainIdx = main.indexOf('drainAllBackgroundWorkForCliExit({ timeoutMs: 1000 })');
    const clearIdx = main.indexOf('if (forceExitTimer) clearTimeout(forceExitTimer)', drainIdx);
    expect(clearIdx).toBeGreaterThan(drainIdx);
  });
});
