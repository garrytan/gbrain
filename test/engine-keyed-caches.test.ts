/**
 * Per-brain caches keyed by engine (GBRA-283 Wave A). A process with several
 * engines (mounted brains) must read each brain's own settings and write each
 * brain's telemetry into its own database. Every case runs the second engine
 * after the first one warmed the cache, the order that leaked on master.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';
import { engineKey } from '../src/core/engine-key.ts';
import { registerEngineView } from '../src/core/persistence/switches.ts';
import { deadlineBoundEngine } from '../src/core/statement-deadline.ts';
import { recordSearchTelemetry, awaitPendingTelemetryFlush, _resetTelemetryWriterForTest, _telemetryWriterCountForTest } from '../src/core/search/telemetry.ts';
import { bumpLastRetrievedAt, awaitPendingLastRetrievedWrites, _resetTrackRetrievalCacheForTests } from '../src/core/last-retrieved.ts';
import { resolveAdmissionPolicy, _resetAdmissionCacheForTest } from '../src/core/minions/admission.ts';
import { resolveStrictParamsMode, resetStrictParamsModeCache } from '../src/mcp/validate-params.ts';
import { readPublicationCeilingMs, _resetPublicationCeilingForTest } from '../src/core/persistence/publication-deadline.ts';
import { guardAutopilotEngine } from '../src/commands/autopilot.ts';
import type { OwnerProcessingState } from '../src/core/minions/processing-state.ts';
import { batchSharedReads } from '../src/core/persistence/page-mutations.ts';
import { preparationReads } from '../src/core/persistence/group-publish.ts';
import { createDegradedEngine, DegradedRecoveredRetryError } from '../src/core/degraded-engine.ts';
import { bindPublicationTimeouts, publicationIdleTimeoutMs } from '../src/core/persistence/publication-deadline.ts';
import { capacityNotices, __resetCapacityNoticesForTests, type CapacitySnapshot } from '../src/core/persistence/capacity-snapshot.ts';

let brainA: PGLiteEngine;
let brainB: PGLiteEngine;

beforeAll(async () => {
  brainA = new PGLiteEngine();
  await brainA.connect({});
  await brainA.initSchema();
  brainB = new PGLiteEngine();
  await brainB.connect({});
  await brainB.initSchema();
});

afterAll(async () => {
  _resetTelemetryWriterForTest();
  await brainA.disconnect();
  await brainB.disconnect();
});

beforeEach(() => {
  _resetTelemetryWriterForTest();
  _resetTrackRetrievalCacheForTests();
  _resetAdmissionCacheForTest();
  resetStrictParamsModeCache();
  _resetPublicationCeilingForTest();
  __resetCapacityNoticesForTests();
});

/** A stand-in engine whose config reads answer from \`values\` (a throwing value makes the read fail). */
function configEngine(values: Record<string, string | Error | null>, calls: string[] = []): BrainEngine {
  return {
    async getConfig(key: string) {
      const v = values[key];
      if (v instanceof Error) throw v;
      return v ?? null;
    },
    async executeRaw(sql: string) { calls.push(sql); return []; },
  } as unknown as BrainEngine;
}

const meta: HybridSearchMeta = { vector_enabled: true, detail_resolved: null, expansion_applied: false, intent: 'general', mode: 'balanced' };

describe('engineKey', () => {
  test('a page transaction, a read-through view and a deadline wrapper share their engine\'s key', () => {
    const engine = configEngine({});
    const tx = Object.create(engine) as object;
    Object.defineProperty(tx, '_pageTransaction', { value: true });
    const view = registerEngineView({}, engine);
    expect(engineKey(engine)).toBe(engine);
    expect(engineKey(tx)).toBe(engine);
    expect(engineKey(view)).toBe(engine);
    expect(engineKey(deadlineBoundEngine(engine))).toBe(engine);
    expect(engineKey(configEngine({}))).not.toBe(engine);
  });
});

