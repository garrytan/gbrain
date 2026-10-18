/**
 * A segmented write after a write whose chunk retirement was deferred (Wave B PR 2, fix lane K, review finding I1).
 *
 * 1. Protects: W1 replaces a segmented page with more stale chunk rows than pages.flip_retire_max_rows (retirement
 *    deferred) and its projection never runs; W2 then edits another part of the page. W2's flip retires only the
 *    occurrences W2 closes, so W2 leaves the page unsealed while W1's rows are still stored, W1's removed text is never
 *    a keyword hit, and the projection build retires those rows and seals. A page an older binary sealed over such rows
 *    is built again (not short-circuited as sealed), so the build retires them.
 * 2. Fails when: applySegmentedBody marks the write complete from its own flip alone (W2 seals over W1's rows and
 *    chunkVisibleFilter shows them), or buildSegmentedProjection returns "sealed" for a sealed page that still stores
 *    retired occurrences' rows (they are never retired).
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. The lost projections are forced: each write runs on an
 *    engine whose projection page read throws (as a process death after commit, or a claim another process holds).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { buildSegmentedProjection } from '../../src/core/page-body/projection.ts';
import { sealSegmentedPage } from '../../src/core/persistence/segmented-apply.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-second-write-deferred-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const PROJECTION_PAGE_READ = "FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL AND body_storage='segmented'";

/** The engine with the segmented projection's page read failing: the post-commit projection is lost. */
function projectionLost(engine: BrainEngine): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') {
        return (sql: string, params?: unknown[]) => sql.includes(PROJECTION_PAGE_READ)
          ? Promise.reject(new Error('projection lost (probe)')) : target.executeRaw(sql, params);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const v0 = conversationPage(3 * 1024 * 1024, { seed: 41, needles: [{ at: 0.2, word: 'oldmarkerquokka' }, { at: 0.8, word: 'farmarkerwalrus' }] });
const v1 = v0.replace('oldmarkerquokka', 'newmarkernarwhal');
const v2 = v1.replace('farmarkerwalrus', 'farmarkerpangolin');
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

for (const kind of testBackends()) describe(`a segmented write after a deferred retirement (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => withEnv(env, async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    await registerLocalWriter(engine, 'cli');
    await engine.setConfig('pages.segmented_storage', 'on');
  }), 120_000);
  afterAll(async () => withEnv(env, async () => { await disposePersistenceConsumer(engine); await close?.(); }));

  const found = async (slug: string, word: string) => (await engine.searchKeyword(word, { limit: 10 })).filter(r => r.slug === slug).length;
  const staleRows = async (pageId: number) => Number((await engine.executeRaw<{ n: number }>(
    "SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1 AND strpos(chunk_text, 'oldmarkerquokka') > 0", [pageId]))[0]!.n);

  /** v0 imported and projected, then W1 (v1) with its retirement deferred and its projection lost. */
  async function deferredPage(): Promise<{ slug: string; file: string }> {
    const dir = join(home, `page-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'huge.md');
    const slug = `notes/huge-${randomUUID().slice(0, 8)}`;
    const write = async (body: string, on: BrainEngine) => {
      writeFileSync(file, body);
      expect(await importFromFile(on, file, `${slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).toMatchObject({ status: 'imported' });
    };
    await write(v0, engine);
    expect(await found(slug, 'oldmarkerquokka')).toBeGreaterThan(0);
    await engine.setConfig('pages.flip_retire_max_rows', '1');
    await write(v1, projectionLost(engine));
    await engine.setConfig('pages.flip_retire_max_rows', '20000');
    const page = await segmentedPageRow(engine, slug);
    expect(page.text_projection_revision).not.toBe(page.knowledge_revision);
    expect(await staleRows(page.id)).toBeGreaterThan(0);
    expect(await found(slug, 'oldmarkerquokka')).toBe(0);
    return { slug, file };
  }

  test("W2 leaves the page unsealed over W1's stored rows; the build retires them and seals", async () => withEnv(env, async () => {
    const { slug, file } = await deferredPage();
    writeFileSync(file, v2);
    expect(await importFromFile(projectionLost(engine), file, `${slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) }))
      .toMatchObject({ status: 'imported' });
    const afterW2 = await segmentedPageRow(engine, slug);
    expect(await staleRows(afterW2.id)).toBeGreaterThan(0);
    expect(await found(slug, 'oldmarkerquokka')).toBe(0);
    expect(afterW2.text_projection_revision).not.toBe(afterW2.knowledge_revision);

    const built = await buildSegmentedProjection(engine, { sourceId: 'default', slug });
    expect(built.sealed).toBe(true);
    expect(built.retired).toBeGreaterThan(0);
    const sealed = await segmentedPageRow(engine, slug);
    expect(sealed.text_projection_revision).toBe(sealed.knowledge_revision);
    expect(await staleRows(sealed.id)).toBe(0);
    expect(await found(slug, 'oldmarkerquokka')).toBe(0);
    expect(await found(slug, 'farmarkerwalrus')).toBe(0);
    expect(await found(slug, 'newmarkernarwhal')).toBeGreaterThan(0);
    expect(await found(slug, 'farmarkerpangolin')).toBeGreaterThan(0);
  }), 1_200_000);

  test("a page sealed over retired occurrences' rows is built again, not reported sealed", async () => withEnv(env, async () => {
    const { slug } = await deferredPage();
    const page = await segmentedPageRow(engine, slug);
    // The state an earlier binary left: sealed while W1's rows are still stored.
    await engine.transaction(tx => sealSegmentedPage(tx, page.id));
    expect(await found(slug, 'oldmarkerquokka')).toBeGreaterThan(0);

    const built = await buildSegmentedProjection(engine, { sourceId: 'default', slug });
    expect(built.sealed).toBe(true);
    expect(built.retired).toBeGreaterThan(0);
    expect(await staleRows(page.id)).toBe(0);
    expect(await found(slug, 'oldmarkerquokka')).toBe(0);
    expect(await found(slug, 'newmarkernarwhal')).toBeGreaterThan(0);
  }), 1_200_000);
});
