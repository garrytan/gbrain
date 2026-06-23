/**
 * #2194 fix #3 / #2227 bug #3 — the cycle split.
 *
 * Per-source autopilot cycles run ONLY source-scoped (+ mixed) phases; the
 * brain-wide `global` phases run ONCE in a separate autopilot-global-maintenance
 * job. This replaces the rejected skip-and-stamp-fresh design (codex #1/#2): the
 * split makes single-flight structural (one global job, not N concurrent embeds)
 * and never marks a source "fresh" for global work it didn't do. These tests pin
 * the phase partition, the dispatch gate, the per-source phase set, and the
 * global handler stamping autopilot.last_global_at.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  ALL_PHASES,
  GLOBAL_PHASES,
  NON_GLOBAL_PHASES,
  PHASE_SCOPE,
  LAST_GLOBAL_AT_KEY,
} from '../src/core/cycle.ts';
import {
  dispatchGlobalMaintenance,
  isGlobalMaintenanceDue,
  isGlobalMaintenanceStale,
  dispatchPerSource,
} from '../src/commands/autopilot-fanout.ts';
import { decideAutopilotDispatch } from '../src/commands/autopilot.ts';
import { PROTECTED_JOB_NAMES } from '../src/core/minions/protected-names.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('cycle phase partition (#2194 fix #3)', () => {
  test('GLOBAL ∪ NON_GLOBAL == ALL_PHASES, no overlap', () => {
    const union = new Set([...GLOBAL_PHASES, ...NON_GLOBAL_PHASES]);
    expect(union.size).toBe(ALL_PHASES.length);
    for (const p of ALL_PHASES) expect(union.has(p)).toBe(true);
    // No phase in both.
    const overlap = GLOBAL_PHASES.filter((p) => NON_GLOBAL_PHASES.includes(p));
    expect(overlap).toEqual([]);
  });

  test('every GLOBAL phase is PHASE_SCOPE==="global"; embed is global, lint is not', () => {
    for (const p of GLOBAL_PHASES) expect(PHASE_SCOPE[p]).toBe('global');
    expect(GLOBAL_PHASES).toContain('embed');
    expect(GLOBAL_PHASES).toContain('orphans');
    expect(GLOBAL_PHASES).toContain('purge');
    expect(NON_GLOBAL_PHASES).toContain('lint');
    expect(NON_GLOBAL_PHASES).toContain('sync');
    expect(NON_GLOBAL_PHASES).not.toContain('embed');
  });
});

describe('isGlobalMaintenanceStale', () => {
  const now = Date.UTC(2026, 5, 16, 12, 0, 0);
  test('null/unparseable → stale (must run)', () => {
    expect(isGlobalMaintenanceStale(null, now)).toBe(true);
    expect(isGlobalMaintenanceStale('not-a-date', now)).toBe(true);
  });
  test('older than floor → stale; within floor → fresh', () => {
    expect(isGlobalMaintenanceStale(new Date(now - 61 * 60_000).toISOString(), now, 60)).toBe(true);
    expect(isGlobalMaintenanceStale(new Date(now - 10 * 60_000).toISOString(), now, 60)).toBe(false);
  });
});

describe('autopilot global-maintenance throttle split', () => {
  test('stale global maintenance pierces healthy sleep without opening per-source fanout', () => {
    const decision = decideAutopilotDispatch({
      score: 99,
      planLength: 0,
      estTotal: 0,
      minutesSinceLastFull: 10,
      globalMaintenanceDue: true,
      fullCycleFloorMin: 60,
    });

    expect(decision.shouldSleep).toBe(false);
    expect(decision.shouldFullCycle).toBe(false);
    expect(decision.shouldDispatchGlobalMaintenance).toBe(true);
  });

  test('healthy empty plan still sleeps when per-source and global gates are fresh', () => {
    const decision = decideAutopilotDispatch({
      score: 99,
      planLength: 0,
      estTotal: 0,
      minutesSinceLastFull: 10,
      globalMaintenanceDue: false,
      fullCycleFloorMin: 60,
    });

    expect(decision.shouldSleep).toBe(true);
    expect(decision.shouldFullCycle).toBe(false);
    expect(decision.shouldDispatchGlobalMaintenance).toBe(false);
  });

  test('global due reads autopilot.last_global_at with the configured floor', async () => {
    const now = Date.UTC(2026, 5, 16, 12, 0, 0);
    const engine = {
      kind: 'postgres' as const,
      getConfig: async (k: string) => {
        if (k === 'autopilot.global_floor_min') return '20';
        if (k === LAST_GLOBAL_AT_KEY) return new Date(now - 30 * 60_000).toISOString();
        return null;
      },
    } as unknown as BrainEngine;

    expect(await isGlobalMaintenanceDue(engine, now)).toBe(true);
  });
});

describe('dispatchGlobalMaintenance — single-flight gate', () => {
  test('global maintenance job name is protected from remote submitters', () => {
    expect(PROTECTED_JOB_NAMES.has('autopilot-global-maintenance')).toBe(true);
  });

  function stubs(lastGlobalAt: string | null) {
    const added: Array<{ name: string; data: any; opts: any }> = [];
    const engine = {
      kind: 'postgres' as const,
      getConfig: async (k: string) => (k === LAST_GLOBAL_AT_KEY ? lastGlobalAt : null),
      executeRaw: async () => [],
    } as unknown as BrainEngine;
    const queue = {
      add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
        added.push({ name, data, opts }); return { id: 1 };
      },
    } as any;
    return { engine, queue, added };
  }

  test('stale (never run) → dispatches one global job with single-flight opts', async () => {
    const { engine, queue, added } = stubs(null);
    const r = await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 's1', timeoutMs: 1, jsonMode: true, emit: () => {} });
    expect(r.dispatched).toBe(true);
    expect(added.length).toBe(1);
    expect(added[0].name).toBe('autopilot-global-maintenance');
    expect(added[0].opts.idempotency_key).toBe('autopilot-global:s1');
    expect(added[0].opts.maxWaiting).toBe(1); // structural single-flight
    expect(added[0].data.phases).toEqual(GLOBAL_PHASES);
  });

  test('fresh → does NOT dispatch', async () => {
    const { engine, queue, added } = stubs(new Date().toISOString());
    const r = await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 's1', timeoutMs: 1, jsonMode: true, emit: () => {} });
    expect(r.dispatched).toBe(false);
    expect(added.length).toBe(0);
  });
});

describe('dispatchPerSource — per-source jobs carry NON_GLOBAL phases (no embed)', () => {
  test('stale global maintenance defers while source jobs are dispatched', async () => {
    const sources = [{ id: 'repo-a', name: 'a', config: {} }, { id: 'repo-b', name: 'b', config: {} }];
    const added: any[] = [];
    const engine = {
      kind: 'postgres' as const,
      listAllSources: async () => sources,
      getConfig: async () => null,
      executeRaw: async () => [],
    } as unknown as BrainEngine;
    const queue = { add: async (name: string, data: unknown, opts: unknown) => { added.push({ name, data, opts }); return { id: added.length }; } } as any;
    const result = await dispatchPerSource(engine, queue, { repoPath: '/tmp', slot: 's', timeoutMs: 1, fanoutMax: 4, jsonMode: true, emit: () => {}, log: () => {}, isSourceSyncable: () => true });
    expect(result.global_maintenance).toEqual({ dispatched: false, reason: 'deferred' });
    expect(added.length).toBe(2);
    const sourceJobs = added.filter((j) => j.name === 'autopilot-cycle');
    expect(sourceJobs.length).toBe(2);
    for (const j of sourceJobs) {
      expect(j.data.phases).toEqual(NON_GLOBAL_PHASES);
      expect(j.data.phases).not.toContain('embed');
      expect(j.opts.parent_job_id).toBeUndefined();
    }
  });

  test('fanout cap defers global maintenance until all stale sources can run', async () => {
    const sources = [{ id: 'repo-a', name: 'a', config: {} }, { id: 'repo-b', name: 'b', config: {} }];
    const added: any[] = [];
    const engine = {
      kind: 'postgres' as const,
      listAllSources: async () => sources,
      getConfig: async () => null,
      executeRaw: async () => [],
    } as unknown as BrainEngine;
    const queue = { add: async (name: string, data: unknown, opts: unknown) => { added.push({ name, data, opts }); return { id: added.length }; } } as any;
    const result = await dispatchPerSource(engine, queue, { repoPath: '/tmp', slot: 's', timeoutMs: 1, fanoutMax: 1, jsonMode: true, emit: () => {}, log: () => {}, isSourceSyncable: () => true });
    expect(result.dispatched.length).toBe(1);
    expect(result.skipped_cap.length).toBe(1);
    expect(result.global_maintenance).toEqual({ dispatched: false, reason: 'deferred' });
    expect(added.map((j) => j.name)).toEqual(['autopilot-cycle']);
  });
});

describe('autopilot-global-maintenance handler stamps last_global_at (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 30000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  test('real queue dispatches source cycles first and defers global maintenance', async () => {
    await engine.setConfig('version', '119');
    await engine.setConfig(LAST_GLOBAL_AT_KEY, 'not-a-date');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('repo-a', 'repo-a', '/tmp/repo-a', '{}'::jsonb)`,
    );
    const queue = new MinionQueue(engine);
    const result = await dispatchPerSource(engine, queue, {
      repoPath: '/tmp',
      slot: 's',
      timeoutMs: 1,
      fanoutMax: 4,
      jsonMode: true,
      emit: () => {},
      log: () => {},
      isSourceSyncable: () => true,
    });
    expect(result.global_maintenance).toEqual({ dispatched: false, reason: 'deferred' });

    const rows = await engine.executeRaw<{ name: string; status: string; parent_job_id: number | null }>(
      `SELECT name, status, parent_job_id FROM minion_jobs ORDER BY id`,
    );
    expect(rows).toEqual([
      { name: 'autopilot-cycle', status: 'waiting', parent_job_id: null },
    ]);
  });

  test('dispatch reuses a live global maintenance job instead of queuing a duplicate', async () => {
    await engine.setConfig('version', '119');
    await engine.setConfig(LAST_GLOBAL_AT_KEY, 'not-a-date');
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, data)
       VALUES ('autopilot-global-maintenance', 'default', 'active', '{}'::jsonb)`,
    );
    const existing = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE name = 'autopilot-global-maintenance'`,
    );
    const queue = new MinionQueue(engine);
    const result = await dispatchGlobalMaintenance(engine, queue, {
      repoPath: '/tmp',
      slot: 'next-slot',
      timeoutMs: 1,
      jsonMode: true,
      emit: () => {},
    });
    const rows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE name = 'autopilot-global-maintenance' ORDER BY id`,
    );
    expect(result.dispatched).toBe(true);
    expect(result.job_id).toBe(existing[0]!.id);
    expect(rows.map((r) => r.id)).toEqual([existing[0]!.id]);
  });

  test('per-source jobs defer while global maintenance is already active', async () => {
    await engine.setConfig('version', '119');
    await engine.setConfig(LAST_GLOBAL_AT_KEY, 'not-a-date');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('repo-a', 'repo-a', '/tmp/repo-a', '{}'::jsonb)`,
    );
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, data)
       VALUES ('autopilot-global-maintenance', 'default', 'active', '{}'::jsonb)`,
    );

    const queue = new MinionQueue(engine);
    const result = await dispatchPerSource(engine, queue, {
      repoPath: '/tmp',
      slot: 's',
      timeoutMs: 1,
      fanoutMax: 4,
      jsonMode: true,
      emit: () => {},
      log: () => {},
      isSourceSyncable: () => true,
    });
    expect(result.dispatched).toEqual([]);
    expect(result.skipped_active).toEqual(['repo-a']);

    const rows = await engine.executeRaw<{ name: string; status: string; parent_job_id: number | null }>(
      `SELECT name, status, parent_job_id FROM minion_jobs ORDER BY id`,
    );
    expect(rows).toEqual([
      { name: 'autopilot-global-maintenance', status: 'active', parent_job_id: null },
    ]);
  });

  test('source fanout defers while global maintenance is already waiting', async () => {
    await engine.setConfig('version', '119');
    await engine.setConfig(LAST_GLOBAL_AT_KEY, 'not-a-date');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('repo-a', 'repo-a', '/tmp/repo-a', '{}'::jsonb)`,
    );
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, data)
       VALUES ('autopilot-global-maintenance', 'default', 'waiting', '{}'::jsonb)`,
    );

    const queue = new MinionQueue(engine);
    const result = await dispatchPerSource(engine, queue, {
      repoPath: '/tmp',
      slot: 's',
      timeoutMs: 1,
      fanoutMax: 4,
      jsonMode: true,
      emit: () => {},
      log: () => {},
      isSourceSyncable: () => true,
    });

    expect(result.global_maintenance.dispatched).toBe(true);
    expect(result.dispatched).toEqual([]);
    expect(result.skipped_active).toEqual(['repo-a']);
    const rows = await engine.executeRaw<{ name: string; status: string; parent_job_id: number | null }>(
      `SELECT name, status, parent_job_id FROM minion_jobs ORDER BY id`,
    );
    expect(rows).toEqual([
      { name: 'autopilot-global-maintenance', status: 'waiting', parent_job_id: null },
    ]);
  });

  test('source fanout defers while orphaned paused global maintenance exists', async () => {
    await engine.setConfig('version', '119');
    await engine.setConfig(LAST_GLOBAL_AT_KEY, 'not-a-date');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('repo-a', 'repo-a', '/tmp/repo-a', '{}'::jsonb)`,
    );
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, data)
       VALUES ('autopilot-global-maintenance', 'default', 'paused', '{}'::jsonb)`,
    );

    const queue = new MinionQueue(engine);
    const result = await dispatchPerSource(engine, queue, {
      repoPath: '/tmp',
      slot: 's',
      timeoutMs: 1,
      fanoutMax: 4,
      jsonMode: true,
      emit: () => {},
      log: () => {},
      isSourceSyncable: () => true,
    });

    expect(result.global_maintenance.dispatched).toBe(true);
    expect(result.dispatched).toEqual([]);
    expect(result.skipped_active).toEqual(['repo-a']);
    const rows = await engine.executeRaw<{ name: string; status: string; parent_job_id: number | null }>(
      `SELECT name, status, parent_job_id FROM minion_jobs ORDER BY id`,
    );
    expect(rows).toEqual([
      { name: 'autopilot-global-maintenance', status: 'waiting', parent_job_id: null },
    ]);
  });

  async function captureHandlers() {
    const handlers = new Map<string, (job: any) => Promise<any>>();
    const fakeWorker = { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } };
    await registerBuiltinHandlers(fakeWorker as never, engine);
    return handlers;
  }

  test('runs global phases (no source_id) and stamps autopilot.last_global_at on success', async () => {
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    expect(handler).toBeTruthy();

    const result = await handler!({ data: { phases: ['orphans'] }, signal: undefined });
    // The cycle ran the requested global phases (DB-only on an empty brain).
    expect(result.report.phases.some((p: any) => p.phase === 'orphans')).toBe(true);
    expect(['ok', 'clean']).toContain(result.report.status);
    // Freshness stamped so the dispatch gate backs off.
    const stamped = await engine.getConfig(LAST_GLOBAL_AT_KEY);
    expect(stamped).not.toBeNull();
    expect(Number.isFinite(new Date(stamped!).getTime())).toBe(true);
  });

  test('partial global maintenance does not stamp autopilot.last_global_at', async () => {
    await engine.unsetConfig(LAST_GLOBAL_AT_KEY);
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    expect(handler).toBeTruthy();

    const result = await handler!({
      data: { repoPath: '/definitely-does-not-exist-for-global-maintenance-test', phases: ['lint'] },
      signal: { aborted: false },
    });
    expect(['partial', 'failed']).toContain(result.report.status);
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
  });
});
