/** Actual source backlogs and datastore ownership across delayed providers. */
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireLock, inspectLockHolder, PgliteBusyError } from '../src/core/pglite-lock.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { scheduleDeferredSyncEmbeds, maybeDrainDeferredEmbeds, __deferredEmbedsPendingForTests,
  __resetDelegatedSyncForTests } from '../src/core/serve-sync-runner.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';

const model = 'openai:text-embedding-3-small';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function vectors(values: string[]) { return { embeddings: values.map(() => new Array(1536).fill(0.01)), usage: { tokens: values.length } } as never; }
async function fixture(run: (make: (name: string) => Promise<{ engine: PGLiteEngine; path: string }>) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-drain-'));
  const engines: PGLiteEngine[] = [];
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ engine: 'pglite', embedding_model: model,
    embedding_dimensions: 1536, openai_api_key: 'synthetic-deferred-embed-key' }));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
      GBRAIN_EMBED_CONCURRENCY: '1', GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
      __resetDelegatedSyncForTests();
      configureGateway({ embedding_model: model, embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'synthetic-deferred-embed-key' } });
      __setEmbedTransportForTests(async ({ values }) => vectors(values));
      try {
        await run(async name => {
          const engine = new PGLiteEngine(), path = join(home, name); engines.push(engine);
          await engine.connect({ database_path: path }); await engine.initSchema();
          return { engine, path };
        });
      } finally {
        for (const engine of engines) await engine.disconnect();
        __resetDelegatedSyncForTests(); __setEmbedTransportForTests(null); resetGateway();
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}
async function seed(engine: PGLiteEngine, sourceId: string) {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
  await engine.putPage('notes/example', { type: 'note', title: `${sourceId} Example`, compiled_truth: `Observation from ${sourceId}.` }, { sourceId });
  await installFixtureChunks(engine, 'notes/example', [{ chunk_index: 0, chunk_source: 'compiled_truth',
    chunk_text: `Observation from ${sourceId}.`, token_count: 5 }], { sourceId });
}
async function embedded(engine: PGLiteEngine, sourceId: string) {
  const chunks = await engine.getChunks('notes/example', { sourceId });
  return chunks.length === 1 && chunks[0].embedding_is_null === false;
}

test('pending sources are retained separately for each engine', async () => fixture(async make => {
  const a = await make('a'), b = await make('b');
  await seed(a.engine, 'alpha'); await seed(a.engine, 'beta'); await seed(b.engine, 'alpha');
  scheduleDeferredSyncEmbeds(a.engine, 'alpha'); scheduleDeferredSyncEmbeds(a.engine, 'beta');
  scheduleDeferredSyncEmbeds(b.engine, 'alpha');
  const stdout: unknown[][] = [], originalLog = console.log;
  console.log = (...args: unknown[]) => { stdout.push(args); };
  try { await maybeDrainDeferredEmbeds(a.engine); }
  finally { console.log = originalLog; }
  expect(stdout).toEqual([]); // The resident stdio owner's protocol stays clean.
  expect(await embedded(a.engine, 'alpha')).toBe(true);
  expect(await embedded(a.engine, 'beta')).toBe(true);
  expect(await embedded(b.engine, 'alpha')).toBe(false);
  await maybeDrainDeferredEmbeds(b.engine);
  expect(await embedded(b.engine, 'alpha')).toBe(true);
  await maybeDrainDeferredEmbeds(a.engine); await maybeDrainDeferredEmbeds(b.engine);
  expect(__deferredEmbedsPendingForTests()).toBe(false);
}), 90_000);

test('a source queued again during an empty drain remains scheduled', async () => fixture(async make => {
  const { engine } = await make('requeue');
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('alpha','alpha')");
  const original = engine.countStaleChunks;
  let queued = false;
  engine.countStaleChunks = async function (this: PGLiteEngine, options) {
    const count = await original.call(this, options);
    if (!queued && options?.sourceId === 'alpha' && count === 0) {
      queued = true; scheduleDeferredSyncEmbeds(this, 'alpha');
    }
    return count;
  };
  try {
    scheduleDeferredSyncEmbeds(engine, 'alpha'); await maybeDrainDeferredEmbeds(engine);
    expect(queued).toBe(true); expect(__deferredEmbedsPendingForTests(engine)).toBe(true);
  } finally { engine.countStaleChunks = original; }
  await seed(engine, 'alpha');
  await maybeDrainDeferredEmbeds(engine);
  expect(await embedded(engine, 'alpha')).toBe(true);
}), 60_000);

test('disconnect retains the native owner until an abort-ignoring provider settles', async () => fixture(async make => {
  const { engine, path } = await make('close');
  await seed(engine, 'alpha');
  const entered = deferred(), gate = deferred();
  __setEmbedTransportForTests(async ({ values }) => { entered.resolve(); await gate.promise; return vectors(values); });
  scheduleDeferredSyncEmbeds(engine, 'alpha');
  const draining = maybeDrainDeferredEmbeds(engine);
  let closing: Promise<void> | undefined;
  try {
    await Promise.race([entered.promise, Bun.sleep(15_000).then(() => { throw new Error('Provider did not start'); })]);
    let closed = false;
    closing = engine.disconnect().then(() => { closed = true; });
    await Bun.sleep(50);
    expect(closed).toBe(false); expect(inspectLockHolder(path).held).toBe(true);
    await expect(acquireLock(path, { timeoutMs: 30 })).rejects.toBeInstanceOf(PgliteBusyError);
  } finally { gate.resolve(); await draining; await closing; }
  expect(inspectLockHolder(path).held).toBe(false);
  await engine.connect({ database_path: path });
  expect((await engine.executeRaw<{ n: number }>('SELECT 1 AS n'))[0].n).toBe(1);
}), 60_000);
