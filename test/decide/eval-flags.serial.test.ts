/**
 * `--decide` eval plumbing (src/eval/decide-eval-flags.ts) shared by eval
 * longmemeval / brainbench / retrieval-quality.
 *
 * Protects: flag validation; the all-off path returns null and leaves the
 * process untouched; flags win over an inherited GBRAIN_DECIDE_SLOTS and the
 * effective value is set and recorded; calibration import from `decide
 * calibrate --json` output (object, array, JSONL) and reference ids; the
 * split holdout refuses a mismatched split and a calibrate_only=false row
 * (split_mismatch); benchmark-brain config (provider, consent, private egress,
 * awaited shadow, thresholds, force_on, the Jev reranker pin for rerank=on);
 * operator-brain runs refuse write flags and name the catalogued refusal;
 * per-row receipts and the run roll-up (S2 late rate).
 * Serial: mutates process.env.GBRAIN_DECIDE_SLOTS and the eval override.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyDecideEvalFlag, benchmarkBrainConfig, configureDecideBrain, decideRowReceipt, DecideEvalRefusal, extractDecideEvalFlags,
  newDecideEvalOptions, operatorBrainRefusal, parseCalibrationText, prepareDecideEval, spendDelta, summarizeDecideReceipts,
} from '../../src/eval/decide-eval-flags.ts';
import { enableDecideEvalOverride, readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { splitHash, stableSplit } from '../../src/core/ai/decide/dataset.ts';
import { listCalibrations } from '../../src/core/ai/decide/store.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-decide-eval-flags-'));
const prevEnv = process.env.GBRAIN_DECIDE_SLOTS;
const THROWAWAY = { command: 'test', throwaway: true };

/** A frozen evidence dataset over families f0..f19 (split by the production stable hash). */
const items = Array.from({ length: 20 }, (_, i) => ({
  id: `f${i}:s0`, family: `f${i}`, slot: 'evidence', split: stableSplit(`f${i}`), state: { query: 'q' }, inputs: { candidate: 'c' }, label: i % 2 === 0, rank: 0,
}));
const datasetPath = join(dir, 'evidence.jsonl');
const SPLIT = splitHash(items as never);

function calibration(over: Record<string, unknown> = {}) {
  return {
    id: 7, slot: 'evidence', call_site: 'search', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.42,
    min_keep: 3, metric: 'f1', metric_value: 0.8, ece: 0.05, retest_sd: 0.01, repack_sd: 0.02, n: 10, dataset_hash: 'd', split_hash: SPLIT,
    calibrate_ids_hash: 'c', calibrate_only: true, pack_shape: 'evidence:v1', notes: null, precision: 0.9, recall: 0.7, f1: 0.8, reliability: [], margin: 0.05,
    ...over,
  };
}

