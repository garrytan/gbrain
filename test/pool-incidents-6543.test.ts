/**
 * #6543 (A4, A6): the stuck warn line names why the watchdog fired
 * (`reason=age|idle`) and the statement's own budget; reconnects of retired
 * connections are counted (`recovered`, `recovery_failed`) and reach
 * `poolHealthSnapshot`; serve's incidents land in the pool-recovery audit, so
 * `doctor --only pool_reap_health` sees them.
 * Regression that fails it on master: no `reason=`, no recovery counters, no
 * audit sink, and the doctor check ignores driver incidents.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatRecoveryFailedWarning, formatStuckConnectionWarning, PoolIncidentCounter, setPoolIncidentAudit } from '../src/core/pool-gauge.ts';
import { logPoolRecovery, readRecentPoolRecoveries } from '../src/core/audit/pool-recovery-audit.ts';
import { computePoolReapHealthCheck } from '../src/commands/doctor.ts';
import { driverPoolStats, poolHealthSnapshot } from '../src/core/postgres-engine/pool-stats.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg = { kind: 'postgres' } as any;
let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-incidents-6543-')); });
afterEach(() => {
  setPoolIncidentAudit(null);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('warn lines', () => {
  test('pg_connection_stuck says reason=age with the statement budget when bytes kept arriving, reason=idle otherwise', () => {
    const age = formatStuckConnectionWarning('read', { age_ms: 8_012.4, queued: 0, statement: "SELECT g, repeat('x', 9000) FROM generate_series(1, 8) g", reason: 'age', budget_ms: 3000 });
    expect(age).toContain('[gbrain] warn code=pg_connection_stuck pool=read age_ms=8012 queued=0 sql=SELECT_generate_series reason=age budget_ms=3000');
    expect(age).toContain('kept receiving data past its in-flight budget');
    expect(age).not.toContain('repeat(');
    const idle = formatStuckConnectionWarning('direct', { age_ms: 5000, queued: 1, statement: 'SELECT pg_sleep(5)', reason: 'idle', budget_ms: 4000 });
    expect(idle).toContain('reason=idle budget_ms=4000');
    expect(idle).toContain('with nothing coming back from the server');
    expect(formatStuckConnectionWarning('read', { age_ms: 1, queued: 0, statement: 'SELECT 1' })).toContain('reason=idle cause=');
  });

  test('pg_connection_recovery_failed names the pool, connection, cause and a safe error code only', () => {
    const line = formatRecoveryFailedWarning('read', { connection: 3, cause: 'stuck', code: 'ECONNREFUSED' });
    expect(line).toContain('[gbrain] warn code=pg_connection_recovery_failed pool=read connection=3 cause=stuck error=ECONNREFUSED');
    expect(line).toContain('docs=docs/ENGINES.md#pg-connection-recovery-failed');
    expect(formatRecoveryFailedWarning('direct', { connection: 1, cause: 'closed', code: 'password for postgres://u:p@h' })).toContain('error=CONNECTION_ERROR');
  });
});

describe('PoolIncidentCounter recovery counters and the audit sink', () => {
  test('driver hooks count recovered and recovery_failed; serve writes stuck, desync and recovery events to the audit', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        setPoolIncidentAudit((kind, detail) => logPoolRecovery(kind, undefined, detail));
        const counter = new PoolIncidentCounter();
        const hooks = counter.hooks('read');
        hooks.onstuck({ age_ms: 4000, queued: 0, statement: 'SELECT * FROM pages', reason: 'age', budget_ms: 3000 });
        hooks.ondesync({ message: 'DataRow', connection: 2, statement: 'SELECT 1' });
        hooks.onrecovered({ connection: 1, cause: 'stuck' });
        hooks.onrecovered({ connection: 2, cause: 'desync' });
        expect(counter.stuckCount).toBe(1);
        expect(counter.desyncCount).toBe(1);
        expect(counter.recoveredCount).toBe(2);
        expect(counter.recoveryFailedCount).toBe(0);
        const recent = readRecentPoolRecoveries(1);
        expect(recent.stuck).toBe(1);
        expect(recent.desyncs).toBe(1);
        expect(recent.connection_recoveries).toBe(2);
        expect(recent.events.find(e => e.kind === 'connection_stuck')?.detail).toContain('reason=age');
        const warnCheck = await computePoolReapHealthCheck(pg);
        expect(warnCheck?.status).toBe('warn');
        expect(warnCheck?.message).toContain('retired 1 stuck and 1 desynced');
        expect(warnCheck?.details?.connection_recoveries).toBe(2);

        hooks.onrecoveryfailed({ connection: 1, cause: 'closed', code: 'ECONNREFUSED' });
        expect(counter.recoveryFailedCount).toBe(1);
        expect(warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('pg_connection_recovery_failed'))).toHaveLength(1);
        const failCheck = await computePoolReapHealthCheck(pg);
        expect(failCheck?.status).toBe('fail');
        expect(failCheck?.message).toContain('could not reconnect a retired connection 1×');
      } finally {
        warn.mockRestore();
      }
    });
  });

  test('without a sink (CLI processes) nothing is written to the audit', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        new PoolIncidentCounter().hooks('direct').onstuck({ age_ms: 4000, queued: 0, statement: 'SELECT 1', reason: 'idle', budget_ms: 3000 });
        expect(readRecentPoolRecoveries(1).events).toEqual([]);
        expect(await computePoolReapHealthCheck(pg)).toBeNull();
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe('poolHealthSnapshot', () => {
  test('carries recovered, recovery_failed and the driver per-statement over-budget age', () => {
    const engine = {
      getPoolDiagnostics: () => ({
        poisonedDiscards: 0, stuckDiscards: 1, buildFailures: 0, desyncDiscards: 0, recovered: 1, recoveryFailed: 2,
        pool: driverPoolStats({ pool: { max: 4, open: 4, busy: 1, full: 0, reserved: 0, connecting: 0, closed: 0, ended: 0, queued: 0, inflight_oldest_ms: 900_000, completed: 3, inflight_over_budget_ms: 0 } }),
      }),
    } as unknown as BrainEngine;
    expect(poolHealthSnapshot(engine)).toMatchObject({ inflight_oldest_ms: 900_000, inflight_over_budget_ms: 0, stuck_discards: 1, recovered: 1, recovery_failed: 2 });
  });
});
