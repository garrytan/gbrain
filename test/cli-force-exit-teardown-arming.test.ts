/**
 * Structural regression — the DISCONNECT_HARD_DEADLINE_MS force-exit timer in
 * cli.ts main() must be armed at TEARDOWN ENTRY (inside the finally, before
 * the drain + disconnect), never before the op-dispatch try block.
 *
 * Pre-fix bug: the 10s unref'd setTimeout was armed BEFORE the try, so any op
 * whose handler ran past 10s wall-clock was killed mid-flight with
 * process.exit(0) and ZERO stdout — an empty "success" indistinguishable from
 * no results (a healthy `gbrain search` on a slow Postgres pooler hit this on
 * every run). Armed in the finally, the timer still bounds a hung
 * drain/disconnect (the C13 contract) but can no longer kill a
 * slow-but-progressing op body.
 *
 * Source-grep is the right tool here (same rationale as
 * fix-wave-structural.test.ts): the rule is "this arming must stay at this
 * location". A behavioral test would need >10s of real wall-clock plus a
 * deliberately slow op handler in a spawned CLI — slow and flaky by
 * construction.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

describe('cli.ts — disconnect hard-deadline armed at teardown entry, not before the op body', () => {
  test('forceExitTimer setTimeout lives inside the finally, gated on the daemon guard, before the drain', () => {
    const src = readFileSync('src/cli.ts', 'utf8');

    const decl = src.indexOf('const DISCONNECT_HARD_DEADLINE_MS');
    expect(decl).toBeGreaterThan(-1);
    const tryIdx = src.indexOf('try {', decl);
    expect(tryIdx).toBeGreaterThan(-1);
    const finallyIdx = src.indexOf('} finally {', tryIdx);
    expect(finallyIdx).toBeGreaterThan(-1);
    const armIdx = src.indexOf('forceExitTimer = setTimeout', decl);
    expect(armIdx).toBeGreaterThan(-1);
    const drainIdx = src.indexOf('drainAllBackgroundWorkForCliExit', finallyIdx);
    expect(drainIdx).toBeGreaterThan(-1);

    // NO arming between the deadline declaration and the op-body try — a
    // pre-try timer kills slow-but-progressing op handlers mid-flight with
    // exit 0 and empty stdout. (`setTimeout(` matches only a call site; the
    // `ReturnType<typeof setTimeout>` type annotation stays allowed.)
    expect(src.slice(decl, tryIdx)).not.toContain('setTimeout(');

    // The arming sits AFTER the finally opens (teardown entry) and BEFORE the
    // drain + disconnect it exists to bound.
    expect(armIdx).toBeGreaterThan(finallyIdx);
    expect(armIdx).toBeLessThan(drainIdx);

    // Still gated on the daemon-survival guard so `serve` stays alive, and
    // still unref'd + cleared on clean teardown.
    expect(src.slice(finallyIdx, drainIdx)).toMatch(/if \(shouldForceExitAfterMain\(\)\)/);
    expect(src.slice(finallyIdx, drainIdx)).toContain('forceExitTimer.unref?.()');
    expect(src.slice(drainIdx)).toContain('if (forceExitTimer) clearTimeout(forceExitTimer)');
  });
});
