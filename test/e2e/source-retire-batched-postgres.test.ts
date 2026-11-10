/**
 * #7702 / #8905: a managed remove or purge of a large source deletes its pages in bounded batches, each in its own
 * short topology transaction, so no statement meets the 5 s topology bound; a retry with the same request_id
 * resumes after an interrupted batch and finishes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const PAGES = 60_000;
const STALL_AFTER = PAGES / 2;
const databaseUrl = requirePostgresTestDatabase();
let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
beforeAll(async () => {
  template = await persistencePostgresTemplate(databaseUrl, 4, async engine => {
    for (const id of ['retire-large', 'keep-other']) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
    await seed(engine, 'retire-large', PAGES);
    await seed(engine, 'keep-other', 50);
  });
}, 600_000);
afterAll(async () => { await template?.dispose(); });

async function seed(engine: BrainEngine, source: string, pages: number) {
  for (let from = 1; from <= pages; from += 5000) await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
    SELECT $1,'notes/p-'||g,'note','Page '||g,'Body of page '||g FROM generate_series($2::int,LEAST($2::int+4999,$3::int)) g`, [source, from, pages]);
  await engine.executeRaw(`INSERT INTO content_chunks(page_id,chunk_index,chunk_text)
    SELECT p.id,c,'chunk '||c||' of '||p.slug FROM pages p CROSS JOIN generate_series(0,2) c WHERE p.source_id=$1`, [source]);
  await engine.executeRaw(`INSERT INTO links(from_page_id,to_page_id) SELECT p.id,q.id FROM pages p
    JOIN pages q ON q.source_id=p.source_id AND q.slug='notes/p-'||(split_part(p.slug,'-',2)::int % $2::int + 1) WHERE p.source_id=$1`, [source, pages]);
}
async function counts(engine: BrainEngine, source: string) {
  const [row] = await engine.executeRaw<{ pages: number; chunks: number; links: number }>(`SELECT
    (SELECT count(*)::int FROM pages WHERE source_id=$1) AS pages,
    (SELECT count(*)::int FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1) AS chunks,
    (SELECT count(*)::int FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1) AS links`, [source]);
  return row;
}

describe('managed remove/purge of a large source (postgres)', () => {
  async function fixture(run: (engine: BrainEngine, source: string) => Promise<void>) {
    const { engine, close } = await template.clone();
    const home = mkdtempSync(join(tmpdir(), 'gbrain-retire-batched-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        await registerLocalWriter(engine, 'cli');
        for (const id of ['retire-large', 'keep-other']) {
          const root = join(home, id); mkdirSync(root);
          writeFileSync(join(root, 'example.md'), '---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
          await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [id, root]);
          await claimWorktree(engine, id, root);
        }
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run(engine, 'retire-large');
        expect(await counts(engine, 'keep-other')).toEqual({ pages: 50, chunks: 150, links: 50 });
      });
    } finally { await disposePersistenceConsumer(engine); await close(); rmSync(home, { recursive: true, force: true }); }
  }

  test('remove deletes every page, chunk and link of a source too large for one bounded statement', () => fixture(async (engine, source) => {
    const started = performance.now();
    const receipt = await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true })
      .finally(() => console.log(`[retire-batched] remove of ${PAGES} pages: ${Math.round(performance.now() - started)} ms`));
    expect(receipt).toMatchObject({ state: 'committed', operation: 'remove', pages_deleted: PAGES });
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [source])).toHaveLength(0);
    expect(await engine.executeRaw('SELECT source_id FROM persistence_source_bindings WHERE source_id=$1', [source])).toHaveLength(0);
    expect(await counts(engine, source)).toEqual({ pages: 0, chunks: 0, links: 0 });
  }), 300_000);

  test('purge of an archived large source completes', () => fixture(async (engine, source) => {
    await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: source });
    const receipt = await runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: source, confirmDestructive: true });
    expect(receipt).toMatchObject({ state: 'committed', operation: 'purge', pages_deleted: PAGES });
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [source])).toHaveLength(0);
    expect(await counts(engine, source)).toEqual({ pages: 0, chunks: 0, links: 0 });
  }), 300_000);

  test('a batch that times out keeps earlier batches and the same request_id resumes to completion', () => fixture(async (engine, source) => {
    await engine.executeRaw('CREATE TABLE retire_stall(armed boolean NOT NULL, seen integer NOT NULL)');
    await engine.executeRaw(`CREATE FUNCTION retire_stall_fn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n integer; BEGIN
      UPDATE retire_stall SET seen=seen+1 WHERE armed RETURNING seen INTO n;
      IF n = ${STALL_AFTER + 1} THEN PERFORM pg_sleep(6); END IF; RETURN OLD; END $$`);
    await engine.executeRaw('CREATE TRIGGER retire_stall BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION retire_stall_fn()');
    await engine.executeRaw('INSERT INTO retire_stall VALUES(true,0)');
    const requestId = randomUUID();
    const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
    await expect(remove()).rejects.toMatchObject({ code: 'write_pending' });
    const left = (await counts(engine, source)).pages;
    expect(left).toBe(PAGES - STALL_AFTER);
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [source])).toHaveLength(1);
    expect(await engine.executeRaw('SELECT id FROM persistence_topology_changes WHERE request_id=$1::uuid', [requestId])).toHaveLength(0);
    await engine.executeRaw('DELETE FROM retire_stall');
    const receipt = await remove();
    expect(receipt).toMatchObject({ state: 'committed', operation: 'remove', pages_deleted: left });
    expect(await remove()).toEqual(receipt);
    expect(await counts(engine, source)).toEqual({ pages: 0, chunks: 0, links: 0 });
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [source])).toHaveLength(0);
  }), 300_000);
});
