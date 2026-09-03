/**
 * A permanently-dead idempotency key retries, then stops.
 *
 * Guards both halves of the contract: #3306's release (one dead dispatch still
 * earns a fresh one) must keep working, and the new bound must stop the
 * unbounded re-dispatch that #3306's release leaves open.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  IDEMPOTENCY_DEAD_RETRY_LIMIT_CONFIG,
  loadConsecutiveDeadIdempotencyCount,
  parseIdempotencyDeadRetryLimit,
} from '../src/core/minions/idempotency-dead-retry.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

const kill = (id: number) =>
  engine.executeRaw(`UPDATE minion_jobs SET status = 'dead', finished_at = now() WHERE id = $1`, [id]);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // resetPgliteState truncates user config; MinionQueue's legacy schema gate
  // reads config.version rather than schema_version.
  await engine.setConfig('version', '140');
  queue = new MinionQueue(engine);
});

describe('idempotency dead-retry limit', () => {
  test('one dead dispatch still retries (#3306), the streak limit stops the next one', async () => {
    await engine.setConfig(IDEMPOTENCY_DEAD_RETRY_LIMIT_CONFIG, '2');
    const key = 'test:terminal-input';

    const first = await queue.add('test-job', { prompt: 'x' }, { idempotency_key: key });
    await kill(first.id);

    // #3306 behaviour, unchanged: the key is released and a fresh row is minted.
    const retry = await queue.add('test-job', { prompt: 'x' }, { idempotency_key: key });
    expect(retry.id).not.toBe(first.id);
    expect(retry.status).toBe('waiting');
    await kill(retry.id);

    // The new bound: at the limit the key is retained, so this submit
    // coalesces onto the dead row instead of minting a third job.
    const blocked = await queue.add('test-job', { prompt: 'x' }, { idempotency_key: key });
    expect(blocked.id).toBe(retry.id);
    expect(blocked.status).toBe('dead');
    expect(blocked.coalesced).toBe(true);
    // The returned row carries the marker, not the pre-write snapshot.
    expect(blocked.data.__idempotency_retry_blocked).toMatchObject({
      reason: 'dead_streak_limit', dead_streak: 2, limit: 2,
    });

    const rows = await engine.executeRaw<{
      id: number; idempotency_key: string | null; data: Record<string, unknown>;
    }>(`SELECT id, idempotency_key, data FROM minion_jobs ORDER BY id`);
    expect(rows).toHaveLength(2);
    expect(rows[0].idempotency_key).toBeNull();
    expect(rows[0].data.__released_idempotency_key).toBe(key);
    expect(rows[1].idempotency_key).toBe(key);
    expect(rows[1].data.__idempotency_retry_blocked).toMatchObject({
      reason: 'dead_streak_limit', dead_streak: 2, limit: 2,
    });
  });

  test('retrying the blocked job breaks the streak and frees the key again', async () => {
    await engine.setConfig(IDEMPOTENCY_DEAD_RETRY_LIMIT_CONFIG, '2');
    const key = 'test:escape-hatch';
    const first = await queue.add('test-job', {}, { idempotency_key: key });
    await kill(first.id);
    const retry = await queue.add('test-job', {}, { idempotency_key: key });
    await kill(retry.id);
    expect((await queue.add('test-job', {}, { idempotency_key: key })).status).toBe('dead');

    // `jobs retry` flips the row out of `dead`; the walk stops there.
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'waiting', finished_at = NULL WHERE id = $1`, [retry.id],
    );
    expect(await loadConsecutiveDeadIdempotencyCount(engine, key, 2)).toBe(0);
  });

  test('a non-dead outcome resets the consecutive-dead count', async () => {
    await engine.setConfig(IDEMPOTENCY_DEAD_RETRY_LIMIT_CONFIG, '2');
    const key = 'test:success-reset';
    const first = await queue.add('test-job', {}, { idempotency_key: key });
    await kill(first.id);
    const retry = await queue.add('test-job', {}, { idempotency_key: key });
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1`, [retry.id],
    );
    expect(await loadConsecutiveDeadIdempotencyCount(engine, key, 2)).toBe(0);
  });

  test('cancelled rows always release the key, whatever the streak', async () => {
    await engine.setConfig(IDEMPOTENCY_DEAD_RETRY_LIMIT_CONFIG, '2');
    const key = 'test:cancelled-releases';
    const first = await queue.add('test-job', {}, { idempotency_key: key });
    await kill(first.id);
    const retry = await queue.add('test-job', {}, { idempotency_key: key });
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1`, [retry.id],
    );
    const third = await queue.add('test-job', {}, { idempotency_key: key });
    expect(third.id).not.toBe(retry.id);
    expect(third.status).toBe('waiting');
  });

  test('invalid or unsafe limits fall back to the default and keep the one-retry floor', () => {
    expect(parseIdempotencyDeadRetryLimit(null)).toBe(3);
    expect(parseIdempotencyDeadRetryLimit('')).toBe(3);
    expect(parseIdempotencyDeadRetryLimit('not-a-number')).toBe(3);
    expect(parseIdempotencyDeadRetryLimit('1')).toBe(3);
    expect(parseIdempotencyDeadRetryLimit('250')).toBe(100);
    expect(parseIdempotencyDeadRetryLimit('5')).toBe(5);
  });
});