beforeAll(() => {
  writeFileSync(datasetPath, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.GBRAIN_DECIDE_SLOTS;
  else process.env.GBRAIN_DECIDE_SLOTS = prevEnv;
  enableDecideEvalOverride(false);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('flag parsing', () => {
  test('valid and invalid values', () => {
    const o = newDecideEvalOptions();
    expect(applyDecideEvalFlag(o, '--decide', 'rerank=on')).toBe(true);
    expect(applyDecideEvalFlag(o, '--decide-threshold', 'evidence=0.3')).toBe(true);
    expect(applyDecideEvalFlag(o, '--decide-force-on', 'evidence')).toBe(true);
    expect(applyDecideEvalFlag(o, '--limit', '3')).toBe(false);
    expect(o).toMatchObject({ slots: { rerank: 'on' }, thresholds: { evidence: 0.3 }, forceOn: ['evidence'] });
    expect(() => applyDecideEvalFlag(o, '--decide', 'rerank=maybe')).toThrow('off|on|shadow');
    expect(() => applyDecideEvalFlag(o, '--decide', 'nope=on')).toThrow('SLOT=VALUE');
    expect(() => applyDecideEvalFlag(o, '--decide-threshold', 'rerank=0.5')).toThrow('has no threshold');
    expect(() => applyDecideEvalFlag(o, '--decide-threshold', 'evidence=2')).toThrow('from 0 to 1');
    expect(() => applyDecideEvalFlag(o, '--decide-provider', 'none')).toThrow();
  });

  test('extractDecideEvalFlags strips flags and values (both spellings) from argv', () => {
    const { decide, rest } = extractDecideEvalFlags(['fixture.jsonl', '--decide', 'evidence=on', '--json', '--decide-provider=llm:openai:gpt-4o-mini']);
    expect(rest).toEqual(['fixture.jsonl', '--json']);
    expect(decide.slots).toEqual({ evidence: 'on' });
    expect(decide.provider).toBe('llm:openai:gpt-4o-mini');
    expect(() => extractDecideEvalFlags(['--decide'])).toThrow('requires a value');
  });
});

describe('prepareDecideEval', () => {
  test('all-off: null, env untouched, override not enabled', () => {
    delete process.env.GBRAIN_DECIDE_SLOTS;
    expect(prepareDecideEval(newDecideEvalOptions(), THROWAWAY)).toBeNull();
    const off = newDecideEvalOptions();
    applyDecideEvalFlag(off, '--decide', 'evidence=off');
    expect(prepareDecideEval(off, THROWAWAY)).toBeNull();
    expect(process.env.GBRAIN_DECIDE_SLOTS).toBeUndefined();
    expect(readDecideConfig({ 'decide.slots.evidence.mode': 'off' }).slots.evidence.mode).toBe('off');
  });

  test('--decide-* options without an on/shadow slot are an error', () => {
    const o = newDecideEvalOptions();
    applyDecideEvalFlag(o, '--decide-threshold', 'evidence=0.3');
    expect(() => prepareDecideEval(o, THROWAWAY)).toThrow('need at least one --decide');
  });

  test('flags win over an inherited GBRAIN_DECIDE_SLOTS; the effective value is set, honored and recorded', () => {
    process.env.GBRAIN_DECIDE_SLOTS = 'rerank=on,triage=shadow';
    const o = newDecideEvalOptions();
    applyDecideEvalFlag(o, '--decide', 'rerank=off');
    applyDecideEvalFlag(o, '--decide', 'evidence=on');
    const run = prepareDecideEval(o, THROWAWAY)!;
    expect(run.slots).toEqual({ evidence: 'on', triage: 'shadow' });
    expect(process.env.GBRAIN_DECIDE_SLOTS).toBe('evidence=on,triage=shadow');
    expect(run.runConfig).toMatchObject({ gbrain_decide_slots: 'evidence=on,triage=shadow', inherited_env: 'rerank=on,triage=shadow', provider: 'typesafe:jev-1.13.0', shadow_wait: true });
    expect(readDecideConfig({}).slots.evidence.mode).toBe('on');
    expect(run.searchPins).toEqual({});
  });

  test('rerank=on pins the Jev reranker; benchmark config writes provider, consent, private egress, shadow wait, thresholds, force_on', () => {
    const o = newDecideEvalOptions();
    for (const [f, v] of [['--decide', 'rerank=on'], ['--decide', 'evidence=shadow'], ['--decide', 'recall_needed=on'], ['--decide-threshold', 'recall_needed=0.4'], ['--decide-force-on', 'recall_needed']]) applyDecideEvalFlag(o, f!, v!);
    const run = prepareDecideEval(o, THROWAWAY)!;
    expect(run.searchPins).toEqual({ 'search.reranker.enabled': 'true', 'search.reranker.model': 'typesafe:jev-1.13.0' });
    const cfg = Object.fromEntries(benchmarkBrainConfig(run, { includeSearchPins: true }));
    expect(cfg).toMatchObject({
      'decide.provider': 'typesafe:jev-1.13.0', 'decide.egress.private': 'allow', 'decide.egress.typesafe.query': 'allow',
      'decide.egress.typesafe.candidates': 'allow', 'decide.egress.typesafe.conversation': 'allow',
      'decide.slots.evidence.shadow_wait': 'on', 'decide.slots.evidence.shadow_sample': '1',
      'decide.slots.recall_needed.threshold': '0.4', 'decide.slots.recall_needed.force_on': 'true',
      'search.reranker.model': 'typesafe:jev-1.13.0',
    });
    expect(run.runConfig).toMatchObject({ force_on: ['recall_needed'], rerank_pinned: 'typesafe:jev-1.13.0' });
    expect(Object.fromEntries(benchmarkBrainConfig(run))['search.reranker.model']).toBeUndefined();
  });

  test('operator-brain runs refuse write flags', () => {
    const o = newDecideEvalOptions();
    applyDecideEvalFlag(o, '--decide', 'evidence=on');
    applyDecideEvalFlag(o, '--decide-force-on', 'evidence');
    expect(() => prepareDecideEval(o, { command: 'gbrain eval retrieval-quality', throwaway: false })).toThrow('never writes its config');
  });
});

describe('calibrations and the split holdout', () => {
  const withCal = (text: string, dataset = true) => {
    const path = join(dir, `cal-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, text);
    const o = newDecideEvalOptions();
    applyDecideEvalFlag(o, '--decide', 'evidence=on');
    applyDecideEvalFlag(o, '--decide-calibration', path);
    if (dataset) applyDecideEvalFlag(o, '--decide-dataset', datasetPath);
    return o;
  };

  test('parses one object, an array and JSONL', () => {
    expect(parseCalibrationText(JSON.stringify(calibration()))).toHaveLength(1);
    expect(parseCalibrationText(JSON.stringify([calibration(), calibration()]))).toHaveLength(2);
    expect(parseCalibrationText(`${JSON.stringify(calibration())}\n${JSON.stringify(calibration())}\n`)).toHaveLength(2);
  });

  test('a matching split is accepted; the eval half is exposed; ids and split_hash are recorded', () => {
    const run = prepareDecideEval(withCal(JSON.stringify(calibration(), null, 2)), THROWAWAY)!;
    expect(run.calibrations).toHaveLength(1);
    expect(run.dataset!.splitHashes.evidence).toBe(SPLIT);
    expect([...run.dataset!.evalFamilies].sort()).toEqual(items.filter((i) => i.split === 'eval').map((i) => i.family).sort());
    expect(run.runConfig).toMatchObject({ split_verified: true, calibrations: [{ slot: 'evidence', threshold: 0.42, split_hash: SPLIT }] });
  });

  test('mismatched split: refused with split_mismatch', () => {
    let err: unknown;
    try { prepareDecideEval(withCal(JSON.stringify(calibration({ split_hash: 'deadbeefdeadbeef' }))), THROWAWAY); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DecideEvalRefusal);
    expect((err as DecideEvalRefusal).reason).toBe('split_mismatch');
    expect((err as Error).message).toContain('split_mismatch');
    expect((err as Error).message).toContain('deadbeefdeadbeef');
  });

  test('calibrate_only false: refused even without a dataset', () => {
    expect(() => prepareDecideEval(withCal(JSON.stringify(calibration({ calibrate_only: false })), false), THROWAWAY)).toThrow('calibrate_only is false');
  });

  test('unknown reference ids and malformed rows are errors', () => {
    const o = newDecideEvalOptions();
    applyDecideEvalFlag(o, '--decide', 'evidence=on');
    applyDecideEvalFlag(o, '--decide-calibration', 'ref:does-not-exist');
    expect(() => prepareDecideEval(o, THROWAWAY)).toThrow('unknown reference calibration');
    expect(() => prepareDecideEval(withCal(JSON.stringify({ slot: 'evidence', threshold: 0.5 })), THROWAWAY)).toThrow('call_site is required');
  });

  test('configureDecideBrain inserts, qualifies and adopts the rows in a benchmark brain', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      const run = prepareDecideEval(withCal(JSON.stringify(calibration({ action_precision_lb: 0.93, policy_fingerprint: 'fp' }))), THROWAWAY)!;
      await configureDecideBrain(engine, run);
      const rows = await listCalibrations(engine, { slot: 'evidence' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ threshold: 0.42, split_hash: SPLIT, calibrate_only: true, action_precision_lb: 0.93, policy_fingerprint: 'fp' });
      expect(await engine.getConfig('decide.slots.evidence.calibration')).toBe(`local:${rows[0]!.id}`);
      expect(await engine.getConfig('decide.egress.private')).toBe('allow');
    } finally {
      await engine.disconnect();
    }
  });
});

describe('operator brain and receipts', () => {
  test('operatorBrainRefusal names the catalogued reason (provider, key, consent)', () => {
    const o = newDecideEvalOptions();
    applyDecideEvalFlag(o, '--decide', 'evidence=on');
    const run = prepareDecideEval(o, { command: 'rq', throwaway: false })!;
    configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } });
    try {
      expect(operatorBrainRefusal({}, run)).toContain('no_provider');
      expect(operatorBrainRefusal({ 'decide.provider': 'typesafe:jev-1.13.0' }, run)).toContain('egress_class_denied');
      expect(operatorBrainRefusal({ 'decide.provider': 'typesafe:jev-1.13.0', 'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow' }, run)).toBeNull();
    } finally {
      resetGateway();
    }
  });

  test('per-row receipt from slot meta + spend delta; the roll-up counts S2 late answers', () => {
    const o = newDecideEvalOptions();
    applyDecideEvalFlag(o, '--decide', 'evidence=on');
    applyDecideEvalFlag(o, '--decide', 'intent=on');
    applyDecideEvalFlag(o, '--decide', 'triage=on');
    const run = prepareDecideEval(o, THROWAWAY)!;
    const spend = spendDelta({ evidence: { input_tokens: 100, cost_usd: 0.001, requests: 1 } }, { evidence: { input_tokens: 400, cost_usd: 0.004, requests: 2 } });
    const r1 = decideRowReceipt(run, {
      evidence: { mode: 'on', effective: 'on', threshold: 0.5, judged: 8, outcomes: { kept: 6, pruned: 2 }, latency_ms: 120, model_resolved: 'jev-1.13.0' },
      intent: { mode: 'on', effective: 'on', skipped: 'late' },
    }, spend);
    expect(r1.evidence).toEqual({ mode: 'on', effective: 'on', threshold: 0.5, outcomes: { kept: 6, pruned: 2 }, latency_ms: 120, model_resolved: 'jev-1.13.0', judged: 8, input_tokens: 300, cost_usd: 0.003 });
    expect(r1.intent).toMatchObject({ skipped: 'late', late: true });
    expect(r1.triage).toEqual({ mode: 'on', effective: null, skipped: 'not_reached' });
    const r2 = decideRowReceipt(run, { intent: { mode: 'on', effective: 'on', outcomes: { override: 1 }, latency_ms: 80 } }, {});
    const sum = summarizeDecideReceipts([r1, r2, undefined]) as Record<string, any>;
    expect(sum.intent).toMatchObject({ rows: 2, late_rate: 0.5, outcomes: { override: 1 } });
    expect(sum.evidence).toMatchObject({ rows: 2, acted: 1, input_tokens: 300, outcomes: { kept: 6, pruned: 2 } });
    expect(sum.triage.skipped).toEqual({ not_reached: 2 });
  });
});
