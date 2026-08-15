/**
 * Structural regression — the teardown hard-deadline must be armed at
 * TEARDOWN ENTRY, never before the op-dispatch body.
 *
 * Pre-fix bug (closed independently by v0.42.41.0 and the #2084 wave, merged):
 * a 10s unref'd setTimeout armed BEFORE the try killed any op whose handler
 * ran past 10s wall-clock with process.exit(0) and ZERO stdout — an empty
 * "success" indistinguishable from no results.
 *
 * Post-merge shape (#2084): the deadline lives inside `finishCliTeardown`
 * (src/core/cli-force-exit.ts), armed as the helper's first act — i.e. at
 * teardown entry, because every cli.ts call site invokes the helper from a
 * `finally`. The op body's wallclock is bounded separately by the read-scope
 * withTimeout wrap (v0.42.41.0). Source-grep is the right tool here (same
 * rationale as fix-wave-structural.test.ts): a behavioral test would need
 * >10s of real wall-clock in a spawned CLI.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

describe('cli.ts — disconnect hard-deadline armed at teardown entry, not before the op body', () => {
  test('no timer arming exists between op-dispatch setup and the try; the deadline arms inside finishCliTeardown before the drain', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');

    // The old pre-try arming constant must stay gone (its return is the
    // kill-slow-ops-with-exit-0 regression).
    expect(cli).not.toContain('DISCONNECT_HARD_DEADLINE_MS');

    // Between the op-dispatch engine connect and the try there is no
    // setTimeout call site (`setTimeout(` matches calls only; the
    // ReturnType<typeof setTimeout> annotation stays allowed).
    const connectIdx = cli.indexOf('// Local engine path (unchanged behavior for local installs).');
    expect(connectIdx).toBeGreaterThan(-1);
    const tryIdx = cli.indexOf('try {', connectIdx);
    expect(tryIdx).toBeGreaterThan(-1);
    expect(cli.slice(connectIdx, tryIdx)).not.toContain('setTimeout(');

    // The op-dispatch finally routes through the shared teardown helper.
    const finallyIdx = cli.indexOf('} finally {', tryIdx);
    expect(finallyIdx).toBeGreaterThan(-1);
    const teardownCallIdx = cli.indexOf('finishCliTeardown({ engine, drainTimeoutMs: 1000 })', finallyIdx);
    expect(teardownCallIdx).toBeGreaterThan(finallyIdx);

    // Inside the helper, the backstop arms BEFORE the drain runs — teardown
    // entry, bounding drain + disconnect and nothing else.
    const helper = readFileSync('src/core/cli-force-exit.ts', 'utf8');
    const armIdx = helper.indexOf('const backstop = setTimeout(');
    expect(armIdx).toBeGreaterThan(-1);
    const drainIdx = helper.indexOf('await drain({ timeoutMs: drainTimeoutMs })', armIdx);
    expect(drainIdx).toBeGreaterThan(armIdx);
    // Cleared on clean teardown.
    expect(helper.indexOf('clearTimeout(backstop)', drainIdx)).toBeGreaterThan(drainIdx);
  });
});
