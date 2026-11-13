/**
 * The `extract` job's stale mode chains a continuation only while the stale count goes down. Before the fix, the
 * guard was `staleRemaining > 0 && pagesProcessed > 0`: a sweep that re-processed the same pages without clearing
 * them passed it on every run, so one root job became an endless chain (thousands of jobs a day) that held the
 * long-job slot ahead of higher-priority work.
 *
 * Authoring gate: (1) protects "a stale-sweep chain ends when a run makes no progress"; (2) fails when the guard
 * counts re-processed pages as progress; (3) no existing test runs the handler's stale branch with a page the sweep
 * cannot clear; (4) no production seam: a test-only trigger keeps listed pages unstamped, so every count (raw and
 * actionable) sees them as stale while each sweep still processes them.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { makeExtractHandler } from '../src/core/minions/handlers/extract.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'A note.', timeline: '' });
  await engine.putPage('notes/b', { type: 'note', title: 'B', compiled_truth: 'B note.', timeline: '' });
  await engine.executeRaw('CREATE TABLE test_stuck_pages (slug text PRIMARY KEY)');
  await engine.executeRaw(`CREATE FUNCTION test_keep_stuck() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.slug IN (SELECT slug FROM test_stuck_pages) THEN NEW.links_extracted_at := NULL; END IF; RETURN NEW; END $$`);
  await engine.executeRaw(`CREATE TRIGGER test_keep_stuck BEFORE UPDATE OF links_extracted_at ON pages
    FOR EACH ROW EXECUTE FUNCTION test_keep_stuck()`);
}, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);
beforeEach(async () => {
  await engine.executeRaw("DELETE FROM minion_jobs WHERE name = 'extract'");
  await engine.executeRaw('DELETE FROM test_stuck_pages');
  await engine.executeRaw('UPDATE pages SET links_extracted_at = NULL');
});

const stick = (...slugs: string[]) => engine.executeRaw('INSERT INTO test_stuck_pages SELECT unnest($1::text[])', [slugs]);
const job = (id: number, data: Record<string, unknown>) => ({ id, name: 'extract', data, attempts_made: 0,
  signal: new AbortController().signal, shutdownSignal: new AbortController().signal, deadlineAtMs: null,
  updateProgress: async () => undefined, updateTokens: async () => undefined, log: async () => undefined,
  isActive: async () => true, readInbox: async () => [] }) as unknown as MinionJobContext;
const waiting = () => engine.executeRaw<{ id: number; data: Record<string, unknown> }>(
  "SELECT id, data FROM minion_jobs WHERE name = 'extract' AND status = 'waiting' ORDER BY id");
const run = (id: number, data: Record<string, unknown>) =>
  makeExtractHandler(engine)(job(id, data)) as Promise<{ pagesProcessed: number; staleRemaining: number }>;

test('a continuation that re-processes the same stuck page chains no further job', async () => {
  await stick('notes/a');
  expect(await run(9001, { stale: true })).toMatchObject({ pagesProcessed: 2, staleRemaining: 1 });
  const [child] = await waiting();
  expect(child?.data).toMatchObject({ stale: true, continuation_of: 9001 });

  expect(await run(child!.id, child!.data)).toMatchObject({ pagesProcessed: 1, staleRemaining: 1 });
  // The same page was processed and the same count is left: the chain ends here.
  expect((await waiting()).map(row => row.id)).toEqual([child!.id]);
}, 120_000);

test('a continuation that lowers the stale count chains the next one, and the chain ends when it stops falling', async () => {
  await stick('notes/a', 'notes/b');
  expect(await run(9002, { stale: true })).toMatchObject({ pagesProcessed: 2, staleRemaining: 2 });
  const [child] = await waiting();
  await engine.executeRaw("DELETE FROM test_stuck_pages WHERE slug = 'notes/b'");

  expect(await run(child!.id, child!.data)).toMatchObject({ pagesProcessed: 2, staleRemaining: 1 });
  const afterProgress = await waiting();
  expect(afterProgress).toHaveLength(2);
  const grandchild = afterProgress[1]!;
  expect(grandchild.data).toMatchObject({ stale: true, continuation_of: child!.id });

  expect(await run(grandchild.id, grandchild.data)).toMatchObject({ pagesProcessed: 1, staleRemaining: 1 });
  expect(await waiting()).toHaveLength(2);
}, 120_000);
