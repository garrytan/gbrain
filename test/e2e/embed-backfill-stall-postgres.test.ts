/**
 * #6803 (1): an embed-backfill whose only remaining work sits on pages it
 * cannot project dead-lettered every ~15 minutes forever (23 dead jobs a day
 * on a production brain, nothing embedded), because every automatic submitter
 * queued the next run as soon as the 10-minute cooldown passed.
 *
 * Real Postgres job queue and worker: each submitted job runs the real
 * handler (only the stale drain is stubbed to report the blocked shape) and
 * fails through the worker's retry/dead-letter path; the submit gate reads
 * the resulting rows. Identical no-progress failures back off, stop at the
 * limit, and a changed blocker or real progress re-arms the backfill.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { makeEmbedBackfillHandler } from '../../src/core/minions/handlers/embed-backfill.ts';
import { submitEmbedBackfill, type SubmitEmbedBackfillResult } from '../../src/core/embed-backfill-submit.ts';
import { EMBED_BACKFILL_STALL_LIMIT } from '../../src/core/embed-backfill-stall.ts';
import { embedBackfillStalledCheck } from '../../src/commands/doctor/checks/embed-backfill-stalled.ts';
import type { EmbedStaleResult } from '../../src/core/embed-stale.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;
const SOURCE = 'stall-example';
const MIN = 60_000;

let embedded = 0;
const runStale = async (): Promise<EmbedStaleResult> => ({ embedded, chunksProcessed: embedded, pagesProcessed: embedded ? 1 : 0, invalidated: 0,
  lastCursor: null, done: true, aborted: false, remaining: 2, blocked: 1, complete: false });

/** A page with an unembedded chunk whose text projection is behind its revision: what the backfill's readiness pass reports blocked. */
async function blockPage(slug: string) {
  const engine = getEngine();
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Body of ${slug}.` }, { sourceId: SOURCE });
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]);
  const [chunks] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1', [page.id]);
  if (chunks.n === 0) {
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source) VALUES ($1, 0, $2, 'compiled_truth')`, [page.id, `Body of ${slug}.`]);
  }
  await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [page.id]);
}

/** Submit through the gate, then run the job to its terminal state on a real worker. */
async function submitAndRun(nowMs: number): Promise<SubmitEmbedBackfillResult> {
  const engine = getEngine();
  const result = await submitEmbedBackfill(engine, SOURCE, { reason: 'test', cooldownMinOverride: 10, spendCapUsdOverride: 1_000_000, nowMs });
  if (result.status !== 'submitted') return result;
  await engine.executeRaw('UPDATE minion_jobs SET backoff_delay=10 WHERE id=$1', [result.jobId]);
  const queue = new MinionQueue(engine);
  const worker = new MinionWorker(engine, { pollInterval: 25 });
  worker.register('embed-backfill', makeEmbedBackfillHandler(engine, { runStale }));
  const running = worker.start();
  try {
    for (let i = 0; i < 600; i++) {
      const status = (await queue.getJob(result.jobId))?.status;
      if (status === 'dead' || status === 'failed' || status === 'completed') break;
      await new Promise(r => setTimeout(r, 25));
    }
  } finally {
    worker.stop();
    await running;
  }
  return result;
}

async function lastJob() {
  const [row] = await getEngine().executeRaw<{ status: string; attempts_made: number; error_text: string | null; finished_at: Date }>(
    "SELECT status, attempts_made, error_text, finished_at FROM minion_jobs WHERE name='embed-backfill' ORDER BY id DESC LIMIT 1");
  return row;
}

describeE2E('E2E: embed-backfill stall cap (#6803)', () => {
  beforeAll(async () => {
    await setupDB();
    await getEngine().executeRaw("INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING", [SOURCE]);
    await blockPage('notes/blocked-a');
  });
  afterAll(async () => { await teardownDB(); });

  test('identical no-progress failures back off, stop at the limit, and re-arm when the blocker changes', async () => {
    embedded = 0;
    // Run 1: the job fails, its retry sees the same blockers and dead-letters instead of failing a third time.
    expect((await submitAndRun(Date.now())).status).toBe('submitted');
    const first = await lastJob();
    expect(first.status).toBe('dead');
    expect(first.attempts_made).toBe(2);
    expect(first.error_text).toStartWith('embed-backfill: incomplete; 2 chunks remain and 1 projections are blocked.');
    expect(first.error_text).toContain('No progress since the previous attempt');

    // The plain 10-minute cooldown would admit a run at +11 min; one identical failure doubles it.
    let finished = new Date(first.finished_at).getTime();
    const held = await submitAndRun(finished + 11 * MIN);
    expect(held).toMatchObject({ status: 'cooldown', reason: 'recently_finished' });
    expect((await submitAndRun(finished + 21 * MIN)).status).toBe('submitted');
    finished = new Date((await lastJob()).finished_at).getTime();
    // Two identical failures: 40 minutes.
    expect((await submitAndRun(finished + 39 * MIN)).status).toBe('cooldown');
    expect((await submitAndRun(finished + 41 * MIN)).status).toBe('submitted');
    finished = new Date((await lastJob()).finished_at).getTime();

    // At the limit, automatic submission stops however long it waits.
    const stalled = await submitAndRun(finished + 7 * 24 * 60 * MIN);
    expect(stalled).toMatchObject({ status: 'stalled', failures: EMBED_BACKFILL_STALL_LIMIT, remaining: 1, blocked: 1 });
    const jobs = await getEngine().executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE name='embed-backfill'");
    expect(jobs[0].n).toBe(EMBED_BACKFILL_STALL_LIMIT);

    // doctor names the blocked page and the preview-first repair.
    const check = await embedBackfillStalledCheck(getEngine());
    expect(check.status).toBe('warn');
    expect(check.message).toContain('notes/blocked-a');
    expect(check.fix).toMatchObject({ argv: ['gbrain', 'projections', 'drain'], preview_argv: ['gbrain', 'projections', 'drain', '--dry-run', '--json'] });

    // A changed blocker re-arms the backfill.
    await blockPage('notes/blocked-b');
    expect((await submitAndRun(finished + 7 * 24 * 60 * MIN)).status).toBe('submitted');

    // Real progress ends the streak: the next identical failure starts over at the plain backoff.
    embedded = 1;
    expect((await submitAndRun(Date.now() + 7 * 24 * 60 * MIN)).status).toBe('submitted');
    embedded = 0;
    finished = new Date((await lastJob()).finished_at).getTime();
    expect((await submitAndRun(finished + 11 * MIN)).status).toBe('submitted');
  }, 120_000);
});
