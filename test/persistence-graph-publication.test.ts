import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { autoLinkWrittenPage } from '../src/core/ops/pages.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'graph-publication';
const ctx = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: engine.kind }, sourceId,
  remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } });
const put = (engine: BrainEngine, slug: string, body: string, revision?: string) => submitPageMutation(ctx(engine), {
  operation: 'put_page', params: { slug, content: `---\ntitle: ${slug}\n---\n\n${body}`,
    request_id: randomUUID(), ...(revision ? { expected_revision: revision } : {}) },
});
beforeAll(async () => {
  const local = new PGLiteEngine(); await local.connect({}); await local.initSchema(); engines.push(local);
  if (process.env.DATABASE_URL) {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(isolated.engine); closePostgres = isolated.close;
  }
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.setConfig('auto_link', 'true');
    await put(engine, 'people/alice-example', 'First reference target.');
    await put(engine, 'people/bob-example', 'Second reference target.');
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
});

test('concurrent replacements commit exactly the graph belonging to the winning revision', async () => {
  for (const engine of engines) {
    const slug = 'meetings/racing';
    await put(engine, slug, 'Original narrative.');
    const original = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const results = await Promise.allSettled([
      put(engine, slug, 'Discuss people/alice-example.', original.revision),
      put(engine, slug, 'Discuss people/bob-example.', original.revision),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason.code).toBe('revision_conflict');
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const target = snapshot.page.compiled_truth.includes('people/alice-example') ? 'people/alice-example' : 'people/bob-example';
    expect((await engine.getLinks(slug, { sourceId })).map(link => link.to_slug)).toEqual([target]);
    expect(snapshot.revision).not.toBe(original.revision);
  }
});

test('delayed reconciliation cannot install links from an older canonical snapshot', async () => {
  for (const engine of engines) {
    const slug = 'meetings/delayed';
    await put(engine, slug, 'Discuss people/alice-example.');
    await disposePersistenceConsumer(engine);
    const original = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const transaction = engine.transaction;
    let intercepted = false;
    engine.transaction = async function<T>(run: (tx: BrainEngine) => Promise<T>): Promise<T> {
      if (!intercepted) {
        intercepted = true;
        engine.transaction = transaction;
        await put(engine, slug, 'Discuss people/bob-example.', original.revision);
      }
      return transaction.call(engine, run) as Promise<T>;
    };
    try { await autoLinkWrittenPage(engine, slug, { sourceId }); }
    finally { engine.transaction = transaction; }
    expect(intercepted).toBe(true);
    expect((await engine.getLinks(slug, { sourceId })).map(link => link.to_slug)).toEqual(['people/bob-example']);
  }
});
