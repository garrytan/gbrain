/**
 * The dated criterion-1 override (docs/designs/RUST_ENGINE.md "Swap readiness"): a shorter minimum shadow duration
 * that holds for one brain until its expiry date, then the 14-day rule stands again. It never applies to another
 * brain, after its expiry, or to a brain whose identity is unknown, and it never relaxes any other criterion.
 */
import { describe, expect, test } from 'bun:test';
import {
  brainRefFor, DEFAULT_SHADOW_MIN_DAYS, policyInForce, READINESS_POLICY, type ReadinessPolicy,
} from '../src/core/engine-swap/policy.ts';
import { evaluateReadiness } from '../src/core/engine-swap/readiness.ts';
import { readinessReadyFor } from './helpers/swap-ready-status.ts';

const BRAIN_A = '11111111-1111-4111-8111-111111111111';
const BRAIN_B = '22222222-2222-4222-8222-222222222222';
const SHIPPED = READINESS_POLICY.overrides?.[0];

/** The shipped override, bound to brain A for the test (the shipped entry names the maintainer's brain). */
function boundTo(brainId: string): ReadinessPolicy {
  return { ...READINESS_POLICY, overrides: [{ ...SHIPPED!, brain_ref: brainRefFor(brainId) }] };
}

/** Six days of shadowing before `now`, every other criterion passing. */
function sixDaysBefore(now: Date) {
  const doc = readinessReadyFor();
  doc.epoch_started_at = new Date(now.getTime() - 6 * 86_400_000).toISOString();
  return doc;
}

const criterion1 = (policy: ReadinessPolicy, brainId: string | null, now: Date) => {
  const inForce = policyInForce(policy, brainId, now);
  return { inForce, row: evaluateReadiness(sixDaysBefore(now), now, inForce.policy).criteria.find(c => c.n === 1)! };
};

describe('the dated criterion-1 override', () => {
  test('the shipped policy carries the ruling: five days, an expiry date, the words, the time and the place', () => {
    expect(SHIPPED).toBeDefined();
    expect(SHIPPED!.shadow_min).toEqual({ kind: 'days', days: 5 });
    expect(Number.isFinite(Date.parse(SHIPPED!.expires))).toBe(true);
    expect(SHIPPED!.ruling.words).toBe('Do it');
    expect(SHIPPED!.ruling.place).toContain('C0CJDTJG5PE');
    expect(SHIPPED!.ruling.at).toContain('2026-11-21');
    // The default for every other brain stays the design's 14 days.
    expect(READINESS_POLICY.shadow_min).toEqual({ kind: 'days', days: DEFAULT_SHADOW_MIN_DAYS });
  });

  test('applies to its brain before the expiry: six days of shadowing pass criterion 1', () => {
    const now = new Date(Date.parse(SHIPPED!.expires) - 86_400_000);
    const { inForce, row } = criterion1(boundTo(BRAIN_A), BRAIN_A, now);
    expect(inForce.override).toMatchObject({ id: SHIPPED!.id, applies: true });
    expect(row.state).toBe('pass');
    expect(inForce.text).toContain('"Do it"');
    expect(inForce.text).toContain(SHIPPED!.expires);
  });

  test('does not apply to another brain: 14 days stand', () => {
    const now = new Date(Date.parse(SHIPPED!.expires) - 86_400_000);
    const { inForce, row } = criterion1(boundTo(BRAIN_A), BRAIN_B, now);
    expect(inForce.override).toMatchObject({ applies: false, why: 'another_brain' });
    expect(row.state).toBe('fail');
    expect(row.detail).toContain(`of ${DEFAULT_SHADOW_MIN_DAYS} days`);
  });

  test('does not apply after its expiry, even to its own brain: 14 days stand', () => {
    const now = new Date(Date.parse(SHIPPED!.expires) + 1000);
    const { inForce, row } = criterion1(boundTo(BRAIN_A), BRAIN_A, now);
    expect(inForce.override).toMatchObject({ applies: false, why: 'expired' });
    expect(row.state).toBe('fail');
    expect(row.detail).toContain(`of ${DEFAULT_SHADOW_MIN_DAYS} days`);
  });

  test('does not apply when the brain identity is unknown', () => {
    const now = new Date(Date.parse(SHIPPED!.expires) - 86_400_000);
    const { inForce, row } = criterion1(boundTo(BRAIN_A), null, now);
    expect(inForce.override).toMatchObject({ applies: false, why: 'unknown_brain' });
    expect(row.state).toBe('fail');
  });

  test('never relaxes another criterion: a privacy difference still refuses under the override', () => {
    const now = new Date(Date.parse(SHIPPED!.expires) - 86_400_000);
    const { policy } = policyInForce(boundTo(BRAIN_A), BRAIN_A, now);
    const doc = sixDaysBefore(now);
    doc.privacy_diverged = 1;
    const verdict = evaluateReadiness(doc, now, policy);
    expect(verdict.verdict).toBe('NOT READY');
    expect(verdict.criteria.find(c => c.n === 1)!.state).toBe('pass');
  });

  test('the policy hash changes when the override applies, so an approved plan cannot carry it to another brain', () => {
    const now = new Date(Date.parse(SHIPPED!.expires) - 86_400_000);
    const a = policyInForce(boundTo(BRAIN_A), BRAIN_A, now);
    const b = policyInForce(boundTo(BRAIN_A), BRAIN_B, now);
    expect(a.hash).not.toBe(b.hash);
  });
});
