/**
 * `getConfig(key, { timeoutMs })` is the privacy notice's bounded config read (search/ignored-privacy-labels.ts sourceHasRepo).
 * Master's notice read was one raw statement the server ended at the bound. Inside a request config snapshot that was never
 * seeded, the plain read waits on the snapshot's bulk read first, and that bulk read (`getAllConfig`) has no bound, so a locked
 * `config` table kept the notice past its bound.
 *
 * A bounded read therefore takes no part in the request snapshot at all: it always sends its own bounded statement and answers
 * what the table holds now. The cost is one extra bounded statement per notice read under a seeded or loaded snapshot.
 *
 * Protects: a bounded read under an unseeded, seeded or loaded snapshot sends exactly its own statement with the
 * transaction-local bound, never the whole-table read, and answers the live value; after a write made mid-request (even while
 * the snapshot's bulk read is pending) it agrees with the live config; an unbounded read still loads the snapshot once and
 * answers from it, write-through included.
 * Fails when a bounded read starts or waits for the snapshot's bulk read, or answers from the snapshot.
 * No database: the engine runs on the recording fake, which keeps a live config table.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { withRequestConfigSnapshot } from '../src/core/config-snapshot.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

/** The engine on a fake with a live config table; `gateBulk` holds the first whole-table read until the test releases it. */
function engineWith(initial: Record<string, string>, opts: { gateBulk?: boolean } = {}) {
  const live = new Map(Object.entries(initial));
  let release: () => void = () => undefined;
  let gated = !!opts.gateBulk;
  const fake = makeFakeSql(stmt => {
    if (/INSERT INTO config/i.test(stmt.text)) { live.set(String(stmt.params[0]), String(stmt.params[1])); return []; }
    if (/FROM config/i.test(stmt.text) && /WHERE key/i.test(stmt.text)) return live.has(String(stmt.params[0])) ? [{ value: live.get(String(stmt.params[0])) }] : [];
    if (/FROM config/i.test(stmt.text)) {
      const rows = () => [...live].map(([key, value]) => ({ key, value }));
      if (!gated) return rows();
      gated = false;
      return new Promise<unknown[]>(resolve => { release = () => resolve(rows()); });
    }
    return undefined;
  });
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const texts = () => fake.statements().map(stmt => stmt.text);
  return { fake, engine, live, texts, release: () => release() };
}
const bulk = (texts: string[]) => texts.filter(text => /FROM config/i.test(text) && !/WHERE key/i.test(text));

test('a bounded read under an unseeded snapshot sends its own bounded statement and no whole-table read', async () => {
  const { engine, texts } = engineWith({ 'sync.repo_path': '/repo' });
  const value = await withRequestConfigSnapshot(engine as never, () => engine.getConfig('sync.repo_path', { timeoutMs: 1_000 }));
  expect(value).toBe('/repo');
  expect(bulk(texts())).toEqual([]);
  // The transaction-local bound, then the keyed SELECT.
  expect(texts().some(text => /SET LOCAL statement_timeout = 1000/i.test(text))).toBe(true);
  expect(texts().filter(text => /WHERE key/i.test(text))).toHaveLength(1);
});

test('a bounded read under a seeded snapshot sends its own bounded statement and answers the live value (the cost: one statement)', async () => {
  const { engine, texts } = engineWith({ 'sync.repo_path': '/live' });
  const value = await withRequestConfigSnapshot(engine as never, () => engine.getConfig('sync.repo_path', { timeoutMs: 1_000 }), { 'sync.repo_path': '/seeded' });
  expect(value).toBe('/live');
  expect(texts().filter(text => /FROM config/i.test(text))).toHaveLength(1);
  expect(bulk(texts())).toEqual([]);
});

test('a bounded read after the snapshot is loaded sends its own statement and answers the live value', async () => {
  const { engine, texts, live } = engineWith({ a: '1' });
  const out = await withRequestConfigSnapshot(engine as never, async () => {
    expect(await engine.getConfig('a')).toBe('1');                 // loads the snapshot (one whole-table read)
    live.set('a', '2');                                            // another writer
    const before = texts().length;
    const boundedValue = await engine.getConfig('a', { timeoutMs: 1_000 });
    return { boundedValue, extra: texts().slice(before).filter(text => /FROM config/i.test(text)).length, unbounded: await engine.getConfig('a') };
  });
  expect(out).toEqual({ boundedValue: '2', extra: 1, unbounded: '1' });
  expect(bulk(texts())).toHaveLength(1);
});

test('after a write made while the snapshot\'s bulk read is pending, a bounded read sends its own statement and agrees with the live config', async () => {
  const { engine, texts, live, release } = engineWith({ k: 'old' }, { gateBulk: true });
  const out = await withRequestConfigSnapshot(engine as never, async () => {
    const all = engine.getAllConfig();                             // the snapshot's bulk read starts and stays pending
    await Bun.sleep(5);
    await engine.setConfig('k', 'new');                            // a write-through while it is pending
    release();
    const snapshot = await all;
    const before = texts().length;
    const boundedValue = await engine.getConfig('k', { timeoutMs: 1_000 });
    return { snapshotK: snapshot.k, boundedValue, live: live.get('k'), own: texts().slice(before).filter(text => /WHERE key/i.test(text)).length, unbounded: await engine.getConfig('k') };
  });
  expect(out).toEqual({ snapshotK: 'new', boundedValue: 'new', live: 'new', own: 1, unbounded: 'new' });
});

test('an unbounded read under an unseeded snapshot still loads the snapshot once', async () => {
  const { engine, texts } = engineWith({ a: '1', b: '2' });
  const values = await withRequestConfigSnapshot(engine as never, async () => [await engine.getConfig('a'), await engine.getConfig('b')]);
  expect(values).toEqual(['1', '2']);
  expect(bulk(texts())).toHaveLength(1);
});
