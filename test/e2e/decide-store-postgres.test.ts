/**
 * System One decide storage on LIVE Postgres (and PgBouncer when the lane
 * points DATABASE_URL at the pooler): the executeRaw store (unnest-array
 * receipt and spend inserts with nulls, booleans and reals), the insert-if-
 * absent HMAC salt, calibrations CRUD, the daily spend sum, aggregate reads,
 * retention pruning, the batched private-page egress query, and decide_health.
 * PGLite parity lives in test/decide/runtime.test.ts and
 * test/doctor-decide-health.test.ts.
 *
 *   Run: DATABASE_URL=... bun test test/e2e/decide-store-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import {
  dailySpend, flushDecideWrites, getCalibration, insertCalibration, listCalibrations, pruneReceipts, receiptSalt, recordReceipts,
  recordSpend, receiptStats, replayReceipts, setCalibrationRetired, slotUsage, storeQualification, __resetDecideStoreForTests,
} from '../../src/core/ai/decide/store.ts';
import { buildReceiptRows } from '../../src/core/ai/decide/receipts.ts';
import { checkEgress } from '../../src/core/ai/decide/egress.ts';
import { readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { packShape } from '../../src/core/ai/decide/pack.ts';
import { decideHealthEntry } from '../../src/commands/doctor/checks/decide.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';

const d = hasDatabase() ? describe : describe.skip;
let engine: PostgresEngine;

d('decide store (live Postgres)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    __resetDecideStoreForTests();
    await engine.executeRaw('DELETE FROM decision_receipts');
    await engine.executeRaw('DELETE FROM decide_spend');
    await engine.executeRaw('DELETE FROM decide_calibrations');
    await engine.executeRaw('DELETE FROM decide_state');
    configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test' } });
  });

  afterAll(async () => {
    resetGateway();
    await teardownDB();
  });

  test('receipts and spend round-trip through unnest inserts, hashes only', async () => {
    const [a, b] = await Promise.all([receiptSalt(engine), receiptSalt(engine)]);
    expect(a).toBe(b);
    const rows = await buildReceiptRows(engine, {
      slot: 'evidence', mode: 'on', callSite: 'search', lane: 'hot', provider: 'typesafe:jev-1.13.0',
      questions: [0, 1, 2].map((i) => ({ id: `e${i}`, kind: 'noul' as const, rank: i, protected: i === 0, instructions: 'q', inputs: { c: { text: `SECRET ${i}`, class: 'candidates' as const, slug: `s${i}` } } })),
      state: { query: { text: 'SECRET QUERY', class: 'query' } }, outcomes: { e0: 'kept', e1: 'pruned', e2: 'margin_hold' }, subjects: { e0: 'page:default:s0' },
      result: {
        decision_id: 'dec-1', provider: 'typesafe:jev-1.13.0', model_alias: 'jev-1.13.0', model_resolved: 'jev-1.13.0', refused: {},
        answers: { e0: { kind: 'noul', p: 0.9 }, e1: { kind: 'noul', p: 0.1 }, e2: { kind: 'noul', p: 0.45 } },
        usage: { input_tokens: 300, output_tokens: 0 }, cost_usd: 0, latency_ms: 42, batches: 1, lane: 'hot',
      },
    });
    recordReceipts(engine, rows);
    recordSpend(engine, { request_id: 'r1', slot: 'evidence', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', lane: 'hot', remote: true, input_tokens: 300, cost_usd: 0.0000126, outcome: 'ok' });
    await flushDecideWrites();
    const stored = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM decision_receipts ORDER BY rank');
    expect(stored).toHaveLength(3);
    expect(stored[0]!.protected).toBe(true);
    expect(Number(stored[1]!.answer_value)).toBeCloseTo(0.1, 5);
    expect(JSON.stringify(stored, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('SECRET');
    __resetDecideStoreForTests();
    const spend = await dailySpend(engine);
    expect(spend.total).toBeCloseTo(0.0000126, 10);
    expect(spend.remote).toBeCloseTo(0.0000126, 10);
    expect((await receiptStats(engine, { sinceHours: 24 })).length).toBeGreaterThan(0);
    expect((await slotUsage(engine, 24))[0]).toMatchObject({ slot: 'evidence', decisions: 1, rows: 3 });
    expect(await replayReceipts(engine, 'evidence', 24)).toHaveLength(3);
    expect(await pruneReceipts(engine, 7)).toBe(0);
  });

  test('calibrations insert, qualify, list, retire and restore', async () => {
    const id = await insertCalibration(engine, {
      slot: 'evidence', call_site: 'search', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.42, min_keep: 3,
      metric: 'f1', metric_value: 0.8, ece: 0.03, retest_sd: 0.02, repack_sd: 0.04, n: 120, dataset_hash: 'd', split_hash: 's',
      calibrate_ids_hash: 'c', calibrate_only: true, pack_shape: packShape('evidence'), notes: null,
    });
    await storeQualification(engine, id, { action_precision_lb: 0.93, qualification: '{"status":"qualified"}', policy_fingerprint: 'fp' });
    const row = await getCalibration(engine, id);
    expect(row).toMatchObject({ id, threshold: expect.closeTo(0.42, 5), action_precision_lb: expect.closeTo(0.93, 5), calibrate_only: true, policy_fingerprint: 'fp' });
    expect(typeof row!.created_at).toBe('string');
    expect(await setCalibrationRetired(engine, id, true)).toBe(true);
    expect(await listCalibrations(engine, { slot: 'evidence' })).toHaveLength(0);
    expect(await listCalibrations(engine, { slot: 'evidence', includeRetired: true })).toHaveLength(1);
    await setCalibrationRetired(engine, id, false);
    expect(await listCalibrations(engine)).toHaveLength(1);
  });

  test('the batched private-page egress query works on Postgres', async () => {
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, frontmatter) VALUES ('default', 'decide/world', 'note', 'w', '{}'::jsonb), ('default', 'decide/private', 'note', 'p', '{"visibility":"private"}'::jsonb)`);
    const cfg = readDecideConfig({ 'decide.provider': 'typesafe:jev-1.13.0', 'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow' });
    const cand = (slug: string) => ({ text: slug, class: 'candidates' as const, slug, source_id: 'default' });
    const v = await checkEgress(engine, cfg, 'typesafe:jev-1.13.0', { query: { text: 'q', class: 'query' } }, [
      { id: 'w', kind: 'noul', instructions: 'q', inputs: { c: cand('decide/world') } },
      { id: 'p', kind: 'noul', instructions: 'q', inputs: { c: cand('decide/private') } },
    ]);
    expect(v.refused).toEqual({ p: 'egress_private_denied' });
  });

  test('decide_health runs on Postgres', async () => {
    const checks = await decideHealthEntry.run({ engine, progress: { heartbeat() {}, finish() {} } } as unknown as DoctorContext) as Check[];
    expect(checks.map((c) => c.name)).toEqual(['decide_health']);
    expect(checks[0]!.status).toBe('ok');
  });
});
