import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AbandonedError, settleOrAbandon } from '../src/core/persistence/settle-or-abandon.ts';

describe('persistence consumer wiring', () => {
  test('statement-timeout follow-up and renewal waits are hard-capped', () => {
    const src = readFileSync(new URL('../src/core/persistence/consumer.ts', import.meta.url), 'utf8');
    expect(src).toContain('settleOrAbandon(followUp()');
    expect(src).toContain('settleOrAbandon(renewing');
    expect(src).toContain('statementTimeoutFollowUp');
  });
});

describe('settleOrAbandon', () => {
  test('returns the value when the work settles first', async () => {
    await expect(settleOrAbandon(Promise.resolve(7), 50)).resolves.toBe(7);
  });

  test('abandons a hung promise and clears the timer', async () => {
    const started = Date.now();
    await expect(settleOrAbandon(new Promise(() => {}), 30)).rejects.toBeInstanceOf(AbandonedError);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('propagates a rejection that beats the deadline', async () => {
    await expect(settleOrAbandon(Promise.reject(new Error('boom')), 200)).rejects.toThrow('boom');
  });

  test('a late rejection after abandon is not an unhandledRejection', async () => {
    let rejectLate: (error: unknown) => void = () => {};
    const work = new Promise<void>((_resolve, reject) => { rejectLate = reject; });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(settleOrAbandon(work, 20)).rejects.toBeInstanceOf(AbandonedError);
      rejectLate(new Error('late statement timeout'));
      await new Promise(r => setTimeout(r, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