describe('engineKey through forwarding proxies', () => {
  test('the autopilot guard and the shared-read wrappers share their engine\'s key', () => {
    const state = { blocked: false } as unknown as OwnerProcessingState;
    expect(engineKey(guardAutopilotEngine(brainA, state))).toBe(brainA);
    expect(engineKey(batchSharedReads(brainA))).toBe(brainA);
    expect(engineKey(preparationReads(brainA))).toBe(brainA);
    expect(engineKey(guardAutopilotEngine(brainB, state))).toBe(brainB);
  });

  test('a ceiling read through the autopilot guard bounds that engine\'s publication transactions', async () => {
    await brainA.setConfig('persistence.publication_ceiling_ms', '120000');
    try {
      const state = { blocked: false } as unknown as OwnerProcessingState;
      expect(await readPublicationCeilingMs(guardAutopilotEngine(brainA, state))).toBe(120_000);
      const bound: unknown[][] = [];
      const tx = Object.assign(Object.create(brainA), {
        _pageTransaction: true, kind: 'postgres', async executeRaw(_sql: string, params?: unknown[]) { bound.push(params ?? []); return []; },
      }) as BrainEngine;
      await bindPublicationTimeouts(tx);
      expect(bound).toEqual([[`${publicationIdleTimeoutMs(120_000)}ms`]]);
    } finally {
      await brainA.unsetConfig('persistence.publication_ceiling_ms');
    }
  });
});

describe('engineKey through a recovered degraded engine', () => {
  test('a ceiling read through the recovered wrapper bounds the live engine\'s publication transactions', async () => {
    const degraded = createDegradedEngine({ initialError: new Error('down'), reconnect: async () => brainA, minIntervalMs: 0 });
    expect(engineKey(degraded)).toBe(degraded);
    await expect(degraded.getConfig('x')).rejects.toBeInstanceOf(DegradedRecoveredRetryError);
    expect(engineKey(degraded)).toBe(brainA);
    await brainA.setConfig('persistence.publication_ceiling_ms', '60000');
    try {
      expect(await readPublicationCeilingMs(degraded)).toBe(60_000);
      const bound: unknown[][] = [];
      const tx = Object.assign(Object.create(brainA), {
        _pageTransaction: true, kind: 'postgres', async executeRaw(_sql: string, params?: unknown[]) { bound.push(params ?? []); return []; },
      }) as BrainEngine;
      await bindPublicationTimeouts(tx);
      expect(bound).toEqual([[`${publicationIdleTimeoutMs(60_000)}ms`]]);
    } finally {
      await brainA.unsetConfig('persistence.publication_ceiling_ms');
    }
  });
});

describe('search telemetry flushes into the searching brain', () => {
  test('each engine\'s rows land in its own database, whichever recorded first', async () => {
    recordSearchTelemetry(brainA, meta, { results_count: 1 });
    recordSearchTelemetry(brainB, meta, { results_count: 1 });
    recordSearchTelemetry(brainB, meta, { results_count: 1 });
    await awaitPendingTelemetryFlush(5000, 'exit');
    const count = async (e: PGLiteEngine) => (await e.executeRaw<{ n: number }>('SELECT COALESCE(SUM(count),0)::int AS n FROM search_telemetry'))[0]!.n;
    expect(await count(brainA)).toBe(1);
    expect(await count(brainB)).toBe(2);
    await brainA.executeRaw('DELETE FROM search_telemetry');
    await brainB.executeRaw('DELETE FROM search_telemetry');
  });

  test('a transaction records into its engine\'s writer, not a writer of its own', () => {
    const tx = Object.create(brainA) as BrainEngine;
    Object.defineProperty(tx, '_pageTransaction', { value: true });
    recordSearchTelemetry(brainA, meta, { results_count: 1 });
    recordSearchTelemetry(tx, meta, { results_count: 1 });
    expect(_telemetryWriterCountForTest()).toBe(1);
  });

  test('an engine\'s disconnect suspends its writer, so engines opened and closed per request leave no timer behind', async () => {
    const closers: Array<() => Promise<void>> = [];
    for (let i = 0; i < 20; i++) {
      const hooks = new Set<() => Promise<void>>();
      const engine = { ...configEngine({}), registerBeforeDisconnect(stop: () => Promise<void>) { hooks.add(stop); return () => { hooks.delete(stop); }; } } as unknown as BrainEngine;
      recordSearchTelemetry(engine, meta, { results_count: 1 });
      closers.push(async () => { for (const stop of [...hooks]) await stop(); });
    }
    expect(_telemetryWriterCountForTest()).toBe(20);
    for (const close of closers) await close();
    expect(_telemetryWriterCountForTest()).toBe(0);
  });});

