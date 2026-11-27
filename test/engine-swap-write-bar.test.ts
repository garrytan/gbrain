/**
 * Criterion 5's per-brain write bar (the maintainer's ruling of 2026-11-25 ~3:45 PM PST, Slack C0CJDTJG5PE thread
 * 1795647713.176099, message 1795649537.562269, ask D = D1): bar = min(1000, max(100, window_days x W)), where
 * window_days is the shadow minimum in force (5 while the opt-in override applies, until 2026-12-09 08:00 UTC, then 14)
 * and W is the brain's own qualifying writes per day, from its per-operation call counts with sampled-out calls included.
 *
 * Authoring gate (docs/TESTING.md): (1) protects criterion 5 of the swap readiness verdict and the numbers the swap
 * report shows for it. (2) Fails when the window does not follow the policy in force, when the cap or the floor is not
 * applied, when a short call history is not scaled to a per-day rate, when sampled-out or non-qualifying calls are
 * miscounted, when missing history passes, or when the report does not name the bar, the window, how W was computed
 * and the compared count. (3) The readiness test pins the other criteria; nothing else computes this bar. (4) No seam:
 * the real evaluator, policy, write-usage files in a temp directory and the real shadow wrapper over a stub engine.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { policyInForce, READINESS_POLICY } from '../src/core/engine-swap/policy.ts';
import { evaluateReadiness, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { appendWriteUsage, QUALIFYING_WRITE_OPS, readQualifyingWrites, writeBar } from '../src/shadow/write-bar.ts';
import { wrapShadowEngine, type ShadowSink } from '../src/shadow/wrapper.ts';

const DAY = 86_400_000;
const UNDER_OVERRIDE = new Date('2026-12-04T12:00:00Z');
const AFTER_OVERRIDE = new Date('2026-12-10T12:00:00Z');

/** `perDay` qualifying writes on each of the 20 UTC days before `now`, first seen 20 days earlier. */
function history(now: Date, perDay: number, days = 20): { by_day: Record<string, number>; first_seen: string } {
  const by_day: Record<string, number> = {};
  for (let i = 0; i < days; i++) by_day[new Date(now.getTime() - i * DAY).toISOString().slice(0, 10)] = perDay;
  return { by_day, first_seen: new Date(now.getTime() - days * DAY).toISOString() };
}

function doc(comparable: number, qualifying: ShadowStatus['write_comparisons'] extends infer W ? W extends { qualifying_writes?: infer Q } ? Q : never : never): ShadowStatus {
  return { write_comparisons: { state: 'measured', sample_rate: 1, comparable, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, qualifying_writes: qualifying } };
}
const criterion5 = (d: ShadowStatus, now: Date) =>
  evaluateReadiness(d, now, policyInForce(READINESS_POLICY, null, now).policy).criteria.find(c => c.n === 5)!;

