/**
 * `getConfig(key, { timeoutMs })` is the privacy notice's bounded config read (search/ignored-privacy-labels.ts sourceHasRepo).
 * Inside a request config snapshot that was never seeded, the plain read waits on the snapshot's bulk read first, and that bulk
 * read (`getAllConfig`) has no bound, so a locked `config` table kept the notice past its bound.
 *
 * Protects: a bounded read under an unseeded request snapshot sends only its own statement with the transaction-local bound
 * and never the whole-table read; under a loaded snapshot it answers from the snapshot with no statement; an unbounded read
 * still loads the snapshot once; a bulk read an invalidation replaced does not mark its successor loaded.
 * Fails when a bounded read starts or waits for the snapshot's bulk read.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { loadedRequestConfigValue, requestConfigRows, withoutRequestConfigSnapshot, withRequestConfigSnapshot } from '../src/core/config-snapshot.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

function engineWith(rows: Array<{ key: string; value: string }>) {
  const fake = makeFakeSql(stmt => {
    if (/FROM config/i.test(stmt.text) && /WHERE key/i.test(stmt.text)) return rows.filter(row => row.key === stmt.params[0]).map(row => ({ value: row.value }));
    if (/FROM config/i.test(stmt.text)) return rows;
    return undefined;
  });
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return { fake, engine };
}
const bulk = (texts: string[]) => texts.filter(text => /FROM config/i.test(text) && !/WHERE key/i.test(text));

test('a bounded read under an unseeded snapshot sends its own bounded statement and no whole-table read', async () => {
  const { fake, engine } = engineWith([{ key: 'sync.repo_path', value: '/repo' }]);
  const value = await withRequestConfigSnapshot(engine as never, () => engine.getConfig('sync.repo_path', { timeoutMs: 1_000 }));
  expect(value).toBe('/repo');
  const texts = fake.statements().map(stmt => stmt.text);
  expect(bulk(texts)).toEqual([]);
  expect(texts.some(text => /statement_timeout/i.test(text) || /WHERE key/i.test(text))).toBe(true);
});

test('a bounded read under a seeded snapshot answers from it and sends no statement', async () => {
  const { fake, engine } = engineWith([]);
  const value = await withRequestConfigSnapshot(engine as never, () => engine.getConfig('sync.repo_path', { timeoutMs: 1_000 }), { 'sync.repo_path': '/seeded' });
  expect(value).toBe('/seeded');
  expect(fake.statements()).toHaveLength(0);
});

test('an unbounded read under an unseeded snapshot still loads the snapshot once', async () => {
  const { fake, engine } = engineWith([{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
  const values = await withRequestConfigSnapshot(engine as never, async () => [await engine.getConfig('a'), await engine.getConfig('b')]);
  expect(values).toEqual(['1', '2']);
  expect(bulk(fake.statements().map(stmt => stmt.text))).toHaveLength(1);
});

test('a bounded read after the snapshot is loaded answers from it', async () => {
  const { fake, engine } = engineWith([{ key: 'a', value: '1' }]);
  const value = await withRequestConfigSnapshot(engine as never, async () => {
    await engine.getConfig('a');
    const before = fake.statements().length;
    const bounded = await engine.getConfig('a', { timeoutMs: 1_000 });
    return { bounded, extra: fake.statements().length - before };
  });
  expect(value).toEqual({ bounded: '1', extra: 0 });
});

/** An engine whose bulk reads the test settles one at a time. */
function gatedBulk() {
  const gates: Array<(rows: Record<string, string>) => void> = [];
  const engine = { getConfig: async () => null, getAllConfig: () => new Promise<Record<string, string>>(resolve => { gates.push(resolve); }) };
  return { engine, gates };
}
const settles = (p: Promise<unknown>) => Promise.race([p.then(() => true), Bun.sleep(60).then(() => false)]);

test('a bulk read that an invalidation replaced does not mark the next bulk read loaded', async () => {
  const { engine, gates } = gatedBulk();
  const outcome = await withRequestConfigSnapshot(engine, async () => {
    const first = requestConfigRows(engine);                       // bulk read A
    await Bun.sleep(5);
    await withoutRequestConfigSnapshot(async () => undefined);     // a write inside the request drops the snapshot
    const second = requestConfigRows(engine);                      // bulk read B
    await Bun.sleep(5);
    gates[0]!({ k: 'from-A' });                                    // A finishes, B is still pending
    await first;
    const bounded = loadedRequestConfigValue(engine, 'k');
    const answeredWhileBPending = await settles(bounded);
    gates[1]!({ k: 'from-B' });
    await second;
    return { answeredWhileBPending, afterB: await loadedRequestConfigValue(engine, 'k') };
  });
  expect(outcome).toEqual({ answeredWhileBPending: true, afterB: 'from-B' });
});

test('a loaded snapshot answers a bounded read, and an invalidation makes it unloaded again', async () => {
  const { engine, gates } = gatedBulk();
  const outcome = await withRequestConfigSnapshot(engine, async () => {
    const rows = requestConfigRows(engine);
    gates[0]!({ k: 'v' });
    await rows;
    const loaded = await loadedRequestConfigValue(engine, 'k');
    await withoutRequestConfigSnapshot(async () => undefined);
    return { loaded, afterInvalidation: await loadedRequestConfigValue(engine, 'k') };
  });
  expect(outcome).toEqual({ loaded: 'v', afterInvalidation: undefined });
});