describe('a PGLite reconnect', () => {
  let dir: string;
  let fileBrain: PGLiteEngine;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gb-telemetry-reconnect-'));
    fileBrain = new PGLiteEngine();
    await fileBrain.connect({ database_path: join(dir, 'brain.pglite') });
    await fileBrain.initSchema();
  });

  afterAll(async () => {
    await fileBrain.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('keeps the buffered telemetry, which then flushes into the reconnected brain', async () => {
    recordSearchTelemetry(fileBrain, meta, { results_count: 1 });
    await fileBrain.reconnect();
    recordSearchTelemetry(fileBrain, meta, { results_count: 1 });
    await awaitPendingTelemetryFlush(5000, 'exit');
    expect((await fileBrain.executeRaw<{ n: number }>('SELECT COALESCE(SUM(count),0)::int AS n FROM search_telemetry'))[0]!.n).toBe(2);
  });
});

describe('per-brain settings are read per engine', () => {
  test('retrieval tracking honors each brain\'s own search.track_retrieval', async () => {
    const writesA: string[] = [];
    const writesB: string[] = [];
    bumpLastRetrievedAt(configEngine({ 'search.track_retrieval': 'false' }, writesA), [1]);
    await awaitPendingLastRetrievedWrites(2000);
    bumpLastRetrievedAt(configEngine({ 'search.track_retrieval': 'true' }, writesB), [1]);
    await awaitPendingLastRetrievedWrites(2000);
    expect(writesA).toHaveLength(0);
    expect(writesB).toHaveLength(1);
  });

  test('a job name resolves each brain\'s own admission quota', async () => {
    const a = await resolveAdmissionPolicy(configEngine({ 'minions.quota_max_waiting.probe-job': '5' }), 'probe-job');
    const b = await resolveAdmissionPolicy(configEngine({ 'minions.quota_max_waiting.probe-job': '7' }), 'probe-job');
    expect(a.quotaMaxWaiting).toBe(5);
    expect(b.quotaMaxWaiting).toBe(7);
  });

  test('a failed strict-params read falls back to its own brain, never another brain\'s last mode', async () => {
    expect(await resolveStrictParamsMode(configEngine({ 'mcp.strict_params': 'reject' }), null)).toBe('reject');
    const flaky = configEngine({ 'mcp.strict_params': new Error('config table unavailable') });
    expect(await resolveStrictParamsMode(flaky, null)).toBe('warn');
    const recovered = configEngine({ 'mcp.strict_params': 'reject' });
    expect(await resolveStrictParamsMode(recovered, null)).toBe('reject');
    (recovered as unknown as { getConfig: () => Promise<never> }).getConfig = async () => { throw new Error('blip'); };
    expect(await resolveStrictParamsMode(recovered, null)).toBe('reject');
  });

  test('each brain reads its own publication ceiling inside the cache window', async () => {
    expect(await readPublicationCeilingMs(configEngine({ 'persistence.publication_ceiling_ms': '120000' }))).toBe(120_000);
    expect(await readPublicationCeilingMs(configEngine({ 'persistence.publication_ceiling_ms': '180000' }))).toBe(180_000);
  });

  test('the write_capacity_low throttle is per brain', async () => {
    const setting = 'persistence.capacity.lifetime_ids';
    const row = { scope: 'brain', resource: 'lifetime_ids' as const, used: 90, limit: 100, pct: 90, days_to_exhaustion: null,
      ['config_key']: setting, recommended_limit: 200, command: `gbrain config set ${setting} 200` };
    const snapshot: CapacitySnapshot = { rows: [row], low: [row], paused: [], pause_pct: 95, status: 'ok' };
    const a = configEngine({});
    expect(await capacityNotices(a, { throttle: true, snapshot })).toHaveLength(1);
    expect(await capacityNotices(a, { throttle: true, snapshot })).toHaveLength(0);
    expect(await capacityNotices(configEngine({}), { throttle: true, snapshot })).toHaveLength(1);
  });
});
