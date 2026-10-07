/**
 * Protects: the claim lease every consumer route prepares under (#5373). A
 * claim counts as lost the first time a renewal says it is gone, throws, or
 * overruns its deadline; `whileHeld` stops waiting on preparation at that
 * moment, and `end()` never waits on a renewal still in flight.
 *
 * Regression it catches: a renewal that never settles holding the caller
 * forever, a lost claim noticed only after preparation finishes, or a
 * healthy renewal mistaken for a loss.
 *
 * Why not covered elsewhere: the consumer suites drive this through real
 * writes; these cases pin each loss path and its negative control directly,
 * in milliseconds, with no datastore.
 */
import { describe, expect, test } from 'bun:test';
import { CLAIM_LOST, endLostLease, startClaimLease } from '../src/core/persistence/claim-lease.ts';

const FAST = { everyMs: 5, deadlineMs: 40 };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const lostWithin = (lease: { lost: Promise<void> }, ms: number) =>
  Promise.race([lease.lost.then(() => true), sleep(ms).then(() => false)]);

describe('startClaimLease', () => {
  test('healthy renewals keep the claim held and whileHeld yields the work result', async () => {
    let renewals = 0;
    const lease = startClaimLease(async () => { renewals++; return true; }, FAST);
    try {
      const result = await lease.whileHeld(sleep(80).then(() => 'prepared'));
      expect(result).toBe('prepared');
      expect(lease.held).toBe(true);
      expect(renewals).toBeGreaterThan(2);
      expect(await lostWithin(lease, 20)).toBe(false);
    } finally { lease.end(); }
  });

  test('a renewal that reports the claim gone loses it and runs onLost exactly once', async () => {
    let lostCalls = 0;
    const lease = startClaimLease(async () => false, FAST, () => { lostCalls++; });
    try {
      const never = new Promise<string>(() => {});
      expect(await lease.whileHeld(never)).toBe(CLAIM_LOST);
      expect(lease.held).toBe(false);
      await sleep(30);
      expect(lostCalls).toBe(1);
    } finally { lease.end(); }
  });

  test('a renewal that throws loses the claim', async () => {
    const lease = startClaimLease(async () => { throw new Error('connection reset'); }, FAST);
    try {
      expect(await lostWithin(lease, 1_000)).toBe(true);
      expect(lease.held).toBe(false);
    } finally { lease.end(); }
  });

  test('a renewal that never settles loses the claim at its deadline and is told to cancel', async () => {
    const signals: AbortSignal[] = [];
    const lease = startClaimLease(signal => { signals.push(signal); return new Promise<boolean>(() => {}); }, FAST);
    try {
      const started = performance.now();
      expect(await lostWithin(lease, 1_000)).toBe(true);
      expect(performance.now() - started).toBeGreaterThanOrEqual(FAST.deadlineMs - 5);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
    } finally { lease.end(); }
  });

  test('a slow renewal that still finishes inside its deadline is not a loss', async () => {
    const lease = startClaimLease(() => sleep(30).then(() => true), { everyMs: 5, deadlineMs: 1_000 });
    try {
      expect(await lostWithin(lease, 200)).toBe(false);
      expect(lease.held).toBe(true);
    } finally { lease.end(); }
  });

  test('onLost runs before anything awaiting the loss resumes', async () => {
    const order: string[] = [];
    const lease = startClaimLease(async () => false, FAST, () => order.push('onLost'));
    try {
      await lease.lost;
      order.push('awaiter');
      expect(order).toEqual(['onLost', 'awaiter']);
    } finally { lease.end(); }
  });

  test('a preparation failure propagates through whileHeld while the claim is held', async () => {
    const lease = startClaimLease(async () => true, FAST);
    try {
      await expect(lease.whileHeld(Promise.reject(new Error('prepare failed')))).rejects.toThrow('prepare failed');
      expect(lease.held).toBe(true);
    } finally { lease.end(); }
  });

  test('end() hands back the hung renewal without waiting and stops renewing', async () => {
    let renewals = 0;
    const hung = Promise.withResolvers<boolean>();
    const lease = startClaimLease(() => { renewals++; return hung.promise; }, { everyMs: 5, deadlineMs: 10_000 });
    await sleep(30);
    const inFlight = lease.end();
    expect(inFlight).toBeInstanceOf(Promise);
    expect(renewals).toBe(1);
    let settled = false;
    void inFlight!.then(() => { settled = true; });
    await sleep(20);
    expect(settled).toBe(false);
    hung.reject(new Error('late failure'));
    await inFlight;
    expect(settled).toBe(true);
    await sleep(20);
    expect(renewals).toBe(1);
  });

  test('end() with no renewal in flight returns nothing and no renewal starts afterwards', async () => {
    let renewals = 0;
    const lease = startClaimLease(async () => { renewals++; return true; }, { everyMs: 20, deadlineMs: 40 });
    expect(lease.end()).toBeUndefined();
    await sleep(60);
    expect(renewals).toBe(0);
    expect(lease.held).toBe(true);
  });

  test('endLostLease waits for the cancelled renewal to settle before the caller releases', async () => {
    const cancelled = Promise.withResolvers<void>();
    let renewing = false;
    const lease = startClaimLease(signal => {
      renewing = true;
      return new Promise<boolean>((_, reject) => signal.addEventListener('abort', () => setTimeout(() => { cancelled.resolve(); reject(new Error('canceled')); }, 40)));
    }, { everyMs: 5, deadlineMs: 15 });
    await lease.lost;
    expect(renewing).toBe(true);
    let cancelSettled = false;
    void cancelled.promise.then(() => { cancelSettled = true; });
    await endLostLease(lease);
    expect(cancelSettled).toBe(true);
  });

  test('endLostLease gives up on a renewal that never settles after its bound', async () => {
    const lease = startClaimLease(() => new Promise<boolean>(() => {}), { everyMs: 5, deadlineMs: 10 });
    await lease.lost;
    const started = performance.now();
    await endLostLease(lease, 50);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