describe('the per-brain write bar', () => {
  test('a 5-day window while the override applies, a 14-day window after it', () => {
    expect(writeBar(history(UNDER_OVERRIDE, 50), 5, UNDER_OVERRIDE)).toMatchObject({ window_days: 5, per_day: 50, bar: 250 });
    expect(writeBar(history(AFTER_OVERRIDE, 50), 14, AFTER_OVERRIDE)).toMatchObject({ window_days: 14, per_day: 50, bar: 700 });
    expect(criterion5(doc(250, history(UNDER_OVERRIDE, 50)), UNDER_OVERRIDE).state).toBe('pass');
    const short = criterion5(doc(249, history(UNDER_OVERRIDE, 50)), UNDER_OVERRIDE);
    expect(short.state).toBe('fail');
    expect(short.detail).toContain('249 of 250 compared writes');
    expect(short.detail).toContain('5-day window');
    expect(short.detail).toContain('50.0 qualifying writes a day');
    const after = criterion5(doc(250, history(AFTER_OVERRIDE, 50)), AFTER_OVERRIDE);
    expect(after.state).toBe('fail');
    expect(after.detail).toContain('250 of 700 compared writes');
    expect(after.detail).toContain('14-day window');
  });

  test('the cap is 1,000 and the floor 100; below the floor the check stays closed', () => {
    expect(writeBar(history(UNDER_OVERRIDE, 500), 5, UNDER_OVERRIDE).bar).toBe(1000);
    expect(writeBar(history(AFTER_OVERRIDE, 500), 14, AFTER_OVERRIDE).bar).toBe(1000);
    expect(writeBar(history(UNDER_OVERRIDE, 5), 5, UNDER_OVERRIDE).bar).toBe(100);
    expect(writeBar({ by_day: {}, first_seen: new Date(UNDER_OVERRIDE.getTime() - 20 * DAY).toISOString() }, 5, UNDER_OVERRIDE).bar).toBe(100);
    expect(criterion5(doc(1000, history(UNDER_OVERRIDE, 500)), UNDER_OVERRIDE).state).toBe('pass');
    expect(criterion5(doc(999, history(UNDER_OVERRIDE, 500)), UNDER_OVERRIDE).state).toBe('fail');
    const floor = criterion5(doc(99, history(UNDER_OVERRIDE, 5)), UNDER_OVERRIDE);
    expect(floor.state).toBe('fail');
    expect(floor.detail).toContain('99 of 100 compared writes');
    expect(criterion5(doc(100, history(UNDER_OVERRIDE, 5)), UNDER_OVERRIDE).state).toBe('pass');
    // Zero unexplained differences, as before.
    const d = doc(1000, history(UNDER_OVERRIDE, 500));
    d.write_comparisons!.unexplained_difference = 1;
    expect(criterion5(d, UNDER_OVERRIDE).state).toBe('fail');
  });

  test('a call history shorter than the window is scaled to writes a day; no history is missing evidence', () => {
    const now = UNDER_OVERRIDE;
    const twoDays = { by_day: { [now.toISOString().slice(0, 10)]: 60, [new Date(now.getTime() - DAY).toISOString().slice(0, 10)]: 40 }, first_seen: new Date(now.getTime() - 2 * DAY).toISOString() };
    expect(writeBar(twoDays, 5, now)).toMatchObject({ covered_days: 2, writes_in_window: 100, per_day: 50, bar: 250 });
    const missing = criterion5({ write_comparisons: { state: 'measured', sample_rate: 1, comparable: 5000, unexplained_difference: 0, uncomparable: 0, capability_missing: 0 } }, now);
    expect(missing.state).toBe('missing');
  });
});

