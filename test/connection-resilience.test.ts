import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { surfaceFileSource, surfaceSource } from './helpers/source-surface.ts';

// ─────────────────────────────────────────────────────────────────
// Eng-review D3 regression guards — executeRaw retry wrapper dropped
// ─────────────────────────────────────────────────────────────────
//
// The original #406 wrapped PostgresEngine.executeRaw in a per-call
// try/catch that retried on connection errors. Eng-review D3 dropped
// that wrapper as unsound (regex idempotence boundary doesn't hold
// for writable CTEs or side-effecting SELECTs). Recovery now happens
// at the supervisor level via the 3-strikes-then-reconnect path.
//
// These guards prevent reintroduction of the per-call retry without
// a typed-idempotency boundary.

describe('Eng-review D3 — executeRaw has no per-call retry wrapper', () => {
  it('PostgresEngine.executeRaw is a single-statement passthrough (no try/catch on connection errors)', () => {
    const src = surfaceFileSource('postgres-engine', 'src/core/postgres-engine.ts');

    // v0.42.24.0 (eng-review D1): the cancellation plumbing shared by executeRaw
    // and executeRawDirect was extracted into a private `runUnsafe(conn, ...)`
    // helper. executeRaw / executeRawDirect now pick a connection and delegate;
    // the single `conn.unsafe(` call lives in runUnsafe. The D3 invariant (no
    // per-call retry wrapper) is unchanged — it just spans the delegate now, so
    // this guard checks both the public methods AND the shared helper.

    // Find executeRaw in the class (not the helper inside withReservedConnection).
    // v0.41.18.0 (T5/A20): signature extended with optional `opts?: { signal?: AbortSignal }`.
    const fnMatch = src.match(/async executeRaw<T = Record<string, unknown>>\(\s*sql: string,\s*params\?: unknown\[\][^)]*\):\s*Promise<T\[\]>\s*\{([\s\S]*?)\n  \}/);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![1];

    // executeRaw must not retry: no reconnect, no inline re-issue, and it must
    // delegate to runUnsafe rather than re-implementing the query path.
    expect(body).not.toContain('this.reconnect()');
    expect(body).toContain('this.runUnsafe');
    expect((body.match(/conn\.unsafe\(/g) || []).length).toBe(0);

    // executeRawDirect (the Minion lock hot-path sibling) routes to the direct
    // session pool but must NOT introduce a retry wrapper either — same delegate.
    const directMatch = src.match(/async executeRawDirect<T = Record<string, unknown>>\(\s*sql: string,\s*params\?: unknown\[\][^)]*\):\s*Promise<T\[\]>\s*\{([\s\S]*?)\n  \}/);
    expect(directMatch).not.toBeNull();
    const directBody = directMatch![1];
    expect(directBody).not.toContain('this.reconnect()');
    expect(directBody).toContain('this.runUnsafe');
    expect((directBody.match(/conn\.unsafe\(/g) || []).length).toBe(0);

    // The shared helper issues conn.unsafe EXACTLY ONCE (no retry re-issue) and
    // never reconnects. Its try/catch is ONLY the AbortSignal cancellation
    // swallow (v0.41.18.0 A20), NOT a connection retry.
    const helperMatch = src.match(/private runUnsafe<T>\(\s*conn:[^)]*\):\s*Promise<T\[\]>\s*\{([\s\S]*?)\n  \}/);
    expect(helperMatch).not.toBeNull();
    const helperBody = helperMatch![1];
    expect(helperBody).not.toContain('this.reconnect()');
    expect((helperBody.match(/conn\.unsafe\(/g) || []).length).toBe(1);
    if (helperBody.includes('catch')) {
      // If catch exists, it must be the cancel-swallow shape, NOT a retry shape.
      expect(helperBody).not.toMatch(/catch[^{]*\{[\s\S]*?conn\.unsafe/);
      expect(helperBody).not.toMatch(/catch[^{]*\{[\s\S]*?setTimeout/);
    }
  });

  it('PostgresEngine.reconnect() still exists for supervisor-driven recovery', () => {
    const src = surfaceSource('postgres-engine');
    // v0.42.10.0 (#1685 GAP B): reconnect() gained an optional ctx param so it
    // can classify the triggering error for the pool-recovery audit. Match the
    // prefix so both `reconnect()` and `reconnect(ctx?)` satisfy the contract.
    expect(src).toContain('async reconnect(');
    // #1593 build-then-swap: reconnect() no longer disconnect()-then-connect()s
    // on the instance-pool path (that nulled _sql, so a connect() failure during
    // a transient blip left the engine permanently dead → worker respawn loop).
    // It now snapshots the live pool, builds a fresh one, and ends the OLD pool
    // only once the new one validates — restoring it on failure. Assert the
    // old-pool teardown, which is the recovery contract this test guards.
    expect(src).toContain('await oldSql.end(');
  });

  it('Supervisor still has the 3-strikes-then-reconnect path', () => {
    const src = readFileSync(resolve('src/core/minions/supervisor.ts'), 'utf-8');
    expect(src).toContain('consecutiveHealthFailures');
    // #2034: reconnect() is now a first-class BrainEngine method, so the
    // supervisor calls it directly after 3 consecutive failures (the prior
    // `(engine as unknown as { reconnect(): Promise<void> })` cast was removed).
    expect(src).toContain('this.engine.reconnect(');
    expect(src).toContain('this.consecutiveHealthFailures >= 3');
  });
});
