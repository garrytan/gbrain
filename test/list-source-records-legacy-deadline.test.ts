/**
 * `listSourceRecords` re-reads a brain whose `sources` table lacks `newest_content_at`, and then one that also lacks `archived`
 * (engine-sql/cli-reads-import.ts). Master issued each attempt as its own `executeRaw`. Under a read deadline (a doctor check, a
 * claim preparation) the Postgres engine runs a typed read in ONE transaction, where the first attempt's undefined-column error
 * (42703) aborts the transaction and the next attempt fails with 25P02 instead of returning the rows.
 *
 * Protects: under a read deadline, a brain missing `newest_content_at` (then also `archived`) still returns its source rows,
 * and a failure that is not a missing column propagates unchanged.
 * Fails when the fallback attempts share one deadline transaction.
 * No database: the engine runs on the recording fake, which models the failed-transaction state (25P02) of a reserved connection.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { withReadDeadline } from '../src/core/read-deadline.ts';
import { makeFakeSql, type FakeSql, type RecordedStatement } from './helpers/fake-postgres-sql.ts';

const ROW = { id: 'default', name: 'default', local_path: null, last_commit: null, last_sync_at: null, config: {}, created_at: '2026-01-01T00:00:00Z' };

function undefinedColumn(column: string): Error {
  return Object.assign(new Error(`column "${column}" does not exist`), { code: '42703' });
}

/** A fake whose transaction stays failed after a statement error until it rolls back, as Postgres's does. */
function engineWithShapes(missing: readonly string[], otherError?: Error) {
  let failedInBegin = -1;
  const holder: { fake?: FakeSql } = {};
  const responder = (stmt: RecordedStatement) => {
    const reserves = holder.fake!.trace.filter(entry => entry.kind === 'event' && entry.event === 'reserve').length;
    const inTransaction = stmt.lane === 'reserved';
    if (inTransaction && failedInBegin === reserves && !/^(ROLLBACK|COMMIT)/i.test(stmt.text)) return Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' });
    if (!/FROM sources/i.test(stmt.text)) return undefined;
    if (otherError) { if (inTransaction) failedInBegin = reserves; return otherError; }
    for (const column of missing) if (new RegExp(`\\b${column}\\b`).test(stmt.text)) { if (inTransaction) failedInBegin = reserves; return undefinedColumn(column); }
    return [ROW];
  };
  holder.fake = makeFakeSql(responder);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = holder.fake.sql;
  return { fake: holder.fake, engine };
}

const inDeadline = <T>(fn: () => Promise<T>) => withReadDeadline(Date.now() + 5_000, fn, new AbortController().signal);

test('a brain missing newest_content_at is re-read without it under a read deadline', async () => {
  const { engine } = engineWithShapes(['newest_content_at']);
  const rows = await inDeadline(() => engine.listSourceRecords());
  expect(rows.map(row => row.id)).toEqual(['default']);
});

test('a brain missing newest_content_at and archived is re-read with the historical columns under a read deadline', async () => {
  const { engine, fake } = engineWithShapes(['newest_content_at', 'archived']);
  const rows = await inDeadline(() => engine.listSourceRecords());
  expect(rows.map(row => row.id)).toEqual(['default']);
  expect(fake.statements().filter(stmt => /FROM sources/i.test(stmt.text))).toHaveLength(3);
});

test('a brain missing both columns is re-read without a deadline as well', async () => {
  const { engine } = engineWithShapes(['newest_content_at', 'archived']);
  expect((await engine.listSourceRecords()).map(row => row.id)).toEqual(['default']);
});

test('a failure that is not a missing column propagates under a read deadline', async () => {
  const boom = Object.assign(new Error('permission denied for table sources'), { code: '42501' });
  const { engine } = engineWithShapes([], boom);
  const error = await inDeadline(() => engine.listSourceRecords()).then(() => null, (e: unknown) => e);
  expect(error).toBe(boom);
});
