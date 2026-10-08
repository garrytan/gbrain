/**
 * Dream paid-loop breaker on Postgres: the released key lands as a real jsonb
 * member through postgres.js (not a double-encoded string scalar), the shared
 * counter trips on it, and migration 173's partial index is valid.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { countDeadDreamSubmissions, loadDreamBreaker, resetDreamBreakerKey } from '../../src/core/cycle/dream-breaker.ts';

const describePg = hasDatabase() ? describe : describe.skip;
const KEY = 'dream:synth-v2:default:filename:pg-loop.txt:0123456789abcdef';

describePg('dream paid-loop breaker — Postgres', () => {
  beforeAll(async () => { await setupDB(); }, 90_000);
  afterAll(async () => { await teardownDB(); }, 30_000);

  test('released keys are recorded as jsonb members and three dead runs trip the key', async () => {
    const engine = getEngine();
    await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'breaker-probe'`);
    await engine.setConfig('dream.breaker.resets', '{}');
    const queue = new MinionQueue(engine);
    for (let run = 0; run < 3; run++) {
      const job = await queue.add('breaker-probe', { run }, { idempotency_key: KEY, queue: `dream-inline-pg-${run}` });
      await engine.executeRaw(`UPDATE minion_jobs SET status = 'dead', finished_at = now(), name = 'subagent' WHERE id = $1`, [job.id]);
    }
    await queue.add('breaker-probe', { run: 3 }, { idempotency_key: KEY });
    const released = await engine.executeRaw<{ kind: string; key: string }>(
      `SELECT jsonb_typeof(data) AS kind, data->>'__released_idempotency_key' AS key
         FROM minion_jobs WHERE status = 'dead' AND idempotency_key IS NULL AND data->>'__released_idempotency_key' = $1`, [KEY]);
    expect(released).toHaveLength(3);
    expect(released.every(row => row.kind === 'object' && row.key === KEY)).toBe(true);
    expect((await loadDreamBreaker(engine))!.tripped.get(KEY)).toBe(3);
    await resetDreamBreakerKey(engine, KEY);
    expect((await loadDreamBreaker(engine))!.tripped.has(KEY)).toBe(false);
  });

  test('#6236: patterns deaths and paid timeout-cancels count per source under changing content keys', async () => {
    const engine = getEngine();
    await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'subagent'`);
    await engine.setConfig('dream.breaker.resets', '{}');
    const seed = (key: string, status: string, tokens: number, source: string) => engine.executeRaw(
      `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, idempotency_key, tokens_input, finished_at)
       VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', $1, $2, $3::jsonb, $4, $5, now())`,
      [`q-${key}`, status, { source_id: source }, key, tokens]);
    await seed('dream:patterns:pg-1', 'dead', 0, 'pg-src');
    await seed('dream:patterns:pg-2', 'cancelled', 900, 'pg-src');
    await seed('dream:patterns:pg-3', 'cancelled', 0, 'pg-src');
    await seed('dream:patterns:pg-4', 'dead', 0, 'pg-src');
    const rows = await countDeadDreamSubmissions(engine);
    expect(rows.find(row => row.base_key === 'dream:patterns:source:pg-src')?.dead_submissions).toBe(3);
    expect(rows.some(row => row.base_key.startsWith('dream:patterns:pg-'))).toBe(false);
    expect((await loadDreamBreaker(engine))!.tripped.get('dream:patterns:source:pg-src')).toBe(3);
  });

  test('migration 173 leaves a valid partial index on dead subagent finish times', async () => {
    const rows = await getEngine().executeRaw<{ valid: boolean; def: string }>(
      `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
        WHERE i.indexrelid = to_regclass('idx_minion_jobs_dead_subagent_finished')`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valid).toBe(true);
    expect(rows[0]!.def).toContain("status = 'dead'");
  });
});
