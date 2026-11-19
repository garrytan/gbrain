/**
 * #5983: on a managed brain whose tags / timeline_entries / takes carry a
 * nullable source_id column (not created by foresights; every value NULL), the
 * managed writer guard read the NULL column instead of the parent page and
 * refused every coordinated INSERT/UPDATE as writer_coordinator_required.
 *
 * Contract: page children resolve their source through pages, so any
 * source_id column on them is ignored, NULL or not. Coordinated writes commit,
 * and everything the canonical schema refuses (no coordinator, another source,
 * a drifted value naming the allowed source) is still refused. Runs on PGLite
 * and, through test/e2e, Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { installPre5983Guard } from './helpers/pre-5983-guard.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-5983-db-'));
let closePostgres: (() => Promise<void>) | undefined;
const CHILDREN = ['tags', 'timeline_entries', 'takes'] as const;
const REFUSED = /writer_coordinator_required: canonical writer must use the persistence coordinator/;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    for (const table of CHILDREN) await engine.executeRaw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source_id TEXT`);
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

async function pageIn(engine: BrainEngine, sourceId: string): Promise<number> {
  await engine.executeRaw(`INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT (id) DO NOTHING`, [sourceId]);
  const slug = `notes/p-${randomUUID().slice(0, 8)}`;
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,$2,'note','P','body') RETURNING id`, [sourceId, slug]);
  return row.id;
}

/** Runs `sql` with the guard on and `writeSources` as the coordinator's allowed set (undefined: no coordinator). */
async function guarded(engine: BrainEngine, writeSources: string[] | undefined, sql: string, params: unknown[]) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  try {
    await engine.transaction(async tx => {
      if (writeSources) await tx.executeRaw(`SELECT set_config('gbrain.write_sources',$1,true)`, [JSON.stringify(writeSources)]);
      await tx.executeRaw(sql, params);
    });
  } finally {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  }
}

