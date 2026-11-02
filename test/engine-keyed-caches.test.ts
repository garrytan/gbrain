/**
 * Per-brain caches are keyed by the engine, so two brains opened in one
 * process never read each other's cached settings or write into each other's
 * database.
 *
 * 1. Protects: with two PGLite engines holding different values of a setting,
 *    the second engine read sees its own value after the first was read (and
 *    cached); search telemetry recorded against each engine lands in that
 *    engine's own `search_telemetry`; a transaction handle shares its engine's
 *    entry; a cache entry never keeps a dropped engine alive.
 * 2. Fails when: any of these caches goes back to one module-level value (or a
 *    Map holding the engine strongly), or the telemetry writer goes back to the
 *    first engine it was given.
 * 3. Existing coverage tests each cache with one engine, so a process-wide
 *    value passes there.
 * 4. Real seams: two PGLite engines and real transactions; stub engines only
 *    where the assertion is that an engine is garbage collected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { makeChatResult } from './conversation-parser/helpers.ts';
import {
  awaitPendingLastRetrievedWrites, bumpLastRetrievedAt, _resetPendingLastRetrievedWritesForTests, _resetTrackRetrievalCacheForTests,
} from '../src/core/last-retrieved.ts';
import { declarePublication, readPublicationCeilingMs, _resetPublicationCeilingForTest } from '../src/core/persistence/publication-deadline.ts';
import { resolveAdmissionPolicy, _resetAdmissionCacheForTest } from '../src/core/minions/admission.ts';
import { resetStrictParamsModeCache, resolveStrictParamsMode } from '../src/mcp/validate-params.ts';
import { capacityNotices, __resetCapacityNoticesForTests, type CapacityAttention, type CapacitySnapshot } from '../src/core/persistence/capacity-snapshot.ts';
import { loadFeedbackSettings, _resetFeedbackSettingsCacheForTests } from '../src/core/feedback/settings.ts';
import { drainFeedbackQueue, recordAnswer, _resetFeedbackRecordingForTests } from '../src/core/feedback/record.ts';
import { dailySpend, __resetDecideStoreForTests } from '../src/core/ai/decide/store.ts';
import { __fingerprintCacheForTests, readBeliefState } from '../src/core/belief/state.ts';
import { runLlmCall, _resetLlmCacheForTests } from '../src/core/conversation-parser/llm-base.ts';
import { awaitPendingTelemetryFlush, recordSearchTelemetry, _resetTelemetryWriterForTest } from '../src/core/search/telemetry.ts';

let a: PGLiteEngine;
let b: PGLiteEngine;

beforeAll(async () => {
  a = new PGLiteEngine();
  await a.connect({});
  await a.initSchema();
  b = new PGLiteEngine();
  await b.connect({});
  await b.initSchema();
}, 60_000);

afterAll(async () => {
  _resetTelemetryWriterForTest();
  await a.disconnect();
  await b.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(a);
  await resetPgliteState(b);
  _resetTrackRetrievalCacheForTests();
  _resetPendingLastRetrievedWritesForTests();
  _resetPublicationCeilingForTest();
  _resetAdmissionCacheForTest();
  resetStrictParamsModeCache();
  __resetCapacityNoticesForTests();
  _resetFeedbackSettingsCacheForTests();
  _resetFeedbackRecordingForTests();
  __resetDecideStoreForTests();
  _resetLlmCacheForTests();
  _resetTelemetryWriterForTest();
});

async function seedPage(engine: BrainEngine, slug: string): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline) VALUES ($1, 'default', 'note', $1, 'body', '') RETURNING id`, [slug]);
  return Number(row!.id);
}

const count = async (engine: BrainEngine, sql: string) => Number((await engine.executeRaw<{ n: number | string }>(sql))[0]!.n);

/** Whether everything `refs` points at was collected (a few GC rounds, as test/hardened-git-held-chunk-gbra133.test.ts does). */
async function collected(refs: Array<WeakRef<object>>): Promise<boolean> {
  for (let round = 0; round < 3; round++) { await Bun.sleep(0); Bun.gc(true); }
  return refs.every(ref => ref.deref() === undefined);
}

