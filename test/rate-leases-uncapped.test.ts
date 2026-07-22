/**
 * v0.41 Bug 1: `unlimited` sentinel + POSITIVE_INFINITY semantics for the
 * Anthropic rate-lease cap. Closes the field-report bug where a default cap
 * of 8 starved a 10-concurrency batch on an Azure-Sweden endpoint that had
 * no upstream rate limit.
 *
 * Pure-function tests for `resolveLeaseCap()` cover the input matrix
 * (default, "unlimited", "none", positive int, NaN, zero, negative, typo).
 *
 * Integration tests against PGLite verify `acquireLease(..., Infinity)`
 * always returns acquired=true, still inserts the lease row (so TTL
 * pruning + crash recovery still work), and parallel acquires don't
 * deadlock on the advisory lock path.
 *
 * Codex pass-1 #7 caught the original `=0` + `NaN`-as-uncapped semantics
 * as dangerous (universal convention is "0 means disabled"); these tests
 * pin the corrected fail-loud behavior.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { acquireLease, renewLease } from '../src/core/minions/rate-leases.ts';
import { resolveLeaseCap } from '../src/core/minions/handlers/subagent.ts';

describe('resolveLeaseCap (pure)', () => {
  test('undefined returns default 32 (was 8 pre-v0.41)', () => {
    expect(resolveLeaseCap(undefined)).toBe(32);
  });

  test('"unlimited" returns POSITIVE_INFINITY', () => {
    expect(resolveLeaseCap('unlimited')).toBe(Number.POSITIVE_INFINITY);
  });

  test('"none" returns POSITIVE_INFINITY (alias)', () => {
    expect(resolveLeaseCap('none')).toBe(Number.POSITIVE_INFINITY);
  });

  test('positive integer returns that integer', () => {
    expect(resolveLeaseCap('50')).toBe(50);
    expect(resolveLeaseCap('1')).toBe(1);
  });

  test('positive float returns that float', () => {
    // Implementation note: SQL int conversion will truncate, but the parser
    // itself stays Number-typed. The `> 0` guard accepts floats.
    expect(resolveLeaseCap('2.5')).toBe(2.5);
  });

  test('"0" THROWS (universal "0 means disabled" convention; codex #7 fix)', () => {
    expect(() => resolveLeaseCap('0')).toThrow(/invalid/);
    expect(() => resolveLeaseCap('0')).toThrow(/unlimited/);
  });

  test('negative number THROWS', () => {
    expect(() => resolveLeaseCap('-5')).toThrow(/invalid/);
  });

  test('typo THROWS loudly with hint (NOT silent uncap)', () => {
    expect(() => resolveLeaseCap('trnety')).toThrow(/invalid/);
    expect(() => resolveLeaseCap('trnety')).toThrow(/unlimited/);
  });

  test('empty string THROWS', () => {
    // Number('') is 0, which fails the > 0 guard.
    expect(() => resolveLeaseCap('')).toThrow(/invalid/);
  });

  test('whitespace-only THROWS', () => {
    expect(() => resolveLeaseCap('   ')).toThrow(/invalid/);
  });

  test('hint mentions the invalid input verbatim for paste-back debugging', () => {
    try {
      resolveLeaseCap('garbage');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('"garbage"');
    }
  });
});

describe('acquireLease with cap=POSITIVE_INFINITY (integration)', () => {
  let engine: PGLiteEngine;
  let queue: MinionQueue;
  let owner: number;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    queue = new MinionQueue(engine);
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM subagent_rate_leases');
    await engine.executeRaw('DELETE FROM minion_jobs');
    const j = await queue.add('owner', {});
    owner = j.id;
  });

  test('always returns acquired=true regardless of activeCount', async () => {
    // Drive the lease table to 50 active leases under Infinity cap.
    for (let i = 0; i < 50; i++) {
      const j = await queue.add('owner', {});
      const r = await acquireLease(engine, 'anthropic:messages', j.id, Number.POSITIVE_INFINITY);
      expect(r.acquired).toBe(true);
      expect(r.maxConcurrent).toBe(Number.POSITIVE_INFINITY);
    }
    // 51st acquire still wins.
    const r = await acquireLease(engine, 'anthropic:messages', owner, Number.POSITIVE_INFINITY);
    expect(r.acquired).toBe(true);
  });

  test('lease row is still inserted (so TTL pruning + crash recovery still work)', async () => {
    const r = await acquireLease(engine, 'anthropic:messages', owner, Number.POSITIVE_INFINITY, {
      ttlMs: 10_000,
    });
    expect(r.acquired).toBe(true);
    expect(r.leaseId).toBeDefined();
    const rows = await engine.executeRaw<{ count: string }>(
      'SELECT count(*)::text AS count FROM subagent_rate_leases WHERE id = $1',
      [r.leaseId!],
    );
    expect(parseInt(rows[0]!.count, 10)).toBe(1);
  });

  test('renewLease still works under Infinity cap', async () => {
    const r = await acquireLease(engine, 'anthropic:messages', owner, Number.POSITIVE_INFINITY, {
      ttlMs: 10_000,
    });
    expect(r.acquired).toBe(true);
    const renewed = await renewLease(engine, r.leaseId!, 20_000);
    expect(renewed).toBe(true);
  });

  test('parallel acquires under Infinity cap do not deadlock on advisory lock', async () => {
    const jobs: Array<Promise<{ id: number }>> = [];
    for (let i = 0; i < 10; i++) jobs.push(queue.add('owner', {}));
    const owners = (await Promise.all(jobs)).map(j => j.id);
    // Fire 10 parallel acquires on the same key under Infinity cap.
    const acquires = await Promise.all(
      owners.map(o => acquireLease(engine, 'anthropic:messages', o, Number.POSITIVE_INFINITY)),
    );
    // All 10 should win.
    for (const r of acquires) {
      expect(r.acquired).toBe(true);
      expect(r.leaseId).toBeDefined();
    }
    // And the table should have 10 rows.
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM subagent_rate_leases WHERE key = 'anthropic:messages'`,
    );
    expect(parseInt(rows[0]!.count, 10)).toBe(10);
  });
});
