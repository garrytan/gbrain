/**
 * System One S6 recall_needed (know-to-ask): the pure pieces shared by
 * production, qualify and evals.
 *
 * Protects: the reducer's four outcomes (fire only when the reflex was
 * silent; suppress only below suppress_below outside the margin and never
 * over an identity hit), the state builder (prompt must be the user's newest
 * turn, caps, conversation provenance), the dataset adapter's production
 * shape and its harmful-action accounting, the suppress_below binding in the
 * policy fingerprint (other slots' fingerprints unchanged), and the config
 * default.
 */
import { describe, expect, test } from 'bun:test';
import {
  recallNeededQuestion, recallNeededState, recallReflex, reduceRecallNeeded, RECALL_LAST_TURN_CHAR_CAP, RECALL_NEEDED_QUESTION_ID,
  RECALL_PROMPT_CHAR_CAP, REFLEX_FIRED_SLICE, REFLEX_SILENT_SLICE,
} from '../../src/core/ai/decide/recall-needed.ts';
import { datasetAdapter, datasetSources, type DatasetItem } from '../../src/core/ai/decide/dataset.ts';
import { policyFingerprint, resolveSlotPolicy } from '../../src/core/ai/decide/policy.ts';
import { readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { packShape } from '../../src/core/ai/decide/pack.ts';

const policy = { threshold: 0.5, suppressBelow: 0.2, margin: 0.05 };
const silent = { fired: false, identityHit: false };
const fired = { fired: true, identityHit: false };
const identity = { fired: true, identityHit: true };

describe('reduceRecallNeeded', () => {
  test('fires only when the reflex surfaced nothing and p clears the threshold', () => {
    expect(reduceRecallNeeded(0.5, silent, policy)).toBe('fire');
    expect(reduceRecallNeeded(0.49, silent, policy)).toBe('no_fire');
    expect(reduceRecallNeeded(0.01, silent, policy)).toBe('no_fire');
    expect(reduceRecallNeeded(0.99, fired, policy)).toBe('no_fire');
  });

  test('suppresses below suppress_below minus the margin; the margin band holds', () => {
    expect(reduceRecallNeeded(0.14, fired, policy)).toBe('suppress');
    expect(reduceRecallNeeded(0.151, fired, policy)).toBe('margin_hold');
    expect(reduceRecallNeeded(0.19, fired, policy)).toBe('margin_hold');
    expect(reduceRecallNeeded(0.2, fired, policy)).toBe('no_fire');
  });

  test('an identity hit is never suppressed', () => {
    expect(reduceRecallNeeded(0, identity, policy)).toBe('no_fire');
  });

  test('with the shipped defaults (suppress_below 0.10, margin floor 0.05) p below 0.05 suppresses and 0.05-0.10 holds', () => {
    for (const p of [0, 0.01, 0.049]) expect(reduceRecallNeeded(p, fired, { threshold: 0.5, suppressBelow: 0.1, margin: 0.05 })).toBe('suppress');
    for (const p of [0.05, 0.07, 0.099]) expect(reduceRecallNeeded(p, fired, { threshold: 0.5, suppressBelow: 0.1, margin: 0.05 })).toBe('margin_hold');
  });

  test('recallReflex: alias and exact-title arms are identity hits, others are not', () => {
    expect(recallReflex([])).toEqual({ fired: false, identityHit: false });
    expect(recallReflex([{ arm: 'title-surname' }, { arm: 'slug-suffix' }])).toEqual({ fired: true, identityHit: false });
    expect(recallReflex([{ arm: 'alias' }])).toEqual({ fired: true, identityHit: true });
    expect(recallReflex([{ arm: 'title' }])).toEqual({ fired: true, identityHit: true });
  });
});

describe('recallNeededState', () => {
  const prov = { transcriptRef: 'session:s1', sourceId: 'default' };

  test('prompt = newest user turn, last_turn = the turn before; conversation provenance on both', () => {
    const state = recallNeededState([{ role: 'user', text: 'old' }, { role: 'assistant', text: 'previous answer' }, { role: 'user', text: 'new prompt' }], prov)!;
    expect(Object.keys(state)).toEqual(['prompt', 'last_turn']);
    expect(state.prompt).toEqual({ text: 'new prompt', class: 'conversation', transcript_ref: 'session:s1', source_id: 'default' });
    expect(state.last_turn!.text).toBe('previous answer');
    expect(state.last_turn!.class).toBe('conversation');
  });

  test('no state without a user prompt; a single turn has no last_turn', () => {
    expect(recallNeededState([], prov)).toBeNull();
    expect(recallNeededState([{ role: 'assistant', text: 'hi' }], prov)).toBeNull();
    expect(recallNeededState([{ role: 'user', text: '   ' }], prov)).toBeNull();
    expect(Object.keys(recallNeededState([{ role: 'user', text: 'hi' }], prov)!)).toEqual(['prompt']);
  });

  test('caps the prompt head and the previous turn tail', () => {
    const state = recallNeededState([{ role: 'assistant', text: 'a'.repeat(5000) + 'END' }, { role: 'user', text: 'START' + 'b'.repeat(9000) }], prov)!;
    expect(state.prompt!.text.length).toBe(RECALL_PROMPT_CHAR_CAP);
    expect(state.prompt!.text.startsWith('START')).toBe(true);
    expect(state.last_turn!.text.length).toBe(RECALL_LAST_TURN_CHAR_CAP);
    expect(state.last_turn!.text.endsWith('END')).toBe(true);
  });

  test('one noul question with a stable id and slot', () => {
    expect(recallNeededQuestion()).toMatchObject({ id: RECALL_NEEDED_QUESTION_ID, kind: 'noul', slot: 'recall_needed' });
  });
});

describe('dataset adapter and builder', () => {
  const item = (over: Partial<DatasetItem>): DatasetItem => ({
    id: 'f1#3', family: 'f1#3', slot: 'recall_needed', split: 'calibrate', state: { prompt: 'who was that founder?', last_turn: 'earlier' },
    inputs: {}, label: true, slice: REFLEX_FIRED_SLICE, ...over,
  });

  test('know-to-ask is a registered source and the adapter builds the production request shape', () => {
    expect(datasetSources()).toContain('know-to-ask');
    const adapter = datasetAdapter('recall_needed')!;
    expect(adapter.callSite).toBe('turn_context');
    const req = adapter.request([item({})]);
    expect(Object.keys(req.state)).toEqual(['prompt', 'last_turn']);
    expect(req.state.prompt!.class).toBe('conversation');
    expect(req.questions).toEqual([recallNeededQuestion()]);
    expect(req.itemFor[RECALL_NEEDED_QUESTION_ID]!.id).toBe('f1#3');
  });

  test('harmful actions are exactly the suppressions the production reducer takes', () => {
    const adapter = datasetAdapter('recall_needed')!;
    const p = { threshold: 0.5, margin: 0.05, minKeep: 0, suppressBelow: 0.2 };
    const cases: Array<[Partial<DatasetItem>, number, boolean | null]> = [
      [{ id: 'a', label: false }, 0.01, true],
      [{ id: 'b', label: true }, 0.01, false],
      [{ id: 'c', label: false, protected: true }, 0.01, null],
      [{ id: 'd', label: false, slice: REFLEX_SILENT_SLICE }, 0.01, null],
      [{ id: 'e', label: false }, 0.17, null],
    ];
    for (const [over, value, correct] of cases) {
      const it = item(over);
      const actions = adapter.harmfulActions!([it], { [it.id]: value }, p);
      expect(actions.length === 0 ? null : actions[0]!.correct).toBe(correct);
    }
    expect(adapter.harmfulActions!([item({ id: 'x' })], { x: null }, p)).toEqual([]);
  });
});

describe('policy and config', () => {
  test('suppress_below defaults to 0.10 on recall_needed only, and reads the registered key', () => {
    expect(readDecideConfig({}).slots.recall_needed.suppressBelow).toBe(0.1);
    expect(readDecideConfig({}).slots.evidence.suppressBelow).toBeUndefined();
    expect(readDecideConfig({ 'decide.slots.recall_needed.suppress_below': '0.2' }).slots.recall_needed.suppressBelow).toBe(0.2);
    expect(readDecideConfig({ 'decide.slots.recall_needed.suppress_below': '7' }).slots.recall_needed.suppressBelow).toBe(0.1);
  });

  test('the fingerprint binds suppress_below and leaves other slots unchanged', () => {
    const base = { slot: 'evidence' as const, callSite: 'search', threshold: 0.5, marginFloor: 0.05, minKeep: 3, packShape: packShape('evidence') };
    expect(policyFingerprint({ ...base, suppressBelow: undefined })).toBe(policyFingerprint(base));
    const s6 = { ...base, slot: 'recall_needed' as const, callSite: 'turn_context', minKeep: 0, packShape: packShape('recall_needed') };
    expect(policyFingerprint({ ...s6, suppressBelow: 0.05 })).not.toBe(policyFingerprint({ ...s6, suppressBelow: 0.1 }));
    const cfg = readDecideConfig({ 'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.recall_needed.mode': 'on', 'decide.slots.recall_needed.suppress_below': '0.1' });
    const policy = resolveSlotPolicy({ cfg, slot: 'recall_needed', callSite: 'turn_context', packShape: packShape('recall_needed'), calibrations: [], hasTypesafeKey: true });
    expect(policy.suppressBelow).toBe(0.1);
    expect(policy.fingerprint).toBe(policyFingerprint({ ...s6, threshold: undefined, suppressBelow: 0.1 }));
  });
});
