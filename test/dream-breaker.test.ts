/**
 * Dream paid-loop breaker: released-key recording, the shared dead-submission
 * counter, persisted resets, the fail-open posture, and the #5590 boundary
 * (a legitimate zero-write completion never counts; a real zero-write
 * failure still dead-letters and does).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { UnrecoverableError } from '../src/core/minions/types.ts';
import { finalizeWriteAccounting } from '../src/core/minions/handlers/subagent-persistence.ts';
import {
  countDeadDreamSubmissions, dreamBreakerRefusal, loadDreamBreaker, resetDreamBreakerKey, DREAM_BREAKER_CONFIG_KEY,
} from '../src/core/cycle/dream-breaker.ts';
import { dreamPaidLoopCheck } from '../src/commands/doctor/checks/dream-breaker.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

const KEY = 'dream:synth-v2:default:filename:loop.txt:0123456789abcdef';

async function seedJob(opts: { key: string; status: string; queue: string; hoursAgo?: number; released?: boolean }, target: PGLiteEngine = engine): Promise<void> {
  await target.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, idempotency_key, created_at, finished_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', $1, $2, $3::text::jsonb, $4,
             now() - ($5 || ' hours')::interval, now() - ($5 || ' hours')::interval)`,
    [opts.queue, opts.status, JSON.stringify(opts.released ? { source_id: 'default', __released_idempotency_key: opts.key } : { source_id: 'default' }),
      opts.released ? null : opts.key, String(opts.hoursAgo ?? 1)],
  );
}

describe('queue key release', () => {
  test('re-submitting a dead key records the released key in the dead row', async () => {
    const queue = new MinionQueue(engine);
    const first = await queue.add('breaker-probe', { n: 1 }, { idempotency_key: KEY });
    await engine.executeRaw(`UPDATE minion_jobs SET status='dead', finished_at=now() WHERE id=$1`, [first.id]);
    const second = await queue.add('breaker-probe', { n: 2 }, { idempotency_key: KEY });
    expect(second.id).not.toBe(first.id);
    const [dead] = await engine.executeRaw<{ idempotency_key: string | null; released: string | null; n: string }>(
      `SELECT idempotency_key, data->>'__released_idempotency_key' AS released, data->>'n' AS n FROM minion_jobs WHERE id=$1`, [first.id]);
    expect(dead).toEqual({ idempotency_key: null, released: KEY, n: '1' });
  });
});

describe('dead-submission counter', () => {
  test('counts distinct runs by finish time, live or released keys, chunks of one run once', async () => {
    await seedJob({ key: `${KEY}:c0of2`, status: 'dead', queue: 'dream-inline-1' });
    await seedJob({ key: `${KEY}:c1of2`, status: 'dead', queue: 'dream-inline-1', released: true });
    await seedJob({ key: KEY, status: 'dead', queue: 'dream-inline-2', released: true });
    await seedJob({ key: KEY, status: 'dead', queue: 'dream-inline-3', hoursAgo: 30, released: true });
    await seedJob({ key: 'unrelated:key', status: 'dead', queue: 'dream-inline-4' });
    expect(await countDeadDreamSubmissions(engine)).toEqual([
      expect.objectContaining({ base_key: KEY, dead_submissions: 2 }),
    ]);
  });

  test('the third dead submission trips the key; completed zero-write jobs never count', async () => {
    for (const [i, queue] of ['q1', 'q2', 'q3'].entries()) await seedJob({ key: `${KEY}:c${i}of3`, status: 'completed', queue });
    expect((await loadDreamBreaker(engine))!.tripped.size).toBe(0);
    for (const queue of ['d1', 'd2']) await seedJob({ key: KEY, status: 'dead', queue, released: true });
    const breaker = (await loadDreamBreaker(engine))!;
    expect(dreamBreakerRefusal(breaker, KEY)).toBeNull();
    await seedJob({ key: KEY, status: 'dead', queue: 'd3', released: true });
    const tripped = (await loadDreamBreaker(engine))!;
    expect(dreamBreakerRefusal(tripped, KEY)).toContain(`gbrain dream reset-key '${KEY}'`);
  });

  test('the threshold is configurable and 0 disables the breaker', async () => {
    for (const queue of ['d1', 'd2']) await seedJob({ key: KEY, status: 'dead', queue, released: true });
    await engine.setConfig(DREAM_BREAKER_CONFIG_KEY, '2');
    expect((await loadDreamBreaker(engine))!.tripped.get(KEY)).toBe(2);
    await engine.setConfig(DREAM_BREAKER_CONFIG_KEY, '0');
    expect(await loadDreamBreaker(engine)).toBeNull();
  });

  test('concurrent resets of different keys both persist', async () => {
    const other = KEY.replace('loop.txt', 'other.txt');
    for (const key of [KEY, other]) {
      await seedJob({ key, status: 'dead', queue: 'd1' });
      for (const queue of ['d2', 'd3']) await seedJob({ key, status: 'dead', queue, released: true });
    }
    expect((await loadDreamBreaker(engine))!.tripped.size).toBe(2);
    await Promise.all([resetDreamBreakerKey(engine, KEY), resetDreamBreakerKey(engine, other)]);
    expect(Object.keys(JSON.parse((await engine.getConfig('dream.breaker.resets'))!)).sort()).toEqual([KEY, other].sort());
    expect((await loadDreamBreaker(engine))!.tripped.size).toBe(0);
  });

  test('a failing count query leaves the breaker off for the run', async () => {
    const broken = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return async () => { throw new Error('pool reaped'); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await loadDreamBreaker(broken)).toBeNull();
  });
});

describe('#5590 boundary', () => {
  test('a real zero-write failure still dead-letters, and that death counts', async () => {
    const proseOnly = { result: 'I will write the page next.', turns_count: 1, stop_reason: 'end_turn' as const,
      tokens: { in: 1, out: 1, cache_read: 0, cache_create: 0 } };
    const failure = await finalizeWriteAccounting(engine, 999_999, proseOnly, { requireWrites: true }).catch(error => error);
    expect(failure).toBeInstanceOf(UnrecoverableError);
    for (const queue of ['d1', 'd2', 'd3']) await seedJob({ key: KEY, status: 'dead', queue, released: true });
    expect((await loadDreamBreaker(engine))!.tripped.get(KEY)).toBe(3);
  });
});

describe('doctor dream_paid_loop', () => {
  test('warns with the base key, prefix and reset command; ok when clean', async () => {
    expect((await dreamPaidLoopCheck(engine)).status).toBe('ok');
    await seedJob({ key: KEY, status: 'dead', queue: 'd1' });
    for (const queue of ['d2', 'd3']) await seedJob({ key: KEY, status: 'dead', queue, released: true });
    const check = await dreamPaidLoopCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain(KEY);
    expect(check.message).toContain('gbrain dream reset-key');
    expect((check.details!.keys as Array<{ key_prefix: string }>)[0]!.key_prefix).toBe('dream:synth-v2:');
  });
});

describe('gbrain dream reset-key', () => {
  async function captured(run: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try { await run(); } finally { console.log = log; }
    return lines.join('\n');
  }

  test('--list shows tripped keys and a reset clears them', async () => {
    const { runDreamResetKey } = await import('../src/commands/dream-reset-key.ts');
    await seedJob({ key: KEY, status: 'dead', queue: 'd1' });
    for (const queue of ['d2', 'd3']) await seedJob({ key: KEY, status: 'dead', queue, released: true });
    const listed = JSON.parse(await captured(() => runDreamResetKey(engine, ['--list', '--json'])));
    expect(listed.tripped).toEqual([expect.objectContaining({ base_key: KEY, dead_submissions: 3 })]);
    expect(await captured(() => runDreamResetKey(engine, [KEY]))).toContain(`Reset ${KEY}`);
    expect(await captured(() => runDreamResetKey(engine, ['--list']))).toContain('No tripped dream keys');
  });

  test('the dead-submission index exists after schema init', async () => {
    const rows = await engine.executeRaw(`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_minion_jobs_dead_subagent_finished'`);
    expect(rows).toHaveLength(1);
  });
});

describe('breaker reset persistence', () => {
  let dir: string;
  let reopened: PGLiteEngine;
  let trippedBeforeReset = 0;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-dream-breaker-'));
    const path = join(dir, 'brain.pglite');
    const first = new PGLiteEngine();
    await first.connect({ engine: 'pglite', database_path: path } as never);
    await first.initSchema();
    for (const queue of ['d1', 'd2', 'd3']) await seedJob({ key: KEY, status: 'dead', queue, hoursAgo: 2, released: true }, first);
    trippedBeforeReset = (await loadDreamBreaker(first))!.tripped.get(KEY) ?? 0;
    await resetDreamBreakerKey(first, `${KEY}:c0of3`);
    await first.disconnect();
    reopened = new PGLiteEngine();
    await reopened.connect({ engine: 'pglite', database_path: path } as never);
  }, 120_000);
  afterAll(async () => {
    await reopened.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a reset survives a restart and later deaths count again', async () => {
    expect(trippedBeforeReset).toBe(3);
    expect((await loadDreamBreaker(reopened))!.tripped.size).toBe(0);
    for (const queue of ['d4', 'd5', 'd6']) await seedJob({ key: KEY, status: 'dead', queue, hoursAgo: 0, released: true }, reopened);
    await reopened.executeRaw(`UPDATE minion_jobs SET finished_at = now() + interval '1 second' WHERE queue IN ('d4','d5','d6')`);
    expect((await loadDreamBreaker(reopened))!.tripped.get(KEY)).toBe(3);
  });
});
