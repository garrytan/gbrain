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
  beginExternalDreamcycle,
  finalizeExternalDreamcycle,
} from '../src/commands/dreamcycle.ts';
import {
  ALL_PHASES,
  DREAMCYCLE_SOURCE_PHASES,
  GLOBAL_PHASES,
  NON_GLOBAL_PHASES,
  PHASE_SCOPE,
  LAST_GLOBAL_AT_KEY,
} from '../src/core/cycle.ts';
import {
  dispatchGlobalMaintenance,
  createGlobalMaintenanceSourceSnapshot,
  getJSTDaySlot,
  isGlobalMaintenanceStale,
  dispatchPerSource,
} from '../src/commands/autopilot-fanout.ts';
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

describe('dispatchGlobalMaintenance — single-flight gate', () => {
  function receiptSource(id = 'source-a', receiptAt = new Date().toISOString()) {
    return { id, name: id, local_path: '/tmp/brain', config: { last_source_cycle_at: receiptAt } };
  }

  function stubs(lastGlobalAt: string | null, authority: string | null = 'daily_finalizer', sources: any[] = [receiptSource()]) {
    const added: Array<{ name: string; data: any; opts: any; trusted: any }> = [];
    const engine = {
      kind: 'postgres' as const,
      getConfig: async (k: string) => {
        if (k === LAST_GLOBAL_AT_KEY) return lastGlobalAt;
        if (k === 'autopilot.global_maintenance.authority') return authority;
        return null;
      },
      listAllSources: async () => sources,
    } as unknown as BrainEngine;
    const queue = {
      add: async (name: string, data: unknown, opts: Record<string, unknown>, trusted: unknown) => {
        added.push({ name, data, opts, trusted }); return { id: 1 };
      },
    } as any;
    return { engine, queue, added };
  }

  test('stale (never run) with daily_finalizer authority → dispatches one global job with single-flight opts', async () => {
    const { engine, queue, added } = stubs(null, 'daily_finalizer');
    const r = await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 'caller-controlled-slot', timeoutMs: 1, jsonMode: true, emit: () => {} });
    expect(r.dispatched).toBe(true);
    expect(added.length).toBe(1);
    expect(added[0].name).toBe('autopilot-global-maintenance');
    expect(added[0].opts.idempotency_key).toBe(`dreamcycle:global:${getJSTDaySlot()}`);
    expect(added[0].opts.maxWaiting).toBe(1); // structural single-flight
    expect(added[0].data.phases).toEqual(['resolve_symbol_edges', 'embed', 'orphans']);
    expect(added[0].data.execution_authority).toBe('dreamcycle_global');
    expect(added[0].data.source_snapshot).toHaveLength(1);
    expect(added[0].data.source_snapshot_revision).toBeTypeOf('string');
    expect(added[0].trusted).toEqual({ allowProtectedSubmit: true });
  });

  test('external_dreamcycle / builtin / unknown / missing authority → fail closed 0 / deferred / unauthorized', async () => {
    for (const auth of ['external_dreamcycle', 'builtin', 'unknown', null]) {
      const { engine, queue, added } = stubs(null, auth, []);
      const r = await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 's1', timeoutMs: 1, jsonMode: true, emit: () => {} });
      expect(r.dispatched).toBe(false);
      expect(added.length).toBe(0);
      if (auth === 'external_dreamcycle') expect(r.reason).toBe('unauthorized');
      else expect(r.reason).toBe('deferred');
    }
  });

  test('fresh → does NOT dispatch', async () => {
    const { engine, queue, added } = stubs(new Date().toISOString(), 'daily_finalizer');
    const r = await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 's1', timeoutMs: 1, jsonMode: true, emit: () => {} });
    expect(r.dispatched).toBe(false);
    expect(added.length).toBe(0);
  });

  test('source listing failure or incomplete receipt fails closed with zero enqueue', async () => {
    const unavailable = {
      kind: 'postgres' as const,
      getConfig: async (k: string) => k === 'autopilot.global_maintenance.authority' ? 'daily_finalizer' : null,
      listAllSources: async () => { throw new Error('database unavailable'); },
    } as unknown as BrainEngine;
    const added: unknown[] = [];
    const queue = { add: async (...args: unknown[]) => { added.push(args); return { id: 1 }; } } as any;
    const unavailableResult = await dispatchGlobalMaintenance(unavailable, queue, { repoPath: '/tmp', timeoutMs: 1, jsonMode: true, emit: () => {} });
    expect(unavailableResult).toEqual({ dispatched: false, reason: 'global_deferred' });
    expect(added).toHaveLength(0);

    const incomplete = stubs(null, 'daily_finalizer', [{ id: 'source-a', name: 'source-a', local_path: '/tmp/brain', config: {} }]);
    const incompleteResult = await dispatchGlobalMaintenance(incomplete.engine, incomplete.queue, { repoPath: '/tmp', timeoutMs: 1, jsonMode: true, emit: () => {} });
    expect(incompleteResult).toEqual({ dispatched: false, reason: 'global_deferred' });
    expect(incomplete.added).toHaveLength(0);
  });
});

