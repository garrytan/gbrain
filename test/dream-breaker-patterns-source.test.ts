/**
 * #6236: patterns deaths count per source, whatever reflection set (content
 * key) each run read. A patterns child cancelled at its timeout after paid
 * work counts too; one cancelled before any work does not. A completed run
 * resets the source; another source is unaffected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  clearPatternsSourceDeaths, countDeadDreamSubmissions, dreamPatternsSourceKey, patternsBreakerSkip,
} from '../src/core/cycle/dream-breaker.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function seed(opts: { key: string; status: string; queue: string; source?: string; tokens?: number }): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, idempotency_key, tokens_input, created_at, finished_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', $1, $2, $3::text::jsonb, $4, $5, now() - interval '1 hour', now() - interval '1 hour')`,
    [opts.queue, opts.status, JSON.stringify(opts.source ? { source_id: opts.source } : {}), opts.key, opts.tokens ?? 0],
  );
}

describe('patterns breaker per source (#6236)', () => {
  test('three deaths under three different content keys trip the source key and skip the run', async () => {
    for (const n of [1, 2]) await seed({ key: `dream:patterns:digest-${n}`, status: 'dead', queue: `dream-inline-${n}` });
    expect(await patternsBreakerSkip(engine, 'default')).toBeNull();
    await seed({ key: 'dream:patterns:digest-3', status: 'dead', queue: 'dream-inline-3' });
    const rows = await countDeadDreamSubmissions(engine);
    expect(rows).toEqual([expect.objectContaining({ base_key: dreamPatternsSourceKey('default'), dead_submissions: 3 })]);
    const skip = await patternsBreakerSkip(engine, 'default');
    expect(skip?.status).toBe('skipped');
    expect(skip?.details).toMatchObject({ reason: 'dream_breaker_tripped', code: 'dream_breaker_tripped',
      fix: { argv: ['gbrain', 'dream', 'reset-key', 'dream:patterns:source:default'], consent: ['paid'], verify: { argv: ['gbrain', 'doctor', '--only', 'dream_paid_loop', '--json'] } } });
  });

  test('a paid timeout-cancel counts; a cancel before any work does not', async () => {
    await seed({ key: 'dream:patterns:a', status: 'dead', queue: 'q1' });
    await seed({ key: 'dream:patterns:b', status: 'cancelled', queue: 'q2', tokens: 1500 });
    await seed({ key: 'dream:patterns:c', status: 'cancelled', queue: 'q3', tokens: 0 });
    expect(await countDeadDreamSubmissions(engine)).toEqual([expect.objectContaining({ base_key: 'dream:patterns:source:default', dead_submissions: 2 })]);
    await seed({ key: 'dream:patterns:d', status: 'cancelled', queue: 'q4', tokens: 10 });
    expect(await patternsBreakerSkip(engine, 'default')).not.toBeNull();
  });

  test('a completed run resets the source; another source is unaffected', async () => {
    for (const n of [1, 2, 3]) await seed({ key: `dream:patterns:x${n}`, status: 'dead', queue: `a${n}`, source: 'alpha' });
    for (const n of [1, 2]) await seed({ key: `dream:patterns:y${n}`, status: 'dead', queue: `b${n}`, source: 'beta' });
    expect(await patternsBreakerSkip(engine, 'alpha')).not.toBeNull();
    expect(await patternsBreakerSkip(engine, 'beta')).toBeNull();
    await clearPatternsSourceDeaths(engine, 'alpha');
    expect(await patternsBreakerSkip(engine, 'alpha')).toBeNull();
    expect((await countDeadDreamSubmissions(engine)).find(r => r.base_key === 'dream:patterns:source:beta')?.dead_submissions).toBe(2);
  });

  test('synthesize keys still count per key and only dead rows', async () => {
    const key = 'dream:synth-v2:default:filename:t.txt:0123456789abcdef';
    await seed({ key, status: 'dead', queue: 's1' });
    await seed({ key: `${key}:c0of2`, status: 'cancelled', queue: 's2', tokens: 100 });
    expect(await countDeadDreamSubmissions(engine)).toEqual([expect.objectContaining({ base_key: key, dead_submissions: 1 })]);
  });
});
