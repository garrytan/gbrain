/**
 * The readiness policy is frozen for the opt-in swap (opens 2026-12-03) (docs/designs/RUST_ENGINE.md "Swap readiness").
 *
 * Authoring gate (docs/TESTING.md): (1) protects the shadow evidence epoch: the shadow's evidence manifest includes
 * `policyHash()`, so any change to the policy version, criterion 1's minimum duration or the list of checks no policy
 * can waive starts a new epoch and restarts every opt-in brain's 5-day shadow clock. (2) Fails when that hash changes, when
 * `brain_ref` (or anything else in an override) becomes an input to it, or when the shipped override or the
 * unwaivable list changes. (3) Nothing else pins the hash. (4) No seam: the shipped module, real hashing.
 *
 * Changing an expected value here needs the requester's approval first: it restarts the shadow clock.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  brainRefFor, DEFAULT_SHADOW_MIN_DAYS, policyHash, READINESS_POLICY, UNWAIVABLE, type ReadinessPolicy,
} from '../src/core/engine-swap/policy.ts';

/** The frozen value. Recompute only with approval: a new value is a new evidence epoch. */
const FROZEN_POLICY_HASH = '69c02b309b037f6b';

describe('the frozen readiness policy', () => {
  test('policyHash() of the shipped policy is the frozen value', () => {
    expect(policyHash(READINESS_POLICY)).toBe(FROZEN_POLICY_HASH);
  });

  test('the hash covers exactly the version, criterion 1 duration and the unwaivable list', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify({ v: 1, shadow_min: { kind: 'days', days: 14 }, unwaivable: [...UNWAIVABLE] }))
      .digest('hex').slice(0, 16);
    expect(policyHash(READINESS_POLICY)).toBe(expected);
    expect(READINESS_POLICY.version).toBe(1);
    expect(READINESS_POLICY.shadow_min).toEqual({ kind: 'days', days: DEFAULT_SHADOW_MIN_DAYS });
    expect(DEFAULT_SHADOW_MIN_DAYS).toBe(14);
    expect([...UNWAIVABLE]).toEqual(['privacy', 'fingerprints', 'topology', 'platform', 'capabilities', 'recovery_drills', 'caught_up_following', 'final_digests']);
  });

  test('brain_ref is not an input: binding the override to a brain leaves the hash unchanged', () => {
    const shipped = READINESS_POLICY.overrides![0]!;
    expect(shipped.applies_to).toBe('every_opt_in_brain');
    for (const id of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
      const bound: ReadinessPolicy = { ...READINESS_POLICY, overrides: [{ ...shipped, applies_to: 'brain', brain_ref: brainRefFor(id) }] };
      expect(policyHash(bound)).toBe(FROZEN_POLICY_HASH);
    }
    expect(policyHash({ ...READINESS_POLICY, overrides: [] })).toBe(FROZEN_POLICY_HASH);
  });

  test('the hash moves when a frozen input moves, so the pin is not vacuous', () => {
    expect(policyHash({ ...READINESS_POLICY, shadow_min: { kind: 'days', days: 13 } })).not.toBe(FROZEN_POLICY_HASH);
  });

  test('the shipped override is the Nov 25 ruling: five days for every opt-in brain, until the end of 2026-12-08 PST', () => {
    const o = READINESS_POLICY.overrides![0]!;
    expect(o.id).toBe('c1-opt-in-short-shadow');
    expect(o.applies_to).toBe('every_opt_in_brain');
    expect(o.shadow_min).toEqual({ kind: 'days', days: 5 });
    expect(o.expires).toBe('2026-12-09T08:00:00.000Z');
    expect(o.ruling.words).toBe('Do it');
  });
});