describe('a bar the compared writes do not reach: the reason and the counts', () => {
  /** A 5-day epoch of `perDay` qualifying writes, `inTx` of them each day inside a transaction (never comparable). */
  function epoch(perDay: number, inTx: number, compared: number, extra: Partial<NonNullable<ShadowStatus['write_comparisons']>> = {}): ShadowStatus {
    const h = history(UNDER_OVERRIDE, perDay);
    const in_transaction_by_day = Object.fromEntries(Object.keys(h.by_day).map(d => [d, inTx]));
    return {
      epoch_started_at: new Date(UNDER_OVERRIDE.getTime() - 5 * DAY).toISOString(),
      write_comparisons: { state: 'measured', sample_rate: 1, comparable: compared, unexplained_difference: 0, uncomparable: 0, capability_missing: 0,
        qualifying_writes: { ...h, in_transaction_by_day }, ...extra },
    };
  }

  test('pin: a brain with 5,000 of its own writes in the window needs the 1,000 cap', () => {
    const h = history(UNDER_OVERRIDE, 1000);
    expect(writeBar(h, 5, UNDER_OVERRIDE)).toMatchObject({ writes_in_window: 5000, bar: 1000 });
    expect(criterion5(doc(999, h), UNDER_OVERRIDE).state).toBe('fail');
    expect(criterion5(doc(1000, h), UNDER_OVERRIDE).state).toBe('pass');
  });

  test('writes that cannot be compared are named and counted, and the plan says when the bar is reached at this share', () => {
    // 50 a day, 20 of them inside a transaction: 30 a day can be compared, so 150 in 5 days, short of the 250 bar.
    const row = criterion5(epoch(50, 20, 150, { uncomparable: 4, capability_missing: 6 }), UNDER_OVERRIDE);
    expect(row.state).toBe('fail');
    expect(row.detail).toContain('150 of 250 compared writes');
    expect(row.detail).toContain('write_bar_not_reached');
    expect(row.detail).toContain('in a transaction 100');
    expect(row.detail).toContain('uncomparable 4');
    expect(row.detail).toContain('capability_missing 6');
    expect(row.detail).toMatch(/reached after about 8\.3 days of shadow/);
  });

  test('a brain none of whose writes can be compared is named unreachable, and never passes', () => {
    const row = criterion5(epoch(50, 50, 0), UNDER_OVERRIDE);
    expect(row.state).toBe('fail');
    expect(row.detail).toContain('write_bar_unreachable');
    expect(row.detail).toContain('in a transaction 250');
  });

  test('a call inside a transaction is counted in W and as in a transaction', async () => {
    const noted: Array<[string, string]> = [];
    const tx = { kind: 'pglite', putPage: async () => ({}) } as unknown as BrainEngine;
    const stub = { kind: 'pglite', putPage: async () => ({}), transaction: async (fn: (t: BrainEngine) => Promise<unknown>) => fn(tx) } as unknown as BrainEngine;
    const sink: ShadowSink = { counters: {} as never, offer: () => undefined, active: () => true, noteWrite: (op: string, inTx?: boolean) => { noted.push([op, inTx ? 'tx' : 'out']); } };
    const wrapped = wrapShadowEngine(stub, sink, { sampleRate: 0 });
    await wrapped.putPage('a', {} as never);
    await wrapped.transaction(async (t) => { await t.putPage('b', {} as never); });
    expect(noted).toEqual([['putPage', 'out'], ['putPage', 'tx']]);
  });
});

describe('qualifying writes are counted from the brain\'s own call counts, sampled-out calls included', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  test('every call of a qualifying write counts, sampled out or not; other operations do not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-write-bar-'));
    dirs.push(dir);
    const now = new Date('2026-12-04T12:00:00Z');
    appendWriteUsage(dir, { ts: '2026-12-03T10:00:00.000Z', epoch_id: 'e0', ops: { putPage: { offered: 10, sampled_out: 9, shed: 0, skipped_in_transaction: 0, unmirrorable: 0 } } });
    appendWriteUsage(dir, { ts: '2026-12-04T10:00:00.000Z', epoch_id: 'e1', ops: { addLinksBatch: { offered: 3, sampled_out: 3, shed: 0, skipped_in_transaction: 0, unmirrorable: 0 }, putRawData: { offered: 7, sampled_out: 0, shed: 0, skipped_in_transaction: 0, unmirrorable: 0 } } });
    const got = readQualifyingWrites(dir, now)!;
    expect(got.by_day).toEqual({ '2026-12-03': 10, '2026-12-04': 3 });
    expect(got.in_transaction_by_day).toEqual({});
    expect(got.first_seen).toBe('2026-12-03T10:00:00.000Z');
    expect([...QUALIFYING_WRITE_OPS]).toEqual(['putPage', 'deletePage', 'addLink', 'addLinksBatch', 'removeLink']);
  });

  test('the shadow wrapper notes each qualifying write call, however few reads it mirrors', async () => {
    const noted: string[] = [];
    const stub = { kind: 'pglite', putPage: async () => ({}), addLinksBatch: async () => 1, getPage: async () => null, putRawData: async () => undefined } as unknown as BrainEngine;
    const sink: ShadowSink = { counters: {} as never, offer: () => undefined, active: () => true, noteWrite: (op: string) => { noted.push(op); } };
    const wrapped = wrapShadowEngine(stub, sink, { sampleRate: 0 });
    await wrapped.putPage('a', {} as never);
    await wrapped.putPage('b', {} as never);
    await wrapped.addLinksBatch([] as never);
    await wrapped.getPage('a');
    await (wrapped as unknown as { putRawData: (...a: unknown[]) => Promise<void> }).putRawData('a', 's', {});
    expect(noted).toEqual(['putPage', 'putPage', 'addLinksBatch']);
  });
});
