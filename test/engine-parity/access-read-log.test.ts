/**
 * BrainEngine parity: the access read log (GST-2476 gap 1, master #10011, v331 `access_read_log`): the writer's batched
 * insert and retention (`access/read-log.ts`) and the two readers behind `gbrain access log` and `gbrain access who-read`
 * (`commands/access-read-log.ts`), whose SQL is in engine-sql/access-read-log.ts. They run through the typed members
 * insertAccessReadLogRows, pruneAccessReadLog, readAccessReadLog, listAccessReadPageRefs, readAccessReadsOfPages and
 * tallyAccessReadsOfPages (the Rust store keeps the rows under telemetry sub-tag `a 0x11`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) rows the writer buffers land in one batch, `access log` lists them newest first
 *    (ties by newest id) with each page as `source:slug` (`#<id>` for a page that does not exist) and filters by member
 *    (the reads a member made and the audiences naming `member:<id>`), window and limit, `who-read` finds every page with
 *    a slug (or the one in `--source`), tallies its readers (a member, an audience joined with `+`, or `(unbound)`) newest
 *    first and lists the reads, and the retention prune deletes rows older than the window first and then every row but
 *    the newest `maxRows` ids. A refused batch writes nothing.
 *  - Regression: an engine that lists the log in another order, ignores the window, the member filter or the limit, prunes
 *    by id before age, keeps rows past the window, orders the readers of a page by something other than their last read,
 *    or takes a refused batch in part gives a different access report; the Rust engine could not keep the log at all
 *    before the typed members (raw_sql refused the insert and both deletes).
 *  - Why existing coverage misses it: test/access-read-log.test.ts runs PGLite (and Postgres) only, and the case in
 *    test/engine-parity/surfaced-reads.test.ts compares sorted lists, with no order, window, age prune or tally order.
 *  - Seam: none for the reads and the writer (the writer runs through recordAccessRead and flushAccessReadLog; the
 *    readers are the command's own functions). The age and cap prunes seed back-dated rows through the typed insert, since
 *    the writer stamps the clock. Times are folded to their order; page ids are not compared (the readers name pages).
 */
import { afterEach, beforeEach, describe, expect } from 'bun:test';
import { whoRead, readAccessLog } from '../../src/commands/access-read-log.ts';
import { __resetAccessReadLogForTests, flushAccessReadLog, recordAccessRead } from '../../src/core/access/read-log.ts';
import type { ReadLogRow } from '../../src/core/engine-sql/access-read-log.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { createSource, parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Note', compiled_truth: 'body', timeline: '' };
const DAY_MS = 86_400_000;
/** A page id no brain holds, as a purged page's id reads: the readers show it as `#<id>`. */
const GONE = 2_000_000_000;

const pause = () => new Promise((resolve) => setTimeout(resolve, 8));
const ago = (days: number, extraMs = 0) => new Date(Date.now() - days * DAY_MS + extraMs).toISOString();

beforeEach(() => __resetAccessReadLogForTests());
afterEach(() => __resetAccessReadLogForTests());

/** Whether the times of a newest-first list never rise. */
const newestFirst = (times: readonly string[]) => times.every((t, i) => i === 0 || new Date(t) <= new Date(times[i - 1]!));
const folded = <T extends { at: string }>(entries: readonly T[]) => entries.map(({ at: _at, ...rest }) => rest);

function logRow(operation: string, ageDays: number, over: Partial<ReadLogRow> = {}): ReadLogRow {
  return {
    created_at: ago(ageDays), member: 'ada-example', audience: null, operation, transport: 'stdio', result_code: 'ok', page_ids: [], ...over,
  };
}

