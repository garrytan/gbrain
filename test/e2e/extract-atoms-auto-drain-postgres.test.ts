// Postgres parity for the background drain policy
// (src/core/cycle/extract-atoms-auto-drain.ts): the daily-cap count, the
// in-flight/day-key dedup SQL, the cap lock, and transcript-only dispatch run
// on real Postgres. Behaviour detail lives in test/extract-atoms-auto-drain.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { queueDrainContinuation, type ExtractAtomsDrainResult } from '../../src/core/cycle/extract-atoms-drain.ts';
import { dispatchAutoDrains, drainInFlight } from '../../src/core/cycle/extract-atoms-auto-drain.ts';

const describeDb = hasDatabase() ? describe : describe.skip;
describeDb('Postgres background drain policy', () => {
  let engine: PostgresEngine;
  let queue: MinionQueue;
  let root: string;
  beforeAll(async () => { engine = await setupDB(); queue = new MinionQueue(engine); }, 60000);
  afterAll(async () => { await teardownDB(); });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM minion_jobs');
    await engine.executeRaw('TRUNCATE pages CASCADE');
    await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'autopilot.auto_drain.%' OR key LIKE 'dream.%'`);
    root = mkdtempSync(join(tmpdir(), 'gbrain-auto-drain-pg-'));
    await engine.executeRaw(`UPDATE sources SET local_path=$1 WHERE id='default'`, [root]);
  });

  const cut: ExtractAtomsDrainResult = {
    phase: 'extract_atoms', status: 'ok', extracted: 2, skipped: 0, remaining: 3, transcripts_remaining: 0,
    batches: 1, items_completed: 2, items_deferred: 1, stopped: 'window', failure_count: 0, failures: [],
    omitted_failure_count: 0, last_error: null,
  };

  test('a $0.30/day ceiling refuses a continuation with the numbers', async () => {
    await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.3');
    const parent = await queue.add('extract-atoms-drain', { sourceId: 'default' }, { queue: 'default' }, { allowProtectedSubmit: true });
    expect(await drainInFlight(engine, 'default')).toBe(true);
    expect(await drainInFlight(engine, 'default', parent.id)).toBe(false);
    expect(await queueDrainContinuation(engine, parent, cut))
      .toEqual({ queued: false, reason: 'daily_cap', max_usd_per_day: 0.3, max_jobs_today: 1, jobs_today: 1 });
  });

  test('transcript-only backlog dispatches once per day', async () => {
    const dir = mkdtempSync(join(root, 'sessions-'));
    writeFileSync(join(dir, '2026-01-01-session.txt'), 'Synthetic session about a generic topic. '.repeat(80));
    await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
    try {
      const first = await dispatchAutoDrains(engine, queue, {});
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ sourceId: 'default', backlog: { pages: 0, transcripts: 1 } });
      expect(await dispatchAutoDrains(engine, queue, {})).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
