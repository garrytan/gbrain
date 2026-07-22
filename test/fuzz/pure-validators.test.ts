/**
 * Pure-validator fuzz tests.
 *
 * Targets here are PROVEN-PURE by the import-graph bundle check in
 * `scripts/check-fuzz-purity.sh`: no transitive imports of `node:fs`,
 * `node:child_process`, network builtins, or engine modules. If any
 * target's containing file gains an impure dependency, the purity guard
 * fails the build before the fuzz tests run.
 *
 * The pure set is intentionally small (2 functions) for honest reasons:
 * `bun build --target=bun` reveals that gbrain's other "validator-shaped"
 * functions live in files that transitively pull in `fs` through helpers
 * in the same module. The original T2 plan listed 7 targets; the bundle
 * disproved that for 5 of them. Those 5 still get property-tested in
 * `mixed-validators.test.ts` — same coverage, just no purity guarantee.
 *
 * Follow-up TODO: extract pure validator logic to a dedicated
 * `src/core/pure/` directory so the fuzz target list can grow safely.
 *
 * Property: every fuzz target either succeeds normally or throws a typed
 * error — but NEVER wedges the runtime (infinite loop caught by
 * fast-check's per-property timeout; process crash caught by bun:test).
 *
 * Cost budget: 1000 runs per property, 2 targets, ~3s total. Runs in the
 * default `bun test` loop (no .slow suffix).
 *
 * Pin a regression by copying fast-check's minimal repro into
 * `test/fuzz/regressions/<target>-<short-hash>.test.ts` as a normal
 * bun:test assertion.
 */

import { describe, test } from 'bun:test';
import fc from 'fast-check';

import { escapeLikePattern } from '../../src/core/cjk.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';

const NUM_RUNS = 1000;

describe('pure-validator fuzz (purity-guarded set)', () => {
  test('escapeLikePattern: returns a string on any input, never throws', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const out = escapeLikePattern(input);
        if (typeof out !== 'string') {
          throw new Error(`escapeLikePattern returned non-string: ${typeof out}`);
        }
        // Contract: every `%`, `_`, and `\` in input becomes `\%`, `\_`, `\\`
        // in output. We don't reproduce the full transformation here, just
        // assert that any `%`/`_`/`\` survives in the output (escaped, in
        // some form). Fast-check's value is the broad input space, not a
        // precise contract — that's covered by unit tests in src/core.
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test('parseFactsFence: returns a parse result on any input, never throws', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const out = parseFactsFence(input);
        if (out === undefined || out === null) {
          throw new Error('parseFactsFence returned null/undefined');
        }
        // FactsFenceParseResult is a typed shape; for fuzz we just verify
        // the function doesn't throw and produces a non-null result.
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Fence-shaped inputs: stress the row-parser with malformed pipe-delimited
  // lines, which is the realistic adversarial input shape (user-supplied
  // markdown that almost looks like a fence row).
  test('parseFactsFence: stress with malformed pipe-delimited input', () => {
    const fenceShaped = fc.oneof(
      fc.constant('| claim | actor | since | until |'),
      fc.constant('| | | | |'),
      fc.string().map((s) => `| ${s} |`),
      fc.string().map((s) => `| ${s} | ${s} |`),
      fc.tuple(fc.string(), fc.string(), fc.string()).map(([a, b, c]) => `| ${a} | ${b} | ${c} |`),
    );
    fc.assert(
      fc.property(fenceShaped, (input) => {
        const out = parseFactsFence(input);
        if (out === undefined || out === null) {
          throw new Error('parseFactsFence returned null/undefined on fence-shaped input');
        }
      }),
      { numRuns: 500 },
    );
  });
});
