import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { withEnv } from '../helpers/with-env.ts';
import { phaseCGrandfather } from '../../src/commands/migrations/v0_13_1.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

function afterTransactionQuery(engine: BrainEngine, after: (tx: BrainEngine, query: string) => Promise<void>): BrainEngine {
  return new Proxy(engine, {
    get(target, property) {
      if (property === 'transaction') {
        return <T>(run: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => run(new Proxy(tx, {
          get(transaction, key) {
            if (key === 'executeRaw') {
              return async <R>(query: string, params?: unknown[]) => {
                const rows = await transaction.executeRaw<R>(query, params);
                await after(transaction, query);
                return rows;
              };
            }
            const value = Reflect.get(transaction, key);
            return typeof value === 'function' ? value.bind(transaction) : value;
          },
        })));
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function sealedPage(engine: BrainEngine, slug: string, text: string, frontmatter: Record<string, unknown> = {}) {
  await engine.putPage(slug, {
    type: 'concept', title: 'Migration Fixture', compiled_truth: text, timeline: '', frontmatter,
  }, { sourceId: 'default' });
  await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' }], { sourceId: 'default' });
}

function persistedPages(engine: BrainEngine) {
  return engine.executeRaw(`SELECT id, source_id, slug, frontmatter, compiled_truth,
    knowledge_revision, text_projection_revision, deleted_at FROM pages ORDER BY id`);
}

describe.skipIf(!hasDatabase())('Postgres grandfather migration projection publication', () => {
  test('preserves sealed duplicate slugs across sources without certifying incomplete text', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-grandfather-pg-'));
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const engine = pg.engine;
    try {
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('secondary','Secondary')");
      const slug = 'concepts/search-example';
      const before = new Map<string, string | undefined>();
      for (const sourceId of ['default', 'secondary']) {
        await engine.putPage(slug, {
          type: 'concept', title: 'Search Example', compiled_truth: 'amberbadger migration fixture', timeline: '', frontmatter: {},
        }, { sourceId });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: 'amberbadger migration fixture', chunk_source: 'compiled_truth' }], { sourceId });
        before.set(sourceId, (await engine.getPage(slug, { sourceId }))?.knowledge_revision);
        expect(await engine.searchKeyword('amberbadger', { sourceId })).toHaveLength(1);
      }
      await engine.putPage('concepts/unsealed-example', {
        type: 'concept', title: 'Unsealed Example', compiled_truth: 'Incomplete projection.', timeline: '', frontmatter: {},
      }, { sourceId: 'default' });
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const result = await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true });
        expect(result.result.status).toBe('complete');
        expect(result.detail.touched).toBe(3);
        for (const sourceId of ['default', 'secondary']) {
          const page = await engine.getPage(slug, { sourceId });
          expect(page?.knowledge_revision).not.toBe(before.get(sourceId));
          expect(page?.text_projection_revision).toBe(page?.knowledge_revision);
          expect(page?.frontmatter.validate).toBe(false);
          expect(await engine.searchKeyword('amberbadger', { sourceId })).toHaveLength(1);
        }
        expect((await engine.getPage('concepts/unsealed-example', { sourceId: 'default' }))?.text_projection_revision).toBeNull();
        expect(await engine.executeRaw('SELECT slug FROM page_projection_jobs')).toEqual([{ slug: 'concepts/unsealed-example' }]);
        expect((await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true })).detail.touched).toBe(0);
      });
    } finally {
      await pg.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('waits for a canonical page guard and preserves the competing writer validation decision', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-grandfather-writer-pg-'));
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const engine = pg.engine;
    const releaseWriter = Promise.withResolvers<void>();
    let writer: Promise<void> | undefined;
    let migration: ReturnType<typeof phaseCGrandfather> | undefined;
    try {
      const slug = 'concepts/validation-example';
      await sealedPage(engine, slug, 'cedarmarten original fixture');
      const ready = Promise.withResolvers<void>();
      let writerRows: Awaited<ReturnType<typeof persistedPages>> = [];
      const coordinated = afterTransactionQuery(engine, async (_tx, query) => {
        if (!query.startsWith('SELECT id, slug, source_id FROM pages') || writer) return;
        writer = engine.transaction(async tx => {
          await tx.lockPageKeys([{ sourceId: 'default', slug }]);
          await sealedPage(tx, slug, 'topazotter competing fixture', { validate: true, decision: 'keep-validation' });
          writerRows = await persistedPages(tx);
          ready.resolve();
          await releaseWriter.promise;
        });
        void writer.catch(ready.reject);
        await ready.promise;
      });
      migration = withEnv({ GBRAIN_HOME: home }, () => phaseCGrandfather(coordinated, {
        yes: true, dryRun: false, noAutopilotInstall: true,
      }));
      let blockedOnGuard = false;
      try {
        for (let attempt = 0; attempt < 200; attempt++) {
          const waiting = await engine.executeRaw(`SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%page_write_guards%'`);
          if (waiting.length) {
            blockedOnGuard = true;
            break;
          }
          await Bun.sleep(25);
        }
      } finally {
        releaseWriter.resolve();
      }
      await writer;
      const result = await migration;
      expect(blockedOnGuard).toBe(true);
      expect(writerRows).toHaveLength(1);
      expect(result.result.status).toBe('complete');
      expect(result.detail).toMatchObject({ touched: 0, skipped: 1, failed: 0 });
      expect(await persistedPages(engine)).toEqual(writerRows);
      const page = await engine.getPage(slug, { sourceId: 'default' });
      expect(page?.frontmatter).toEqual({ validate: true, decision: 'keep-validation' });
      expect(page?.text_projection_revision).toBe(page?.knowledge_revision);
      expect((await engine.searchKeyword('topazotter', { sourceId: 'default' })).map(hit => hit.slug)).toEqual([slug]);
      expect(await engine.searchKeyword('cedarmarten', { sourceId: 'default' })).toHaveLength(0);
    } finally {
      releaseWriter.resolve();
      await Promise.allSettled([writer, migration]);
      await pg.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  for (const change of ['delete', 'rename'] as const) {
    test(`handles a selected identity ${change} without grandfathering its replacement`, async () => {
      const home = mkdtempSync(join(tmpdir(), `gbrain-grandfather-${change}-pg-`));
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      const engine = pg.engine;
      try {
        const slug = 'concepts/identity-example';
        const renamed = 'concepts/renamed-example';
        const sibling = 'concepts/sibling-example';
        await sealedPage(engine, slug, 'cedarmarten selected fixture');
        await sealedPage(engine, sibling, 'violetfox sibling fixture');
        const original = await engine.getPage(slug, { sourceId: 'default' });
        let interleaved = false;
        let writerRows: Awaited<ReturnType<typeof persistedPages>> = [];
        const coordinated = afterTransactionQuery(engine, async (_tx, query) => {
          if (!query.startsWith('SELECT id, slug, source_id FROM pages') || interleaved) return;
          interleaved = true;
          await engine.transaction(async tx => {
            await tx.lockPageKeys([{ sourceId: 'default', slug }, { sourceId: 'default', slug: renamed }]);
            if (change === 'rename') {
              await tx.updateSlug(slug, renamed, { sourceId: 'default' });
              await installFixtureChunks(tx, renamed, [{ chunk_index: 0, chunk_text: 'cedarmarten selected fixture', chunk_source: 'compiled_truth' }], { sourceId: 'default' });
            } else {
              await tx.deletePage(slug, { sourceId: 'default' });
            }
            await sealedPage(tx, slug, 'topazotter replacement fixture', { owner: 'replacement' });
          });
          writerRows = await persistedPages(engine);
        });
        const result = await withEnv({ GBRAIN_HOME: home }, () => phaseCGrandfather(coordinated, {
          yes: true, dryRun: false, noAutopilotInstall: true,
        }));
        expect(interleaved).toBe(true);
        const replacement = await engine.getPage(slug, { sourceId: 'default' });
        expect(replacement?.id).not.toBe(original?.id);
        expect(replacement?.frontmatter).toEqual({ owner: 'replacement' });
        expect(replacement?.text_projection_revision).toBe(replacement?.knowledge_revision);
        expect((await engine.searchKeyword('topazotter', { sourceId: 'default' })).map(hit => hit.slug)).toEqual([slug]);
        if (change === 'rename') {
          expect(result.result.status).toBe('failed');
          expect(result.detail).toMatchObject({ touched: 0, failed: 2 });
          expect(result.detail.failures.join(' ')).toContain('Page identity changed');
          expect(await persistedPages(engine)).toEqual(writerRows);
          expect((await engine.getPage(renamed, { sourceId: 'default' }))?.id).toBe(original?.id);
          expect((await engine.searchKeyword('cedarmarten', { sourceId: 'default' })).map(hit => hit.slug)).toEqual([renamed]);
        } else {
          expect(result.result.status).toBe('complete');
          expect(result.detail).toMatchObject({ touched: 1, skipped: 1, failed: 0 });
          expect(await engine.executeRaw('SELECT id FROM pages WHERE id = $1', [original!.id])).toEqual([]);
          expect((await engine.getPage(sibling, { sourceId: 'default' }))?.frontmatter.validate).toBe(false);
          expect(await engine.searchKeyword('cedarmarten', { sourceId: 'default' })).toHaveLength(0);
        }
        expect((await engine.searchKeyword('violetfox', { sourceId: 'default' })).map(hit => hit.slug)).toEqual([sibling]);
      } finally {
        await pg.close();
        rmSync(home, { recursive: true, force: true });
      }
    }, 60_000);
  }

  test('rolls metadata, knowledge revisions and text projections back when resealing fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-grandfather-rollback-pg-'));
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const engine = pg.engine;
    try {
      const slug = 'concepts/rollback-example';
      await sealedPage(engine, slug, 'amberbadger rollback fixture', { keep: 'original' });
      await sealedPage(engine, 'concepts/sibling-example', 'violetfox rollback fixture');
      const before = await persistedPages(engine);
      const jobsBefore = await engine.executeRaw('SELECT * FROM page_projection_jobs ORDER BY source_incarnation, slug');
      const chunksBefore = await engine.executeRaw('SELECT * FROM content_chunks ORDER BY id');
      let intermediate: Awaited<ReturnType<typeof persistedPages>> = [];
      const failing = afterTransactionQuery(engine, async (tx, query) => {
        if (!query.startsWith('UPDATE pages SET frontmatter = jsonb_set')) return;
        intermediate = await persistedPages(tx);
        throw new Error('injected failure before text reseal');
      });
      const result = await withEnv({ GBRAIN_HOME: home }, () => phaseCGrandfather(failing, {
        yes: true, dryRun: false, noAutopilotInstall: true,
      }));
      expect(result.result.status).toBe('failed');
      expect(result.detail).toMatchObject({ touched: 0, failed: 2 });
      expect(result.detail.failures.join(' ')).toContain('injected failure before text reseal');
      expect(intermediate).toHaveLength(2);
      for (let i = 0; i < intermediate.length; i++) {
        expect(intermediate[i].frontmatter).toEqual({ ...before[i].frontmatter as object, validate: false });
        expect(intermediate[i].knowledge_revision).not.toBe(before[i].knowledge_revision);
        expect(intermediate[i].text_projection_revision).not.toBe(intermediate[i].knowledge_revision);
      }
      expect(await persistedPages(engine)).toEqual(before);
      expect(await engine.executeRaw('SELECT * FROM page_projection_jobs ORDER BY source_incarnation, slug')).toEqual(jobsBefore);
      expect(await engine.executeRaw('SELECT * FROM content_chunks ORDER BY id')).toEqual(chunksBefore);
      expect((await engine.searchKeyword('amberbadger', { sourceId: 'default' })).map(hit => hit.slug)).toEqual([slug]);
      expect((await engine.searchKeyword('violetfox', { sourceId: 'default' })).map(hit => hit.slug)).toEqual(['concepts/sibling-example']);
      const retry = await withEnv({ GBRAIN_HOME: home }, () => phaseCGrandfather(engine, {
        yes: true, dryRun: false, noAutopilotInstall: true,
      }));
      expect(retry.detail).toMatchObject({ touched: 2, failed: 0 });
      const page = await engine.getPage(slug, { sourceId: 'default' });
      expect(page?.frontmatter).toEqual({ keep: 'original', validate: false });
      expect(page?.knowledge_revision).not.toBe(before[0].knowledge_revision);
      expect(page?.text_projection_revision).toBe(page?.knowledge_revision);
      expect((await engine.searchKeyword('amberbadger', { sourceId: 'default' })).map(hit => hit.slug)).toEqual([slug]);
    } finally {
      await pg.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