describe('per-brain caches keyed by the engine', () => {
  test('last-retrieved: each brain reads its own search.track_retrieval', async () => {
    await a.setConfig('search.track_retrieval', 'false');
    const pageA = await seedPage(a, 'notes/alpha');
    const pageB = await seedPage(b, 'notes/beta');
    bumpLastRetrievedAt(a, [pageA]);
    await awaitPendingLastRetrievedWrites();
    bumpLastRetrievedAt(b, [pageB]);
    await awaitPendingLastRetrievedWrites();
    expect(await count(a, 'SELECT count(*) AS n FROM page_retrievals')).toBe(0);
    expect(await count(b, 'SELECT count(*) AS n FROM page_retrievals')).toBe(1);
  });

  test("publication ceiling: a publish transaction's idle bound is its own brain's ceiling", async () => {
    await a.setConfig('persistence.publication_ceiling_ms', '60000');
    await b.setConfig('persistence.publication_ceiling_ms', '120000');
    expect(await readPublicationCeilingMs(b)).toBe(120_000);
    expect(await readPublicationCeilingMs(a)).toBe(60_000);
    // The idle bound is applied on Postgres only; declaring it as Postgres on a real PGLite transaction shows the value.
    const idleBound = (engine: PGLiteEngine) => engine.transaction(async tx => {
      await declarePublication(tx, { kind: 'postgres' });
      return (await tx.executeRaw<{ v: string }>("SELECT current_setting('idle_in_transaction_session_timeout') AS v"))[0]!.v;
    });
    expect(await idleBound(b)).toBe('2min');
    expect(await idleBound(a)).toBe('1min');
  });

  test('admission: a job name resolves its policy from each brain', async () => {
    await a.setConfig('minions.quota_max_waiting.probe-job', '5');
    expect((await resolveAdmissionPolicy(a, 'probe-job')).quotaMaxWaiting).toBe(5);
    expect((await resolveAdmissionPolicy(b, 'probe-job')).quotaMaxWaiting).toBeNull();
  });

  test("strict params: a failed read falls back to its own brain's last-known mode", async () => {
    await b.setConfig('mcp.strict_params', 'reject');
    await a.setConfig('mcp.strict_params', 'warn');
    expect(await resolveStrictParamsMode(b, null)).toBe('reject');
    expect(await resolveStrictParamsMode(a, null)).toBe('warn');
    const failing = spyOn(b, 'getConfig').mockImplementationOnce(() => Promise.reject(new Error('connection blip')));
    try {
      expect(await resolveStrictParamsMode(b, null)).toBe('reject');
    } finally { failing.mockRestore(); }
  });

  test('capacity notices: the hourly low-capacity throttle is per brain', async () => {
    const row: CapacityAttention = { scope: 'brain', resource: 'lifetime_ids', used: 90, limit: 100, pct: 90, days_to_exhaustion: null,
      config_key: 'persistence.limits.brain_lifetime_ids', recommended_limit: 200, command: 'gbrain config set persistence.limits.brain_lifetime_ids 200' };
    const snapshot: CapacitySnapshot = { rows: [row], low: [row], paused: [], pause_pct: 95, status: 'ok' };
    expect((await capacityNotices(a, { throttle: true, snapshot })).map(n => n.code)).toEqual(['write_capacity_low']);
    expect((await capacityNotices(a, { throttle: true, snapshot }))).toEqual([]);
    expect((await capacityNotices(b, { throttle: true, snapshot })).map(n => n.code)).toEqual(['write_capacity_low']);
  });

  test("feedback settings: reading another brain keeps this brain's cached settings", async () => {
    await a.setConfig('feedback.enabled', 'true');
    expect((await loadFeedbackSettings(a)).enabled).toBe(true);
    expect((await loadFeedbackSettings(b)).enabled).toBe(false);
    const reads = spyOn(a, 'getConfig');
    try {
      expect((await loadFeedbackSettings(a)).enabled).toBe(true);
      expect(reads).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); }
  });

  test('feedback recording: the rating hint cadence is per brain, and a drained queue lets go of its engine', async () => {
    await a.setConfig('feedback.enabled', 'true');
    await b.setConfig('feedback.enabled', 'true');
    const answer = (engine: BrainEngine) => recordAnswer({ engine, remote: false } as unknown as OperationContext,
      { op: 'search', pages: [{ slug: 'notes/alpha' }] });
    expect((await answer(a))?.feedback.how_to_rate).toBeDefined();
    expect((await answer(a))?.feedback.how_to_rate).toBeUndefined();
    expect((await answer(b))?.feedback.how_to_rate).toBeDefined();
    expect(await drainFeedbackQueue(2000)).toEqual({ unfinished: 0 });
    expect(await count(a, 'SELECT count(*) AS n FROM retrieval_events')).toBe(2);
    expect(await count(b, 'SELECT count(*) AS n FROM retrieval_events')).toBe(1);

    const refs: Array<WeakRef<object>> = [];
    await (async () => {
      const stub = { kind: 'pglite', getConfig: async (key: string) => (key === 'feedback.enabled' ? 'true' : null), executeRaw: async () => [] };
      refs.push(new WeakRef(stub));
      await answer(stub as unknown as BrainEngine);
      expect(await drainFeedbackQueue(2000)).toEqual({ unfinished: 0 });
    })();
    expect(await collected(refs)).toBe(true);
  });

  test('decide spend: the daily spend cache does not keep an engine alive', async () => {
    const refs: Array<WeakRef<object>> = [];
    await (async () => {
      const stub = { kind: 'pglite', executeRaw: async () => [{ total: 1.5, remote: 0 }] };
      refs.push(new WeakRef(stub));
      expect((await dailySpend(stub as unknown as BrainEngine)).total).toBe(1.5);
    })();
    expect(await collected(refs)).toBe(true);
  });

  test("belief fingerprints: each brain reads its own fingerprint cache, and its transactions share it", async () => {
    const slug = 'companies/acme-example';
    const claim = 'Acme raised a seed round';
    for (const engine of [a, b]) {
      await seedPage(engine, slug);
      await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence)
        VALUES ('default', $1, $2, 'fact', 'probe', 'world', 1)`, [slug, claim]);
    }
    const [{ fp: truth }] = await a.executeRaw<{ fp: string }>('SELECT gbrain_fact_fingerprint($1) AS fp', [claim]);
    const fingerprint = async (engine: BrainEngine) => (await readBeliefState(engine, 'default', [slug])).facts.map(f => f.fp);
    expect(await fingerprint(a)).toEqual([truth]);
    __fingerprintCacheForTests(a).fingerprints.set(createHash('sha256').update(claim, 'utf8').digest('hex'), 'poisoned');
    expect(await fingerprint(a)).toEqual(['poisoned']);
    expect(await a.transaction(tx => fingerprint(tx))).toEqual(['poisoned']);
    expect(await fingerprint(b)).toEqual([truth]);
  });

  test('conversation-parser LLM cache: an in-process hit never crosses brains', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const call = (engine: BrainEngine, text: string) => runLlmCall<string>({
        shape: 'polish', modelStr: 'claude-haiku-4-5', content: 'the same transcript', system: 'test', engine,
        parse: t => t, chatTransport: async () => makeChatResult(text),
      });
      expect(await call(a, 'from a')).toBe('from a');
      expect(await call(b, 'from b')).toBe('from b');
      expect(await call(a, 'not called')).toBe('from a');
    });
  });

  test("search telemetry: each brain's rows land in its own database", async () => {
    const meta = (intent: string): HybridSearchMeta => ({ vector_enabled: true, detail_resolved: null, expansion_applied: false, mode: 'balanced', intent } as HybridSearchMeta);
    recordSearchTelemetry(a, meta('general'), { results_count: 3 });
    recordSearchTelemetry(b, meta('entity'), { results_count: 2 });
    expect(await awaitPendingTelemetryFlush(2000, 'exit')).toEqual({ unfinished: 0 });
    const intents = async (engine: BrainEngine) => (await engine.executeRaw<{ intent: string }>('SELECT intent FROM search_telemetry ORDER BY intent')).map(r => r.intent);
    expect(await intents(a)).toEqual(['general']);
    expect(await intents(b)).toEqual(['entity']);
  });
});
