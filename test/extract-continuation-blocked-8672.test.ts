/**
 * #8672: a stale extract job that cleared every page extraction can clear chained one more job when only
 * attendance-blocked pages were left, because it read the raw stale count; that child rescanned and did nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeExtractHandler } from '../src/core/minions/handlers/extract.ts';
import { mentionBrain, page, resetMentionBrain } from './helpers/mention-brain.ts';

const continuations = async (engine: PGLiteEngine) => Number((await engine.executeRaw<{ n: number }>(
  `SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'extract' AND data ? 'continuation_of'`))[0]!.n);

async function runStaleJob(engine: PGLiteEngine) {
  return makeExtractHandler(engine)({ id: 1, data: { stale: true } } as never) as Promise<Record<string, unknown>>;
}

describe('stale extract continuation (#8672)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetMentionBrain(engine);
    await engine.executeRaw('DELETE FROM minion_jobs');
    await page(engine, 'people/alice-example', 'person', 'Alice Example', 'Alice Example fixture.');
    await page(engine, 'notes/plan', 'note', 'Plan', 'See [[people/alice-example]] about the plan.');
    for (const n of [1, 2, 3]) await page(engine, `meetings/sync-${n}`, 'meeting', `Sync ${n}`, 'Attendees: [[people/bob-example]]');
  }, 120_000);

  test('a sweep that leaves only attendance-blocked pages queues no continuation', async () => {
    await engine.executeRaw("UPDATE pages SET links_attendance_blocked_revision = knowledge_revision WHERE slug LIKE 'meetings/%'");
    const r = await runStaleJob(engine);
    expect(Number(r.pagesProcessed)).toBeGreaterThan(0);
    expect(Number(r.staleRemaining)).toBeGreaterThan(0);
    expect(await continuations(engine)).toBe(0);
  }, 300_000);
});