const INSERTS: Record<(typeof CHILDREN)[number], string> = {
  tags: `INSERT INTO tags(page_id,tag,tag_source) VALUES($1,'probe','added')`,
  timeline_entries: `INSERT INTO timeline_entries(page_id,date,source,summary) VALUES($1,'2026-10-01','test','probe')`,
  takes: `INSERT INTO takes(page_id,row_num,claim,kind,holder) VALUES($1,1,'probe','take','alice-example')`,
};
/** A drifted source_id naming the allowed source on a child of a page in another source. */
const CLAIMING_INSERTS: Record<(typeof CHILDREN)[number], string> = {
  tags: `INSERT INTO tags(page_id,tag,tag_source,source_id) VALUES($1,'probe','added','default')`,
  timeline_entries: `INSERT INTO timeline_entries(page_id,date,source,summary,source_id) VALUES($1,'2026-10-01','test','probe','default')`,
  takes: `INSERT INTO takes(page_id,row_num,claim,kind,holder,source_id) VALUES($1,1,'probe','take','alice-example','default')`,
};
const UPDATES: Record<(typeof CHILDREN)[number], string> = {
  tags: `UPDATE tags SET tag=tag||'x' WHERE page_id=$1`,
  timeline_entries: `UPDATE timeline_entries SET detail=COALESCE(detail,'')||'x' WHERE page_id=$1`,
  takes: `UPDATE takes SET claim=claim||'x' WHERE page_id=$1`,
};
const DELETES: Record<(typeof CHILDREN)[number], string> = {
  tags: `DELETE FROM tags WHERE page_id=$1`,
  timeline_entries: `DELETE FROM timeline_entries WHERE page_id=$1`,
  takes: `DELETE FROM takes WHERE page_id=$1`,
};
const count = async (engine: BrainEngine, table: string, pageId: number) =>
  Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE page_id=$1`, [pageId]))[0].n);

test('coordinated INSERT, UPDATE and DELETE on NULL-source_id children of a page in the allowed source commit', async () => {
  for (const engine of engines) {
    for (const table of CHILDREN) {
      const pageId = await pageIn(engine, 'default');
      await guarded(engine, ['default'], INSERTS[table], [pageId]);
      expect(await count(engine, table, pageId)).toBe(1);
      await guarded(engine, ['default'], UPDATES[table], [pageId]);
      await guarded(engine, ['default'], DELETES[table], [pageId]);
      expect(await count(engine, table, pageId)).toBe(0);
    }
  }
});

test('the guard still refuses NULL-source_id child writes without the coordinator or for another source', async () => {
  for (const engine of engines) {
    for (const table of CHILDREN) {
      const pageId = await pageIn(engine, 'default');
      await expect(guarded(engine, undefined, INSERTS[table], [pageId])).rejects.toThrow(REFUSED);
      await expect(guarded(engine, ['other-source'], INSERTS[table], [pageId])).rejects.toThrow(REFUSED);
      await engine.executeRaw(INSERTS[table], [pageId]);
      await expect(guarded(engine, undefined, UPDATES[table], [pageId])).rejects.toThrow(REFUSED);
      await expect(guarded(engine, ['other-source'], UPDATES[table], [pageId])).rejects.toThrow(REFUSED);
      await expect(guarded(engine, undefined, DELETES[table], [pageId])).rejects.toThrow(REFUSED);
      await expect(guarded(engine, ['other-source'], DELETES[table], [pageId])).rejects.toThrow(REFUSED);
      expect(await count(engine, table, pageId)).toBe(1);
    }
  }
});

test('a populated drifted source_id is ignored: the parent page decides the source', async () => {
  for (const engine of engines) {
    for (const table of CHILDREN) {
      const pageId = await pageIn(engine, 'default');
      await engine.executeRaw(INSERTS[table], [pageId]);
      await engine.executeRaw(`UPDATE ${table} SET source_id='elsewhere' WHERE page_id=$1`, [pageId]);
      await guarded(engine, ['default'], UPDATES[table], [pageId]);
      await expect(guarded(engine, ['elsewhere'], UPDATES[table], [pageId])).rejects.toThrow(REFUSED);
      const foreignPage = await pageIn(engine, 'elsewhere');
      await expect(guarded(engine, ['default'], CLAIMING_INSERTS[table], [foreignPage])).rejects.toThrow(REFUSED);
      const moveTo = `UPDATE ${table} SET page_id=$2 WHERE page_id=$1`;
      await expect(guarded(engine, ['elsewhere'], moveTo, [pageId, foreignPage])).rejects.toThrow(REFUSED);
      await guarded(engine, ['default', 'elsewhere'], moveTo, [pageId, foreignPage]);
      expect(await count(engine, table, foreignPage)).toBe(1);
    }
  }
});

test('deleting a page still cascades its NULL-source_id children', async () => {
  for (const engine of engines) {
    const pageId = await pageIn(engine, 'default');
    for (const table of CHILDREN) await engine.executeRaw(INSERTS[table], [pageId]);
    await guarded(engine, ['default'], 'DELETE FROM pages WHERE id=$1', [pageId]);
    for (const table of CHILDREN) expect(await count(engine, table, pageId)).toBe(0);
  }
});

test('a managed put_page of a tagged page with timeline lines commits on a brain with the drifted columns', async () => {
  const logger = { info() {}, warn() {}, error() {} };
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-5983-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `s5983-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
        const slug = 'people/alice-example';
        const content = '---\ntitle: Alice Example\ntype: person\ntags: [founder, example]\n---\nAlice builds things.\n\n---\n\n- **2026-09-30** | Met at demo day';
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID() } });
        const [request] = await engine.executeRaw<{ state: string; error_message: string | null }>(
          `SELECT state,error_message FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence DESC LIMIT 1`, [sourceId, slug]);
        expect(request).toEqual({ state: 'committed', error_message: null });
        expect((await engine.getTags(slug, { sourceId })).sort()).toEqual(['example', 'founder']);
        expect((await engine.getTimeline(slug, { sourceId })).map(entry => entry.summary)).toEqual(['Met at demo day']);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 120_000);

test('upgrading a v196 brain with the pre-fix guard: v197 unblocks the refused write and is idempotent', async () => {
  const v197 = MIGRATIONS.find(migration => migration.version === 197)!;
  for (const engine of engines) {
    await installPre5983Guard(engine);
    const pageId = await pageIn(engine, 'default');
    await expect(guarded(engine, ['default'], INSERTS.tags, [pageId])).rejects.toThrow(REFUSED);
    const triggers = `SELECT tgrelid::regclass::text AS tbl, oid FROM pg_trigger WHERE tgname='managed_writer_guard' ORDER BY 1`;
    const before = await engine.executeRaw(triggers);
    for (let run = 0; run < 2; run++) {
      await engine.setConfig('version', '196');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      expect((await runMigrations(engine)).current).toBeGreaterThanOrEqual(197);
      await guarded(engine, ['default'], INSERTS.tags.replace("'probe'", `'probe-${run}'`), [pageId]);
      expect(await count(engine, 'tags', pageId)).toBe(run + 1);
      await expect(guarded(engine, undefined, INSERTS.tags.replace("'probe'", "'uncoordinated'"), [pageId])).rejects.toThrow(REFUSED);
    }
    expect(v197.sql).not.toMatch(/\b(TRIGGER|ALTER TABLE|LOCK)\b/);
    expect(await engine.executeRaw(triggers)).toEqual(before);
  }
}, 120_000);
