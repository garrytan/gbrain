/**
 * `extract timeline --from-meetings` and the `extract-timeline-from-meetings`
 * job on a managed brain (#6273).
 *
 * 1. Protects: the "Discussed in <meeting>" rows land on each attendee's
 *    timeline through the persistence coordinator, a rerun admits nothing,
 *    rows deleted since are written again, a page changed mid-run is retried,
 *    and a refused or still-pending write makes the command exit non-zero and
 *    fails the job instead of completing over rows that were never written.
 *    The request's preparer inserts only dated meeting rows on the page it
 *    was admitted for.
 * 2. Fails when: the pass writes `timeline_entries` with a raw batch insert,
 *    which the armed managed writer guard refuses
 *    (`writer_coordinator_required`): the run reported `entries_created: 0`.
 * 3. test/extract-timeline-from-meetings.test.ts covers the unmanaged walk;
 *    test/managed-sweep-timeline.test.ts covers the page-body timeline.
 * 4. No production seam (the write wait uses its existing test seam).
 *
 * Runs on PGLite; also on Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { MEETING_TIMELINE_INTENT, extractTimelineFromMeetings, prepareMeetingTimeline } from '../src/core/extract-timeline-from-meetings.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { makeExtractTimelineFromMeetingsHandler } from '../src/core/minions/handlers/extract-timeline-from-meetings.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-meetings-timeline-db-'));
let closePostgres: (() => Promise<void>) | undefined;
const noMentions = new Map();
const ALICE = 'people/alice-example';
const BOB = 'people/bob-example';
const MEETING = 'meetings/2026-04-20-planning';
const ROW = { date: '2026-04-20', source: `extract-timeline-from-meetings:${MEETING}`, summary: 'Discussed in Planning Review' };

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});

/** A source seeded before the brain is managed: Alice and Bob attend the planning meeting, Alice also `extraMeetings` more. */
async function seedMeetingSource(engine: BrainEngine, root: string, extraMeetings = 0, title = 'Planning Review'): Promise<string> {
  const sourceId = `meetings-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  for (const [slug, title] of [[ALICE, 'Alice Example'], [BOB, 'Bob Example']]) {
    await engine.putPage(slug, { type: 'person', title, compiled_truth: `${title}.`, timeline: '', frontmatter: {} }, { sourceId });
  }
  const meeting = (slug: string, title: string) => engine.putPage(slug, { type: 'meeting', title, compiled_truth: 'Notes.',
    timeline: '', frontmatter: {}, effective_date: new Date('2026-04-20T00:00:00.000Z') }, { sourceId });
  const attended = (from_slug: string, to_slug: string) => ({ from_slug, to_slug, link_type: 'attended', link_source: 'manual',
    from_source_id: sourceId, to_source_id: sourceId });
  await meeting(MEETING, title);
  const extra = Array.from({ length: extraMeetings }, (_, i) => `meetings/2026-04-20-sync-${String(i).padStart(3, '0')}`);
  for (const slug of extra) await meeting(slug, `Sync ${slug.slice(-3)}`);
  await engine.addLinksBatch([attended(MEETING, ALICE), attended(MEETING, BOB), ...extra.map(slug => attended(slug, ALICE))]);
  return sourceId;
}

async function managedMeetingSource(engine: BrainEngine, root: string, extraMeetings = 0, title?: string): Promise<string> {
  const sourceId = await seedMeetingSource(engine, root, extraMeetings, title);
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return sourceId;
}

async function meetingRows(engine: BrainEngine, sourceId: string) {
  return engine.executeRaw<{ slug: string; date: string; source: string; summary: string }>(
    `SELECT p.slug, to_char(t.date,'YYYY-MM-DD') AS date, t.source, t.summary FROM timeline_entries t
       JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 ORDER BY p.slug, t.source`, [sourceId]);
}

const requests = (engine: BrainEngine, sourceId: string) => engine.executeRaw<{ slug: string; state: string }>(
  `SELECT slug, state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'=$2 ORDER BY slug, created_at`, [sourceId, MEETING_TIMELINE_INTENT]);

async function inSandbox(engine: BrainEngine, fn: (root: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-meetings-timeline-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, () => fn(root));
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1').catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The engine whose entity-page read (the publisher's own, not the coordinator's admission read) reports a stale revision `times` times. */
function withStaleSnapshots(engine: BrainEngine, times: number): BrainEngine {
  let left = times;
  return new Proxy(engine, { get(target, prop) {
    if (prop === 'readPageSnapshot') {
      return async (slug: string, opts?: { sourceId?: string; includeDeleted?: boolean }) => {
        const snapshot = await target.readPageSnapshot(slug, opts);
        return snapshot && !opts?.includeDeleted && left-- > 0 ? { ...snapshot, revision: `${snapshot.revision}-stale` } : snapshot;
      };
    }
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

async function runCli(engine: BrainEngine, sourceId: string) {
  const err: string[] = [];
  const { log, error } = console;
  console.log = () => {};
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  const priorExitCode = process.exitCode;
  _resetCliExitVerdictForTests();
  try {
    await runExtract(engine, ['timeline', '--from-meetings', '--source', 'db', '--source-id', sourceId]);
  } finally {
    console.log = log; console.error = error;
    process.exitCode = priorExitCode ?? 0;
  }
  const exitCode = currentExitCode();
  _resetCliExitVerdictForTests();
  return { stderr: err.join('\n'), exitCode };
}

test('managed: meeting timeline rows publish through the coordinator, a rerun admits nothing, and deleted rows are written again', async () => {
  for (const engine of engines) {
    await inSandbox(engine, async root => {
      const sourceId = await managedMeetingSource(engine, root);

      const result = await extractTimelineFromMeetings(engine, { sourceIdFilter: sourceId, gazetteer: noMentions });

      expect(result).toMatchObject({ meetings_scanned: 1, entries_created: 2, entities_touched: 2, batch_errors: 0 });
      expect(await meetingRows(engine, sourceId)).toEqual([{ slug: ALICE, ...ROW }, { slug: BOB, ...ROW }]);
      expect(await requests(engine, sourceId)).toEqual([{ slug: ALICE, state: 'committed' }, { slug: BOB, state: 'committed' }]);

      const again = await extractTimelineFromMeetings(engine, { sourceIdFilter: sourceId, gazetteer: noMentions });

      expect(again).toMatchObject({ entries_created: 0, batch_errors: 0 });
      expect(await requests(engine, sourceId)).toHaveLength(2);
      expect(await meetingRows(engine, sourceId)).toHaveLength(2);

      // Alice's row is deleted with her page revision unchanged: the committed request is not replayed, a new one writes the row.
      await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
        'DELETE FROM timeline_entries WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', [sourceId, ALICE]), TEST_WRITE_ATTRIBUTION));

      const restored = await extractTimelineFromMeetings(engine, { sourceIdFilter: sourceId, gazetteer: noMentions });

      expect(restored).toMatchObject({ entries_created: 1, batch_errors: 0 });
      expect(await meetingRows(engine, sourceId)).toEqual([{ slug: ALICE, ...ROW }, { slug: BOB, ...ROW }]);
      expect((await requests(engine, sourceId)).map(r => r.slug)).toEqual([ALICE, ALICE, BOB]);
    });
  }
}, 180_000);

test('managed: a page with more rows than one request carries publishes them in several requests', async () => {
  for (const engine of engines) {
    await inSandbox(engine, async root => {
      const sourceId = await managedMeetingSource(engine, root, 200);

      const result = await extractTimelineFromMeetings(engine, { sourceIdFilter: sourceId, gazetteer: noMentions });

      expect(result).toMatchObject({ meetings_scanned: 201, entries_created: 202, entities_touched: 2, batch_errors: 0 });
      expect((await meetingRows(engine, sourceId)).filter(r => r.slug === ALICE)).toHaveLength(201);
      expect(await requests(engine, sourceId)).toEqual([{ slug: ALICE, state: 'committed' }, { slug: ALICE, state: 'committed' }, { slug: BOB, state: 'committed' }]);
    });
  }
}, 300_000);

test('managed: a row a page write re-filed with collapsed whitespace is not written twice, and an archived source is skipped', async () => {
  for (const engine of engines) {
    await inSandbox(engine, async root => {
      const sourceId = await managedMeetingSource(engine, root, 0, 'Planning  Review');
      const run = () => extractTimelineFromMeetings(engine, { sourceIdFilter: sourceId, gazetteer: noMentions });
      expect(await run()).toMatchObject({ entries_created: 2, batch_errors: 0 });
      // What a later write of each person page does to its database-only row: the summary comes back with single spaces.
      await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
        `UPDATE timeline_entries SET summary=$2 WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)`, [sourceId, ROW.summary]), TEST_WRITE_ATTRIBUTION));

      expect(await run()).toMatchObject({ entries_created: 0, batch_errors: 0 });
      expect(await meetingRows(engine, sourceId)).toEqual([{ slug: ALICE, ...ROW }, { slug: BOB, ...ROW }]);
      expect(await requests(engine, sourceId)).toHaveLength(2);

      // An archived source accepts no maintenance: its pages are skipped, not counted as refused writes.
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('DELETE FROM timeline_entries WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [sourceId]);
      await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

      expect(await run()).toMatchObject({ entries_created: 0, batch_errors: 0 });
      expect(await meetingRows(engine, sourceId)).toEqual([]);
      expect(await requests(engine, sourceId)).toHaveLength(2);
    });
  }
}, 180_000);

test('managed: a page that changed after it was read is retried, and one that keeps changing is left for the next run', async () => {
  for (const engine of engines) {
    await inSandbox(engine, async root => {
      const sourceId = await managedMeetingSource(engine, root);
      const changing = withStaleSnapshots(engine, Number.POSITIVE_INFINITY);
      const changedOnce = withStaleSnapshots(engine, 1);
      try {
        const skipped = await extractTimelineFromMeetings(changing, { sourceIdFilter: sourceId, gazetteer: noMentions });

        expect(skipped).toMatchObject({ entries_created: 0, batch_errors: 0, pages_skipped: 2 });
        expect(await meetingRows(engine, sourceId)).toEqual([]);

        const retried = await extractTimelineFromMeetings(changedOnce, { sourceIdFilter: sourceId, gazetteer: noMentions });

        expect(retried).toMatchObject({ entries_created: 2, batch_errors: 0 });
        expect(retried.pages_skipped).toBeUndefined();
        expect(await meetingRows(engine, sourceId)).toEqual([{ slug: ALICE, ...ROW }, { slug: BOB, ...ROW }]);
      } finally {
        await disposePersistenceConsumer(changing);
        await disposePersistenceConsumer(changedOnce);
      }
    });
  }
}, 180_000);

test('managed: a refused write is counted, exits non-zero and fails the job instead of completing with 0 entries', async () => {
  for (const engine of engines) {
    await inSandbox(engine, async root => {
      // The source has a canonical root but no owner on this host, so the coordinator refuses its maintenance.
      const sourceId = await seedMeetingSource(engine, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

      const result = await extractTimelineFromMeetings(engine, { sourceIdFilter: sourceId, gazetteer: noMentions });

      expect(result).toMatchObject({ entries_created: 0, batch_errors: 2 });
      expect(result.first_batch_error).toContain('owner_unavailable');
      expect(await meetingRows(engine, sourceId)).toEqual([]);
      const job = { data: { sourceId } } as unknown as MinionJobContext;
      await expect(makeExtractTimelineFromMeetingsHandler(engine)(job)).rejects.toThrow(/2 timeline write\(s\) refused or failed.*owner_unavailable/);
      const cli = await runCli(engine, sourceId);
      expect(cli.exitCode).toBe(1);
      expect(cli.stderr).toContain('2 timeline write(s) failed or were refused');
      expect(cli.stderr).toContain('owner_unavailable');
    });
  }
}, 180_000);

test('managed: a busy writer leaves the rest of the source for a rerun, exits non-zero and fails the job', async () => {
  for (const engine of engines) {
    // Each observation starts from a fresh source: an accepted request commits in the background between runs.
    const whileBusy = (observe: (sourceId: string) => Promise<void>) => inSandbox(engine, async root => {
      const sourceId = await managedMeetingSource(engine, root);
      const restoreWait = __setMaintenanceWriteWaitForTests(0);
      try { await observe(sourceId); } finally { restoreWait(); }

      const rerun = await extractTimelineFromMeetings(engine, { sourceIdFilter: sourceId, gazetteer: noMentions });

      expect(rerun).toMatchObject({ batch_errors: 0 });
      expect(rerun.pages_pending).toBeUndefined();
      expect(await meetingRows(engine, sourceId)).toEqual([{ slug: ALICE, ...ROW }, { slug: BOB, ...ROW }]);
    });

    await whileBusy(async sourceId => {
      const busy = await extractTimelineFromMeetings(engine, { sourceIdFilter: sourceId, gazetteer: noMentions });
      // The first page's request was accepted and is still pending; the other page was not submitted.
      expect(busy).toMatchObject({ entries_created: 0, batch_errors: 0, pages_pending: 2 });
      expect(await requests(engine, sourceId)).toHaveLength(1);
    });
    await whileBusy(async sourceId => {
      const job = { data: { sourceId } } as unknown as MinionJobContext;
      await expect(makeExtractTimelineFromMeetingsHandler(engine)(job)).rejects.toThrow(/2 page\(s\) left pending/);
    });
    await whileBusy(async sourceId => {
      expect((await runCli(engine, sourceId)).exitCode).toBe(1);
    });
  }
}, 180_000);

test('the meeting timeline preparer refuses rows this pass never produces and a page that was replaced', async () => {
  const cases: Array<[string, unknown]> = [
    ['no rows', []],
    ['a row from another writer', [{ ...ROW, source: 'manual' }]],
    ['a timestamp instead of a day', [{ ...ROW, date: '2026-04-20T00:00:00.000Z' }]],
    ['an empty summary', [{ ...ROW, summary: ' ' }]],
    ['more rows than one request carries', Array.from({ length: 201 }, () => ROW)],
  ];
  const request = (rows: unknown) => ({ request_id: 'r-1', slug: ALICE, source_id: 'default', page_id: 7,
    intent: { kind: MEETING_TIMELINE_INTENT, expected_revision: null, rows } }) as unknown as WriteRequest;
  for (const [label, rows] of cases) {
    await expect(prepareMeetingTimeline(engines[0]!, request(rows)), label).rejects.toMatchObject({ code: 'invalid_params' });
  }
  for (const [label, snapshot] of [['the page is gone', null], ['another page holds the slug', { revision: 'r', page: { id: 8 } }]] as const) {
    const replaced = { readPageSnapshot: async () => snapshot } as unknown as BrainEngine;
    await expect(prepareMeetingTimeline(replaced, request([ROW])), label).rejects.toMatchObject({ code: 'page_identity_changed' });
  }
});
