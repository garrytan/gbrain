/**
 * Key-aware defaults (owner decision 2026-10-01): with a TypeSafe key and no
 * explicit setting, the measured winners (`recommendedSlots`, the same set
 * `enable --recommended` turns on) default on with the pinned Jev provider and
 * their reference calibrations, and the key is their egress opt-in. Without a
 * key, config is exactly what it was. Every explicit setting wins.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_TYPESAFE_PROVIDER, enableDecideEvalOverride, readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { checkEgress } from '../../src/core/ai/decide/egress.ts';
import { packShape } from '../../src/core/ai/decide/pack.ts';
import { driftReason, readiness, resolveSlotPolicy, type PolicyInputs } from '../../src/core/ai/decide/policy.ts';
import { REFERENCE_CALIBRATIONS, recommendedSlots } from '../../src/core/ai/decide/reference-calibrations.ts';
import { DECIDE_SLOTS, type DecideQuestion, type DecideSlot } from '../../src/core/ai/decide/types.ts';
import { cycleSlotPackShape } from '../../src/core/cycle/decide-slot.ts';

const DEFAULT_ON: DecideSlot[] = ['triage', 'conflict'];
const keyed = (snapshot: Record<string, string> = {}) => readDecideConfig(snapshot, { typesafeKey: true });
const onSlots = (cfg: ReturnType<typeof readDecideConfig>) => DECIDE_SLOTS.filter((s) => cfg.slots[s].mode !== 'off');

function inputs(cfg: ReturnType<typeof readDecideConfig>, slot: 'triage' | 'conflict', over: Partial<PolicyInputs> = {}): PolicyInputs {
  return {
    cfg, slot, callSite: slot === 'triage' ? 'dream' : 'sweep', packShape: slot === 'triage' ? cycleSlotPackShape('triage') : packShape('conflict'),
    calibrations: [], hasTypesafeKey: true, ...over,
  };
}

describe('key-aware default modes', () => {
  test('the default-on set is derived from the reference rows and equals the enable --recommended set', () => {
    expect(recommendedSlots(DEFAULT_TYPESAFE_PROVIDER).sort()).toEqual([...DEFAULT_ON].sort());
    expect(onSlots(keyed()).sort()).toEqual(recommendedSlots(DEFAULT_TYPESAFE_PROVIDER).sort());
    expect(recommendedSlots(DEFAULT_TYPESAFE_PROVIDER, () => 0.9, [])).toEqual([]);
  });

  test('key present, nothing set: triage and conflict on with the pinned provider; the other seven off', () => {
    const cfg = keyed();
    for (const slot of DECIDE_SLOTS) {
      if (DEFAULT_ON.includes(slot)) {
        expect(cfg.slots[slot]).toMatchObject({ mode: 'on', provider: DEFAULT_TYPESAFE_PROVIDER, keyDefault: true });
      } else {
        expect(cfg.slots[slot].mode).toBe('off');
        expect(cfg.slots[slot].keyDefault).toBeUndefined();
      }
    }
    expect(cfg.provider).toBe('none');
    expect(cfg.egressPrivate).toBe('deny');
    expect(Object.values(cfg.consent).every((v) => v === false)).toBe(true);
  });

  test('key absent: config is byte-identical to a reader that never heard of key defaults', () => {
    for (const snapshot of [{}, { 'decide.slots.evidence.threshold': '0.4' }, { 'decide.provider': 'typesafe:jev-1.13.0' }]) {
      const keyless = readDecideConfig(snapshot, { typesafeKey: false });
      expect(JSON.stringify(keyless)).toBe(JSON.stringify(readDecideConfig(snapshot)));
      expect(onSlots(keyless)).toEqual([]);
      expect(JSON.stringify(keyless)).not.toContain('keyDefault');
    }
  });

  test('every explicit opt-out wins', () => {
    const cases: Array<[string, Record<string, string>, DecideSlot[]]> = [
      ['slot mode off', { 'decide.slots.triage.mode': 'off' }, ['conflict']],
      ['decide.provider none', { 'decide.provider': 'none' }, []],
      ['decide.egress.private deny', { 'decide.egress.private': 'deny' }, []],
      ['consent deny for the slot data class', { 'decide.egress.typesafe.facts': 'deny' }, ['triage']],
      ['slot routed to an llm: provider', { 'decide.slots.conflict.provider': 'llm:openai:gpt-4o-mini' }, ['triage']],
      ['raised action-precision gate', { 'decide.slots.triage.min_action_precision': '0.95' }, ['conflict']],
      ['decide disable --all', Object.fromEntries(DECIDE_SLOTS.map((s) => [`decide.slots.${s}.mode`, 'off'])), []],
    ];
    for (const [name, snapshot, expected] of cases) {
      const cfg = keyed(snapshot);
      expect({ name, on: onSlots(cfg).filter((s) => cfg.slots[s].keyDefault) }).toEqual({ name, on: expected });
    }
  });

  test('an explicit mode on is not a key default (the operator owns its consent)', () => {
    const cfg = keyed({ 'decide.slots.triage.mode': 'on', 'decide.provider': DEFAULT_TYPESAFE_PROVIDER });
    expect(cfg.slots.triage.mode).toBe('on');
    expect(cfg.slots.triage.keyDefault).toBeUndefined();
    expect(cfg.slots.conflict.keyDefault).toBe(true);
  });

  test('eval runs never get key defaults', () => {
    expect(onSlots(readDecideConfig({}, { typesafeKey: true, evalSlots: 'evidence=shadow' }))).toEqual(['evidence']);
    enableDecideEvalOverride(true);
    try { expect(onSlots(keyed())).toEqual([]); } finally { enableDecideEvalOverride(false); }
  });
});

describe('key defaults through the policy', () => {
  test('both slots resolve to effective on with their shipped reference calibration', () => {
    const cfg = keyed();
    for (const slot of DEFAULT_ON as Array<'triage' | 'conflict'>) {
      const ref = REFERENCE_CALIBRATIONS.find((r) => r.slot === slot)!;
      const policy = resolveSlotPolicy(inputs(cfg, slot));
      expect(policy).toMatchObject({ requested: 'on', effective: 'on', threshold: ref.threshold, thresholdSource: 'reference' });
      expect(policy.calibration?.ref).toBe(`ref:${ref.id}`);
      expect(readiness(policy, inputs(cfg, slot))).toBe('on (default: Jev key present)');
    }
  });

  test('an adopted calibration pins a default slot without making it explicit', () => {
    const ref = REFERENCE_CALIBRATIONS.find((r) => r.slot === 'conflict')!;
    const cfg = keyed({ 'decide.slots.conflict.calibration': `ref:${ref.id}` });
    expect(cfg.slots.conflict.keyDefault).toBe(true);
    expect(resolveSlotPolicy(inputs(cfg, 'conflict')).calibration?.ref).toBe(`ref:${ref.id}`);
  });

  test('a missing reference calibration leaves the slot inactive with off behavior', () => {
    const cfg = keyed();
    const policy = resolveSlotPolicy(inputs(cfg, 'triage', { references: [] }));
    expect(policy).toMatchObject({ requested: 'on', effective: 'off', inactive: 'no_calibration' });
    expect(readiness(policy, inputs(cfg, 'triage', { references: [] }))).toBe('on (default: Jev key present; inactive: no_calibration)');
  });

  test('model drift against the reference calibration demotes the call', () => {
    const policy = resolveSlotPolicy(inputs(keyed(), 'conflict'));
    expect(driftReason(policy, 'jev-1.13.0')).toBeUndefined();
    expect(driftReason(policy, 'jev-1.14.0')).toBe('model_drift');
  });
});

describe('key defaults at the egress gate', () => {
  const conversation = (ref = 't1', source_id = 'default'): DecideQuestion => ({
    id: `w:${ref}`, kind: 'noul', instructions: 'Is `window` worth synthesizing?', inputs: { window: { text: 'we decided to ship', class: 'conversation', transcript_ref: ref, source_id } },
  });
  const fact = (visibility: 'private' | 'world'): DecideQuestion => ({
    id: `f:${visibility}`, kind: 'choice', instructions: 'Pair?', options: { duplicate: 'd', supersede: 's', independent: 'i' },
    inputs: { fact: { text: 'Alice leads research', class: 'facts', fact_id: 1, visibility, source_id: 'default' } },
  });

  test('the key is the opt-in for the default slot data only', async () => {
    const cfg = keyed();
    expect((await checkEgress(null, cfg, DEFAULT_TYPESAFE_PROVIDER, {}, [conversation()], { slot: 'triage' })).refused).toEqual({});
    expect((await checkEgress(null, cfg, DEFAULT_TYPESAFE_PROVIDER, {}, [fact('private')], { slot: 'conflict' })).refused).toEqual({});
    expect((await checkEgress(null, cfg, DEFAULT_TYPESAFE_PROVIDER, {}, [fact('private')], { slot: 'triage' })).refused).toEqual({ 'f:private': 'egress_class_denied' });
    expect((await checkEgress(null, cfg, DEFAULT_TYPESAFE_PROVIDER, {}, [conversation()], { slot: 'recall_needed' })).refused).toEqual({ 'w:t1': 'egress_class_denied' });
    expect((await checkEgress(null, cfg, DEFAULT_TYPESAFE_PROVIDER, {}, [conversation()])).refused).toEqual({ 'w:t1': 'egress_class_denied' });
  });

  test('denied sources and keyless brains are refused exactly as before', async () => {
    const denied = keyed({ 'decide.egress.deny_sources': '["work"]' });
    expect((await checkEgress(null, denied, DEFAULT_TYPESAFE_PROVIDER, {}, [conversation('t2', 'work')], { slot: 'triage' })).refused).toEqual({ 'w:t2': 'denied_source' });
    const keyless = readDecideConfig({ 'decide.slots.triage.mode': 'on', 'decide.provider': DEFAULT_TYPESAFE_PROVIDER, 'decide.egress.typesafe.conversation': 'allow' });
    expect((await checkEgress(null, keyless, DEFAULT_TYPESAFE_PROVIDER, {}, [conversation()], { slot: 'triage' })).refused).toEqual({ 'w:t1': 'egress_private_denied' });
  });
});
