/**
 * Shipped reference calibrations: only recorded wins, harmful rows pass the
 * action-precision gate, each row's pack_shape is the one its call site
 * sends, and a fresh brain with the slot on resolves the row to effective
 * `on` (policy fingerprint matches, no drift) using the row's threshold (and,
 * for S9, its proposal floor).
 */
import { describe, expect, test } from 'bun:test';
import { REFERENCE_CALIBRATIONS } from '../../src/core/ai/decide/reference-calibrations.ts';
import { readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { packShape } from '../../src/core/ai/decide/pack.ts';
import { resolveSlotPolicy } from '../../src/core/ai/decide/policy.ts';
import { SLOT_SPECS } from '../../src/core/ai/decide/slots.ts';
import { cycleSlotPackShape } from '../../src/core/cycle/decide-slot.ts';

const shapeFor = (slot: string): string => (slot === 'triage' || slot === 'grounding' ? cycleSlotPackShape(slot) : packShape(slot as never));

describe('reference calibrations', () => {
  test('ids are unique and every row is a recorded win', () => {
    expect(new Set(REFERENCE_CALIBRATIONS.map((r) => r.id)).size).toBe(REFERENCE_CALIBRATIONS.length);
    for (const r of REFERENCE_CALIBRATIONS) expect(r.verdict).toBe('win');
  });

  test('harmful-direction rows pass the default 0.90 action-precision gate and carry a fingerprint', () => {
    for (const r of REFERENCE_CALIBRATIONS.filter((x) => SLOT_SPECS[x.slot].harmful)) {
      expect(r.action_precision_lb).not.toBeNull();
      expect(r.action_precision_lb!).toBeGreaterThanOrEqual(0.9);
      expect(r.policy_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  test('pack shape matches what the call site sends', () => {
    for (const r of REFERENCE_CALIBRATIONS) expect(r.pack_shape).toBe(shapeFor(r.slot));
  });

  test('a fresh brain with the slot on resolves the reference row to effective on', () => {
    for (const r of REFERENCE_CALIBRATIONS) {
      const cfg = readDecideConfig({ 'decide.provider': r.provider, [`decide.slots.${r.slot}.mode`]: 'on', [`decide.slots.${r.slot}.calibration`]: `ref:${r.id}` });
      const policy = resolveSlotPolicy({ cfg, slot: r.slot, callSite: r.call_site, packShape: r.pack_shape, calibrations: [], hasTypesafeKey: true });
      expect(policy.effective).toBe('on');
      expect(policy.threshold).toBe(r.threshold);
      expect(policy.calibration?.ref).toBe(`ref:${r.id}`);
      if (r.proposal_floor !== undefined) expect(policy.calibration?.proposal_floor).toBe(r.proposal_floor);
    }
  });
});
