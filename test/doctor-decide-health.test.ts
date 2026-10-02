/**
 * decide_health doctor check on in-memory PGLite ($0): ok when System One is
 * off; warns (with the catalogued cause and fix) for a slot requested on but
 * inactive, a missing TypeSafe key, force_on, calibration drift against the
 * recently resolved model, a 24-hour error rate over 5%, an exhausted daily
 * budget and a retired pinned model.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { decideHealthEntry } from '../src/commands/doctor/checks/decide.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { insertCalibration, __resetDecideStoreForTests } from '../src/core/ai/decide/store.ts';
import { packShape } from '../src/core/ai/decide/pack.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetDecideStoreForTests();
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test' } });
});

async function run(): Promise<Check> {
  const ctx = { engine, progress: { heartbeat() {}, finish() {} } } as unknown as DoctorContext;
  const checks = await decideHealthEntry.run(ctx) as Check[];
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

async function set(kv: Record<string, string>) {
  for (const [k, v] of Object.entries(kv)) await engine.setConfig(k, v);
}

async function receipt(over: Record<string, unknown>) {
  const row = { decision_id: 'd', slot: 'evidence', mode: 'on', provider: 'typesafe:jev-1.13.0', outcome: 'kept', call_site: 'search', lane: 'hot', model_resolved: 'jev-1.13.0', error_reason: null, ...over };
  await engine.executeRaw(
    `INSERT INTO decision_receipts (decision_id, slot, mode, provider, outcome, call_site, lane, model_resolved, error_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [row.decision_id, row.slot, row.mode, row.provider, row.outcome, row.call_site, row.lane, row.model_resolved, row.error_reason],
  );
}

describe('decide_health', () => {
  test('ok and categorized ops when System One is off (no TypeSafe key)', async () => {
    configureGateway({ env: {} });
    const c = await run();
    expect(c.status).toBe('ok');
    expect(c.message).toContain('System One is off');
    expect(categorizeCheck('decide_health')).toBe('ops');
  });

  test('a TypeSafe key and no decide keys: triage and conflict on by default, with the opt-out', async () => {
    const c = await run();
    expect(c.status).toBe('ok');
    expect(c.message).toContain('triage=on (default: Jev key present), conflict=on (default: Jev key present)');
    expect(c.message).toContain('gbrain decide disable triage && gbrain decide disable conflict');
  });

  test('explicit off on both default slots reports System One off with a key', async () => {
    await set({ 'decide.slots.triage.mode': 'off', 'decide.slots.conflict.mode': 'off' });
    const c = await run();
    expect(c.message).toContain('System One is off');
  });

  test('a slot on without calibration warns with cause and fix', async () => {
    await set({ 'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.evidence.mode': 'on' });
    const c = await run();
    expect(c.status).toBe('warn');
    expect(c.message).toContain('evidence: requested: on / effective: off / cause: no_calibration');
    expect(c.message).toContain('gbrain decide calibrate --slot evidence');
  });

  test('missing key, force_on and alias are named', async () => {
    configureGateway({ env: {} });
    await set({ 'decide.provider': 'typesafe:jev-latest', 'decide.slots.evidence.mode': 'on', 'decide.slots.evidence.threshold': '0.5', 'decide.slots.evidence.force_on': 'true' });
    const c = await run();
    expect(c.message).toContain('TYPESAFE_API_KEY');
    expect(c.message).toContain('force_on');
    expect(c.message).toContain('moving alias');
  });

  test('drift, error rate, exhausted budget and a retired pinned model warn', async () => {
    await insertCalibration(engine, {
      slot: 'evidence', call_site: 'search', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.5, min_keep: 3,
      metric: 'f1', metric_value: 0.9, ece: 0.02, retest_sd: 0, repack_sd: 0, n: 100, dataset_hash: 'd', split_hash: 's',
      calibrate_ids_hash: 'c', calibrate_only: true, pack_shape: packShape('evidence'), notes: null,
    });
    await set({ 'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.evidence.mode': 'on', 'decide.slots.evidence.force_on': 'true', 'decide.budget.daily_usd': '0' });
    for (let i = 0; i < 20; i++) await receipt({ decision_id: `d${i}`, model_resolved: 'jev-1.14.0', outcome: i < 5 ? 'error' : 'kept', error_reason: i === 0 ? 'pinned_model_unavailable' : null });
    const c = await run();
    expect(c.status).toBe('warn');
    expect(c.message).toContain('drift');
    expect(c.message).toContain('errored in 24 h');
    expect(c.message).toContain('budget exhausted');
    expect(c.message).toContain('pinned_model_unavailable');
  });
});
