/**
 * The freshness token's text and its comparison (src/shadow/checks.ts): transaction ids are xid8 (an epoch and a 32-bit xid) and are kept
 * and compared whole, as BigInt, so a snapshot in a later epoch is never mistaken for an earlier one with the same low 32 bits.
 */
import { describe, expect, test } from 'bun:test';
import { composeToken, parseToken, widenXid, xmaxMoved } from '../src/shadow/checks.ts';
import { untilNotMoved } from './helpers/shadow-stable-harness.ts';

const RANGE = 4294967296n;

describe('freshness token with transaction ids past the first epoch', () => {
  test('the same low 32 bits in another epoch is a different xmax; values past 2^53 stay exact', () => {
    const a = 5n * RANGE + 100n;
    expect(xmaxMoved(a, a)).toBe(false);
    expect(xmaxMoved(a, 6n * RANGE + 100n)).toBe(true); // a 32-bit comparison would call these equal
    expect(xmaxMoved(2n ** 53n, 2n ** 53n + 1n)).toBe(true); // a Number comparison would call these equal
    expect(xmaxMoved(a, a + 1n)).toBe(true);
    expect(xmaxMoved(a, a - 1n)).toBe(true);
  });

  test('a token round-trips with epochs above zero, sorted and without repeats, and a blind token stays blind', () => {
    const xmax = 7n * RANGE + 12n;
    const token = composeToken(xmax, [7n * RANGE + 9n, 6n * RANGE + 4294967290n, 7n * RANGE + 9n], false);
    expect(token).toBe(`${xmax}|${6n * RANGE + 4294967290n},${7n * RANGE + 9n}`);
    expect(parseToken(token)).toEqual({ xmax, xids: [6n * RANGE + 4294967290n, 7n * RANGE + 9n], blind: false });
    expect(parseToken(composeToken(xmax, [], false))).toEqual({ xmax, xids: [], blind: false });
    expect(composeToken(xmax, [1n], true)).toBe(`${xmax}|!`);
    expect(parseToken(`${xmax}|!`)).toEqual({ xmax, xids: [], blind: true });
  });

  test('text that is not a token is never parsed', () => {
    for (const bad of [undefined, '', 'x', '123', '|', '12|a', '12|1,,2', '-1|', '1.5|3', '0/16B3748|']) expect(parseToken(bad)).toBeNull();
  });

  test('a session\'s 32-bit xid takes the epoch of the snapshot, the neighbouring one across a wrap', () => {
    const mid = 3n * RANGE + 1000n;
    expect(widenXid(990n, mid)).toBe(3n * RANGE + 990n);
    expect(widenXid(1005n, mid)).toBe(3n * RANGE + 1005n); // at or above xmax: a transaction that began after the last one finished
    expect(widenXid(4294967290n, 3n * RANGE + 5n)).toBe(3n * RANGE - 6n); // still running from the epoch before
    expect(widenXid(3n, 3n * RANGE - 5n)).toBe(3n * RANGE + 3n); // already in the next epoch
    expect(widenXid(10n, 10n)).toBe(10n); // epoch zero
    expect(widenXid(0n, 2n ** 53n + 2n ** 32n - (2n ** 53n % RANGE))).toBe(2n ** 53n + 2n ** 32n - (2n ** 53n % RANGE)); // exact beyond Number precision
  });
});

describe('asking a positive outcome again when an unrelated commit moved it', () => {
  test('a moved result or an error coded moved is asked again, up to 5 times; any other error goes straight out', async () => {
    let calls = 0;
    expect(await untilNotMoved(async () => ++calls, (n) => n < 3)).toBe(3);
    calls = 0;
    expect(await untilNotMoved(async () => { if (++calls < 5) throw Object.assign(new Error('moved'), { code: 'moved' }); return 'ok'; })).toBe('ok');
    calls = 0;
    await expect(untilNotMoved(async () => ++calls, () => true)).rejects.toThrow('moved on all 5 attempts');
    expect(calls).toBe(5);
    calls = 0;
    await expect(untilNotMoved(async () => { calls++; throw Object.assign(new Error('x'), { code: 'broken' }); })).rejects.toThrow('x');
    expect(calls).toBe(1);
  });
});
