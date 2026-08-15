/**
 * #2194 fix #1 (codex #9 / D5): resolveEffectiveFanoutMax clamps the per-tick
 * fan-out to the worker's effective concurrency (max(1, concurrency-1),
 * reserving ≥1 slot) — but ONLY when a LIVE supervisor holds the queue lock.
 * A stale `started` audit row must not shrink throughput for a supervisor that
 * isn't running that config, so with no live holder the clamp is skipped and
 * the unclamped base is used.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { supervisorLockId, SUPERVISOR_LOCK_TTL_MIN } from '../src/core/minions/supervisor.ts';
import { computeSupervisorAuditFilename } from '../src/core/minions/handlers/supervisor-audit.ts';
import { resolveEffectiveFanoutMax } from '../src/commands/autopilot-fanout.ts';

let engine: PGLiteEngine;
let auditDir: string;
const prevAuditDir = process.env.GBRAIN_AUDIT_DIR;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-clamp-'));
  process.env.GBRAIN_AUDIT_DIR = auditDir;
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-supervisor:%'`);
  // base fan-out: override to 8 so the clamp's effect is visible on PGLite
  // (whose natural default is 1). The clamp logic is engine-agnostic.
  await engine.setConfig('autopilot.fanout_max_per_tick', '8');
  await engine.setConfig('autopilot.fanout_clamp_to_concurrency', 'true');
});

afterEach(() => {
  if (prevAuditDir === undefined) delete process.env.GBRAIN_AUDIT_DIR;
  else process.env.GBRAIN_AUDIT_DIR = prevAuditDir;
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function writeStarted(concurrency: number): void {
  const file = join(auditDir, computeSupervisorAuditFilename());
  writeFileSync(file, JSON.stringify({
    event: 'started', ts: new Date().toISOString(), supervisor_pid: 4242,
    queue: 'default', concurrency,
  }) + '\n', 'utf8');
}

describe('resolveEffectiveFanoutMax — clamp gated on live supervisor (#2194/codex #9)', () => {
  test('NO live holder → no clamp (stale audit row cannot shrink throughput)', async () => {
    writeStarted(3); // audit says concurrency 3, but no live lock holder
    const n = await resolveEffectiveFanoutMax(engine, 'default');
    expect(n).toBe(8); // unclamped base
  });

  test('live holder + concurrency 3 → clamp to max(1, 3-1) = 2', async () => {
    writeStarted(3);
    const holder = await tryAcquireDbLock(engine, supervisorLockId('default'), SUPERVISOR_LOCK_TTL_MIN);
    expect(holder).not.toBeNull();
    try {
      const n = await resolveEffectiveFanoutMax(engine, 'default');
      expect(n).toBe(2);
    } finally {
      await holder!.release();
    }
  });

  test('live holder but clamp disabled → unclamped base', async () => {
    await engine.setConfig('autopilot.fanout_clamp_to_concurrency', 'false');
    writeStarted(3);
    const holder = await tryAcquireDbLock(engine, supervisorLockId('default'), SUPERVISOR_LOCK_TTL_MIN);
    try {
      const n = await resolveEffectiveFanoutMax(engine, 'default');
      expect(n).toBe(8);
    } finally {
      await holder!.release();
    }
  });

  test('live holder + concurrency 1 → floor at 1 (never below 1)', async () => {
    writeStarted(1);
    const holder = await tryAcquireDbLock(engine, supervisorLockId('default'), SUPERVISOR_LOCK_TTL_MIN);
    try {
      const n = await resolveEffectiveFanoutMax(engine, 'default');
      expect(n).toBe(1);
    } finally {
      await holder!.release();
    }
  });

  test('live holder but no started event (concurrency unknown) → no clamp', async () => {
    // lock row exists but audit has no concurrency → fall back to base.
    const holder = await tryAcquireDbLock(engine, supervisorLockId('default'), SUPERVISOR_LOCK_TTL_MIN);
    try {
      const n = await resolveEffectiveFanoutMax(engine, 'default');
      expect(n).toBe(8);
    } finally {
      await holder!.release();
    }
  });
});