describe('dispatchPerSource — per-source jobs carry exact DreamCycle source phases', () => {
  test('each per-source job sets the fixed source receipt allowlist', async () => {
    const sources = [{ id: 'repo-a', name: 'a', config: {} }, { id: 'repo-b', name: 'b', config: {} }];
    const added: any[] = [];
    const engine = {
      kind: 'postgres' as const,
      listAllSources: async () => sources,
      getConfig: async () => null,
      executeRaw: async () => [],
    } as unknown as BrainEngine;
    const queue = { add: async (name: string, data: unknown, opts: unknown) => { added.push({ name, data, opts }); return { id: added.length }; } } as any;
    await dispatchPerSource(engine, queue, { repoPath: '/tmp', slot: 's', timeoutMs: 1, fanoutMax: 4, jsonMode: true, emit: () => {}, log: () => {} });
    expect(added.length).toBe(2);
    for (const j of added) {
      expect(j.data.phases).toEqual(DREAMCYCLE_SOURCE_PHASES);
      expect(j.data.phases).not.toContain('embed');
    }
  });
});

describe('autopilot-global-maintenance handler stamps last_global_at (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 30000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  async function captureHandlers() {
    const handlers = new Map<string, (job: any) => Promise<any>>();
    const fakeWorker = { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } };
    await registerBuiltinHandlers(fakeWorker as never, engine);
    return handlers;
  }

  async function makeVerifiedFinalizerData(phases: string[] = ['orphans', 'embed']) {
    const nowIso = new Date().toISOString();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ($1, $2, $3, '{}'::jsonb, false, NOW())
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, archived = false`,
      ['daily-source', 'daily-source', '/tmp/gbrain-daily-source'],
    );
    await engine.updateSourceConfig('daily-source', {
      last_source_cycle_at: nowIso,
      last_full_cycle_at: nowIso,
    });
    const sources = await engine.listAllSources({ localPathOnly: true });
    const snapshot = createGlobalMaintenanceSourceSnapshot(sources, getJSTDaySlot());
    if (!snapshot) throw new Error('test fixture did not create a valid source snapshot');
    return {
      phases,
      execution_authority: 'dreamcycle_global',
      source_snapshot: snapshot.sources,
      source_snapshot_revision: snapshot.revision,
      source_snapshot_jst_day: snapshot.jst_day,
    };
  }

  test('runs global phases (no source_id) and stamps autopilot.last_global_at on success', async () => {
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    expect(handler).toBeTruthy();

    const result = await handler!({ data: await makeVerifiedFinalizerData(), signal: undefined });
    // The cycle ran the requested global phases (DB-only on an empty brain).
    expect(result.report.phases.some((p: any) => p.phase === 'orphans')).toBe(true);
    expect(['ok', 'clean', 'partial']).toContain(result.report.status);
    // Freshness stamped so the dispatch gate backs off.
    const stamped = await engine.getConfig(LAST_GLOBAL_AT_KEY);
    expect(stamped).not.toBeNull();
    expect(Number.isFinite(new Date(stamped!).getTime())).toBe(true);
  });

  test('missing authority/snapshot and a changed receipt defer without global execution', async () => {
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    expect(handler).toBeTruthy();

    const missing = await handler!({ data: { phases: ['orphans'] }, signal: undefined });
    expect(missing.status).toBe('skipped');
    expect(missing.report.reason).toBe('global_deferred');

    const data = await makeVerifiedFinalizerData(['orphans']);
    await engine.updateSourceConfig('daily-source', { last_source_cycle_at: new Date(Date.now() + 60_000).toISOString() });
    const changed = await handler!({ data, signal: undefined });
    expect(changed.status).toBe('skipped');
    expect(changed.report.reason).toBe('global_deferred');
  });

  test('external DreamCycle finalizer revalidates its begin batch at handler claim time', async () => {
    // resetPgliteState intentionally truncates user config; MinionQueue's
    // existing schema guard reads this normal runtime version key.
    await engine.setConfig('version', '123');
    await engine.setConfig('autopilot.global_maintenance.authority', 'external_dreamcycle');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ($1, $2, $3, '{}'::jsonb, false, NOW())`,
      ['external-source', 'external-source', '/tmp/gbrain-external-source'],
    );
    const queue = new MinionQueue(engine);
    const begun = await beginExternalDreamcycle(engine, queue);
    expect(begun.outcome).toBe('begun');
    await engine.updateSourceConfig('external-source', {
      last_source_cycle_at: new Date(Date.now() + 1_000).toISOString(),
      last_full_cycle_at: new Date(Date.now() + 1_000).toISOString(),
    });
    const sealed = await finalizeExternalDreamcycle(engine, queue);
    expect(sealed.outcome).toBe('sealed');
    if (sealed.outcome !== 'sealed') throw new Error('fixture did not seal external finalizer');
    const job = await queue.getJob(sealed.global_job_id);
    expect(job).not.toBeNull();

    // The queued payload was valid when sealed, but the handler must refuse
    // it when today's external authority is no longer active.
    await engine.setConfig('autopilot.global_maintenance.authority', 'daily_finalizer');
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    const result = await handler!({ data: job!.data, signal: undefined });
    expect(result.status).toBe('skipped');
    expect(result.report).toMatchObject({
      reason: 'global_deferred',
      detail: 'external_batch_mismatch_or_incomplete',
    });
  });

  test('raw invalid global phase is rejected rather than filtered to a default', async () => {
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    expect(handler).toBeTruthy();
    await expect(handler!({ data: await makeVerifiedFinalizerData(['purge']), signal: undefined }))
      .rejects.toThrow('unsupported finalizer phase(s): purge');
  });
});
