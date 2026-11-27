/**
 * The opt-in swap's short shadow (the maintainer's ruling of 2026-11-25 3:20 PM PST, Slack C0CJDTJG5PE message
 * 1795648831.786269): the opt-in swap opens Thu 2026-12-03, criterion 1's minimum shadow duration is 5 days for EVERY
 * brain that opts in, and the override expires at the end of Tue 2026-12-08 PST; after that 14 days stand again.
 *
 * Authoring gate (docs/TESTING.md): (1) protects criterion 1 of the swap readiness verdict during the short-shadow
 * window: which brains get 5 days, until when, and that shadow days still count only on the exact Rust build.
 * (2) Fails when the override applies to one brain only, when it still applies after the end of Dec 8 PST or stops
 * before it, when the verdict ignores the policy in force, when a renamed or re-dated override restarts a running
 * shadow clock (the evidence epoch must not move), or when a new Rust build keeps the old epoch's days. (3) The policy
 * freeze test pins the hash; nothing else checks the override's reach or end. (4) No seam: the shipped policy, the
 * real evaluator, and a real evidence epoch in a temp directory.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyHash, policyInForce, READINESS_POLICY } from '../src/core/engine-swap/policy.ts';
import { evaluateReadiness, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { ensureEpoch, type EpochInputs } from '../src/shadow/evidence-epoch.ts';

/** The end of Tue 2026-12-08 in Pacific time (PST, UTC-8). */
const END_OF_DEC_8_PST = '2026-12-09T08:00:00.000Z';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ANOTHER = '22222222-2222-4222-8222-222222222222';

function doc(startedAt: string): ShadowStatus {
  return {
    epoch_id: 'e1', epoch_started_at: startedAt,
    follower: { state: 'following', lag_ms: 0, lag_ms_p99_24h: 900, lag_ms_p99_epoch: 1200, queue_depth: 0, applied_rows: 5000, coverage_watermark: { valid: true, through: 'x', invalidated_reason: null } },
    reconcile: { state: 'idle', consecutive_clean_full_passes: 3 },
    seed: { seed_id: 's', finished_at: startedAt, unseeded_gap_rows_total: 0 },
  };
}
const criterion1 = (d: ShadowStatus, now: Date, brainId: string | null) =>
  evaluateReadiness(d, now, policyInForce(READINESS_POLICY, brainId, now).policy).criteria.find(c => c.n === 1)!;

describe('the opt-in short shadow: 5 days for every opt-in brain until the end of Dec 8 PST', () => {
  test('the shipped override no longer names Dec 1, covers every opt-in brain and quotes the Nov 25 ruling', () => {
    const o = READINESS_POLICY.overrides![0]!;
    expect(o.id).not.toContain('dec1');
    expect(o.applies_to).toBe('every_opt_in_brain');
    expect(o.shadow_min).toEqual({ kind: 'days', days: 5 });
    expect(o.expires).toBe(END_OF_DEC_8_PST);
    expect(o.ruling.place).toContain('1795648831.786269');
  });

  test('a brain that is not the owner\'s gets 5 days too, and so does a brain with no persistence identity', () => {
    const now = new Date('2026-12-03T17:00:00Z');
    for (const id of [OWNER, ANOTHER, null]) {
      const p = policyInForce(READINESS_POLICY, id, now);
      expect({ id, applies: p.override?.applies, days: p.policy.shadow_min }).toEqual({ id, applies: true, days: { kind: 'days', days: 5, expires: END_OF_DEC_8_PST } });
      expect(p.text).toContain('5 days');
    }
    // 5.5 days in the epoch passes criterion 1 for a non-owner brain; 4.5 days does not.
    expect(criterion1(doc('2026-11-28T05:00:00Z'), now, ANOTHER).state).toBe('pass');
    const short = criterion1(doc('2026-11-29T05:00:00Z'), now, ANOTHER);
    expect(short.state).toBe('fail');
    expect(short.detail).toContain('of 5 days');
  });

  test('the override ends at the end of Dec 8 PST: 14 days stand from that instant on', () => {
    const last = new Date(Date.parse(END_OF_DEC_8_PST) - 1);
    const after = new Date(END_OF_DEC_8_PST);
    expect(policyInForce(READINESS_POLICY, ANOTHER, last).override?.applies).toBe(true);
    const p = policyInForce(READINESS_POLICY, ANOTHER, after);
    expect(p.override).toMatchObject({ applies: false, why: 'expired' });
    // Six days in the epoch passes at the last instant of Dec 8 PST and fails one millisecond later, against 14 days.
    const six = doc(new Date(Date.parse(END_OF_DEC_8_PST) - 6 * 86_400_000).toISOString());
    expect(criterion1(six, last, ANOTHER).state).toBe('pass');
    const late = criterion1(six, after, ANOTHER);
    expect(late.state).toBe('fail');
    expect(late.detail).toContain('of 14 days');
    // Late on Dec 8 PST (still Dec 8 locally, already Dec 9 in UTC) the override still applies.
    expect(policyInForce(READINESS_POLICY, ANOTHER, new Date('2026-12-09T07:30:00Z')).override?.applies).toBe(true);
  });

  test('every other criterion still gates: a 5-day epoch with a lagging follower fails criterion 1', () => {
    const now = new Date('2026-12-04T00:00:00Z');
    const d = doc('2026-11-28T00:00:00Z');
    d.follower!.lag_ms_p99_epoch = 90_000;
    expect(criterion1(d, now, ANOTHER).state).toBe('fail');
    expect(evaluateReadiness(d, now, policyInForce(READINESS_POLICY, ANOTHER, now).policy).verdict).toBe('NOT READY');
  });
});

describe('shadow days count only on the exact Rust build', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const inputs = (addon: string): EpochInputs => ({
    seed_id: 's', rust_addon_sha256: addon, comparator_version: 1, adapter_version: 'a1', capability_set_hash: 'caps',
    readiness_policy_hash: policyHash(READINESS_POLICY),
  });

  test('a new Rust build opens a new epoch, and criterion 1 counts its days from the new start, override or not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-policy-dec3-'));
    dirs.push(dir);
    const first = ensureEpoch(dir, inputs('a'.repeat(64)), Date.parse('2026-11-27T00:00:00Z'));
    const same = ensureEpoch(dir, inputs('a'.repeat(64)), Date.parse('2026-12-02T00:00:00Z'));
    expect(same.epoch_id).toBe(first.epoch_id);
    const rebuilt = ensureEpoch(dir, inputs('b'.repeat(64)), Date.parse('2026-12-02T00:00:00Z'));
    expect(rebuilt.epoch_id).not.toBe(first.epoch_id);
    expect(rebuilt.started_at).toBe('2026-12-02T00:00:00.000Z');
    const now = new Date('2026-12-04T00:00:00Z');
    expect(criterion1(doc(first.started_at), now, ANOTHER).state).toBe('pass');
    expect(criterion1(doc(rebuilt.started_at), now, ANOTHER).state).toBe('fail');
  });

  test('renaming or re-dating the override leaves the evidence epoch input unchanged, so no running shadow restarts', () => {
    const o = READINESS_POLICY.overrides![0]!;
    const before = policyHash(READINESS_POLICY);
    expect(policyHash({ ...READINESS_POLICY, overrides: [{ ...o, id: 'renamed', expires: '2027-01-01T00:00:00.000Z' }] })).toBe(before);
    expect(policyHash({ ...READINESS_POLICY, overrides: [] })).toBe(before);
  });
});