describe('engine parity: access read log', () => {
  parityTest(
    'a batch the writer buffers is listed by access log and who-read, newest first, by member, window, limit and source',
    { methods: ['readAccessReadLog', 'listAccessReadPageRefs', 'readAccessReadsOfPages', 'tallyAccessReadsOfPages'], timeout: 90_000 },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const alpha = (await engine.putPage('notes/alpha', { ...NOTE, title: 'Alpha' })).id;
      const beta = (await engine.putPage('notes/beta', { ...NOTE, title: 'Beta' })).id;
      const alphaWork = (await engine.putPage('notes/alpha', { ...NOTE, title: 'Alpha in work' }, { sourceId: 'work' })).id;

      const read = (member: string | null, audience: string[] | null, operation: string, transport: string, result_code: string, page_ids: number[]) =>
        recordAccessRead(engine, { member, audience, operation, transport, result_code, page_ids });
      read('ada-example', null, 'get_page', 'cli', 'ok', [alpha]);
      await pause();
      read(null, ['member:bo-example', 'group:ops'], 'search', 'stdio', 'ok', [alpha, beta, GONE]);
      await pause();
      read('bo-example', null, 'query', 'http', 'forbidden', []);
      await pause();
      read(null, null, 'get_page', 'http', 'ok', [alpha, alpha]);
      await pause();
      read('ada-example', null, 'get_page', 'cli', 'ok', [alphaWork]);
      await pause();
      read(null, [], 'recall', 'stdio', 'ok', [alpha]);
      await flushAccessReadLog();

      const all = await readAccessLog(engine, { since: '1d' });
      const bo = await readAccessLog(engine, { since: '1d', member: 'bo-example' });
      const ada = await readAccessLog(engine, { since: '1d', member: 'ada-example', limit: '1' });
      const nobody = await readAccessLog(engine, { since: '1d', member: 'nobody' });
      const nothingYet = await readAccessLog(engine, { since: '0s' });
      expect(all.map((e) => e.operation)).toEqual(['recall', 'get_page', 'get_page', 'query', 'search', 'get_page']);
      expect(newestFirst(all.map((e) => e.at))).toBe(true);
      expect(all[4]!.pages).toEqual(['default:notes/alpha', 'default:notes/beta', `#${GONE}`]);
      expect(bo.map((e) => e.operation)).toEqual(['query', 'search']);

      const who = await whoRead(engine, 'notes/alpha', { since: '1d' });
      const whoWork = await whoRead(engine, 'notes/alpha', { since: '1d', source: 'work', limit: '5' });
      const whoLimited = await whoRead(engine, 'notes/alpha', { since: '1d', limit: '2' });
      const stopped = async (slug: string, source?: string) =>
        whoRead(engine, slug, { since: '1d', source }).then(() => null, (e: { code?: string }) => e.code ?? String(e));
      const missing = await stopped('notes/missing');
      const wrongSource = await stopped('notes/beta', 'work');
      // A reader's newest read is its `last_at`.
      const lastAt = new Map(who.readers.map((r) => [r.who, r.last_at]));
      for (const reader of who.readers) {
        const newest = who.reads.find((r) => (r.member ?? r.audience?.join('+') ?? '(unbound)') === reader.who);
        expect(newest?.at).toBe(lastAt.get(reader.who)!);
      }
      expect(newestFirst(who.readers.map((r) => r.last_at))).toBe(true);

      const result = {
        all: folded(all),
        bo: folded(bo),
        ada: folded(ada),
        nobody,
        nothingYet,
        who: { pages: who.pages, readers: who.readers.map(({ last_at: _t, ...r }) => r), reads: folded(who.reads) },
        whoWork: { pages: whoWork.pages, readers: whoWork.readers.map(({ last_at: _t, ...r }) => r), reads: folded(whoWork.reads) },
        whoLimited: { readers: whoLimited.readers.map(({ last_at: _t, ...r }) => r), reads: folded(whoLimited.reads) },
        missing,
        wrongSource,
      };
      expect(result.who.pages).toEqual(['default:notes/alpha', 'work:notes/alpha']);
      expect(result.who.readers).toEqual([
        { who: '', reads: 1 }, { who: 'ada-example', reads: 2 }, { who: '(unbound)', reads: 1 }, { who: 'member:bo-example+group:ops', reads: 1 },
      ]);
      expect(result.whoWork.reads.map((e) => e.operation)).toEqual(['get_page']);
      expect(result.whoLimited.reads).toHaveLength(2);
      expect(result.missing).toBe('page_not_found');
      expect(result.wrongSource).toBe('page_not_found');
      return result;
    },
  );

  parityTest(
    'pruneAccessReadLog deletes the rows past the window by age, then keeps only the newest ids by cap',
    { methods: ['insertAccessReadLogRows', 'pruneAccessReadLog', 'readAccessReadLog'] },
    async (engine) => {
      const list = async () => (await engine.readAccessReadLog({ since: ago(3000), member: null, limit: 100 })).map((e) => e.operation);
      await engine.insertAccessReadLogRows([
        logRow('ancient', 500), logRow('old', 400), logRow('week', 7), logRow('day', 1),
        // The newest id carries the oldest time still inside the window: the cap follows ids, not times.
        logRow('late-id-old-time', 200), logRow('now', 0),
      ]);
      const seeded = await list();
      await engine.pruneAccessReadLog(365, 1_000_000);
      const afterAge = await list();
      await engine.pruneAccessReadLog(365, 4);
      const afterCapFour = await list();
      await engine.pruneAccessReadLog(365, 2);
      const afterCapTwo = await list();
      await engine.pruneAccessReadLog(365, 1_000_000);
      const stable = await list();
      await engine.pruneAccessReadLog(0, 5);
      const afterZeroDays = await list();
      // The log keeps counting ids after a prune emptied it.
      await engine.insertAccessReadLogRows([logRow('again', 0), logRow('again-2', 0)]);
      await engine.pruneAccessReadLog(365, 1);
      const afterRefill = await list();
      const result = { seeded, afterAge, afterCapFour, afterCapTwo, stable, afterZeroDays, afterRefill };
      expect(result).toEqual({
        seeded: ['now', 'day', 'week', 'late-id-old-time', 'old', 'ancient'],
        afterAge: ['now', 'day', 'week', 'late-id-old-time'],
        afterCapFour: ['now', 'day', 'week', 'late-id-old-time'],
        afterCapTwo: ['now', 'late-id-old-time'],
        stable: ['now', 'late-id-old-time'],
        afterZeroDays: [],
        afterRefill: ['again-2'],
      });
      return result;
    },
  );

  parityTest(
    'rows of one instant list newest id first, and a refused batch writes nothing',
    { methods: ['insertAccessReadLogRows', 'readAccessReadLog'] },
    async (engine) => {
      const at = ago(1);
      await engine.insertAccessReadLogRows(['first', 'second', 'third'].map((op) => logRow(op, 1, { created_at: at, audience: ['member:ada-example'] })));
      const before = await engine.readAccessReadLog({ since: ago(2), member: 'ada-example', limit: 10 });
      const refused = await engine
        .insertAccessReadLogRows([logRow('fine', 0), logRow('broken', 0, { result_code: null as unknown as string })])
        .then(() => false, () => true);
      const after = await engine.readAccessReadLog({ since: ago(2), member: null, limit: 10 });
      const result = { ops: before.map((e) => e.operation), audiences: before.map((e) => e.audience), atEqual: new Set(before.map((e) => new Date(e.created_at).getTime())).size, refused, after: after.map((e) => e.operation) };
      expect(result).toEqual({
        ops: ['third', 'second', 'first'], audiences: [['member:ada-example'], ['member:ada-example'], ['member:ada-example']], atEqual: 1,
        refused: true, after: ['third', 'second', 'first'],
      });
      return result;
    },
  );
});
