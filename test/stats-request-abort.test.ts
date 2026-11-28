/**
 * `getStats` sends three statements on the pool's raw tagged SQL (the embedding-registry lookup, one aggregate, one GROUP BY),
 * none of which checked the request. The import's end-of-run schema warning reads it where master ran one guarded `executeRaw`
 * count, so a request cancelled while the registry lookup was awaited still sent the heavy aggregate and the GROUP BY, which
 * can wait on a table lock nobody is waiting for.
 *
 * Protects: a request cancelled before `getStats`, or while its registry lookup is awaited, or while the aggregate runs,
 * rejects with the request's AbortError and sends no further statement; an uncancelled call still sends its three statements
 * and answers the counts.
 * Fails when `getStats` sends the aggregate or the GROUP BY for a request that is already cancelled.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { makeFakeSql, type RecordedStatement } from './helpers/fake-postgres-sql.ts';

const AGGREGATE = { page_count: '3', chunk_count: '4', embedded_count: '1', link_count: '2', tag_count: '5', timeline_entry_count: '6' };
// The registry lookup is the typed config read (getConfigValues) on the Rust engine trunk, not master's raw search_embedding_column statement.
const kind = (stmt: RecordedStatement) => /search_embedding_column|FROM config WHERE key = ANY/.test(stmt.text) ? 'registry' : /GROUP BY type/.test(stmt.text) ? 'types' : /page_count/.test(stmt.text) ? 'aggregate' : 'other';

/** The engine on a fake that answers each of the three statements; `onStatement` runs as one is sent. */
function engineWith(onStatement: (what: string) => void = () => undefined) {
  const fake = makeFakeSql(stmt => {
    const what = kind(stmt);
    onStatement(what);
    return what === 'aggregate' ? [AGGREGATE] : what === 'types' ? [{ type: 'note', count: 3 }] : [];
  });
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const sent = () => fake.statements().map(kind);
  return { engine, sent };
}

const run = (signal: AbortSignal, engine: PostgresEngine) => withRequestSignal(signal, () => engine.getStats({ sourceId: 'default' })).then(() => null, (e: unknown) => e as Error);

test('a request already cancelled sends no statement', async () => {
  const controller = new AbortController();
  controller.abort(new Error('client went away'));
  const { engine, sent } = engineWith();
  const error = await run(controller.signal, engine);
  expect(error?.name).toBe('AbortError');
  expect(sent()).toEqual([]);
});

test('a request cancelled while the registry lookup is awaited sends neither the aggregate nor the GROUP BY', async () => {
  const controller = new AbortController();
  const { engine, sent } = engineWith(what => { if (what === 'registry') controller.abort(new Error('client went away')); });
  const error = await run(controller.signal, engine);
  expect(error?.name).toBe('AbortError');
  expect(error?.message).toBe('client went away');
  expect(sent()).toEqual(['registry']);
});

test('a request cancelled while the aggregate runs does not send the GROUP BY', async () => {
  const controller = new AbortController();
  const { engine, sent } = engineWith(what => { if (what === 'aggregate') controller.abort(new Error('client went away')); });
  const error = await run(controller.signal, engine);
  expect(error?.name).toBe('AbortError');
  expect(sent()).toEqual(['registry', 'aggregate']);
});

test('an uncancelled request sends its three statements and answers the counts', async () => {
  const { engine, sent } = engineWith();
  const stats = await withRequestSignal(new AbortController().signal, () => engine.getStats({ sourceId: 'default' }));
  expect(sent()).toEqual(['registry', 'aggregate', 'types']);
  expect(stats).toEqual({ page_count: 3, chunk_count: 4, embedded_count: 1, link_count: 2, tag_count: 5, timeline_entry_count: 6, pages_by_type: { note: 3 } });
  // No request at all (the CLI, the doctor) is not a cancelled one.
  const plain = engineWith();
  expect((await plain.engine.getStats()).page_count).toBe(3);
});
