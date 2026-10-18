/**
 * Page purge and TTL hard delete of segmented pages (Wave B, spec 11).
 *
 * 1. Protects: `delete_page purge:true` on a segmented page over the
 *    single-string ceiling (stream-imported, with a retained version) removes
 *    the page, its manifest rows, the segment texts only it referenced and its
 *    stagings in the same transaction, and tombstones its stored content hash
 *    without holding the body as one string; the same file then refuses to
 *    import (purged_content). The TTL hard delete (`purgeDeletedPages`) of a
 *    soft-deleted segmented page sweeps its texts and stagings the same way,
 *    and keeps texts another page still references.
 * 2. Fails when: the purge refuses a segmented page (page_body_segmented),
 *    leaves its texts or stagings for a later GC, or tombstones no hash.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent, importFromFile } from '../../src/core/import-file.ts';
import { operations } from '../../src/core/operations.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-page-purge-segments-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind, embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: join(home, 'storage') } },
  logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;
const coordinated = <T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => fn(tx), TEST_WRITE_ATTRIBUTION));
async function errorText(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok'; } catch (e) { return `${(e as { code?: string }).code ?? ''}: ${(e as Error).message}`; }
}
async function shasOf(engine: BrainEngine, pageId: number): Promise<string[]> {
  return (await engine.executeRaw<{ sha: string }>(`SELECT DISTINCT encode(sha256,'hex') AS sha FROM page_body_manifest WHERE page_id=$1`, [pageId])).map(r => r.sha);
}
async function textsLeft(engine: BrainEngine, shas: readonly string[]): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_segment_texts WHERE source_id='default'
    AND sha256=ANY(SELECT decode(h,'hex') FROM unnest($1::text[]) AS h)`, [shas]);
  return Number(row!.n);
}
async function openStaging(engine: BrainEngine, slug: string, pageId: number) {
  const [source] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation FROM sources WHERE id='default'`);
  await coordinated(engine, tx => tx.openBodyStaging({ id: randomUUID(), kind: 'upload', principalKind: 'application', principalId: 'test:fixture',
    clientRequestId: randomUUID(), sourceId: 'default', sourceIncarnation: source!.incarnation, slug, pageId, mode: 'replace', baseRevision: null,
    baseGeneration: null, declaredBytes: 16, declaredSha256: null, reservedBytes: 0,
    idleExpiresAt: new Date(Date.now() + 3_600_000), hardExpiresAt: new Date(Date.now() + 7_200_000) }));
}
const stagingsOf = async (engine: BrainEngine, slug: string) =>
  (await engine.executeRaw(`SELECT 1 FROM page_body_stagings WHERE source_id='default' AND slug=$1`, [slug])).length;

beforeAll(async () => withEnv(env, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  for (const engine of engines) { await registerLocalWriter(engine, 'cli'); await engine.setConfig('pages.segmented_storage', 'on'); }
}), 120_000);
afterAll(async () => withEnv(env, async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
}));

describe('page purge of segmented pages', () => {
  test('delete_page purge:true of a page over the ceiling sweeps texts and stagings and tombstones the content', async () => withEnv(env, async () => {
    const content = conversationPage(PAGE_MAX_BYTES + 1024 * 1024, { seed: 83, needles: [{ at: 0.6, word: 'AKIAEXAMPLENOTREAL' }] });
    for (const engine of engines) {
      const dir = join(home, `purge-${randomUUID().slice(0, 8)}`);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'huge.md');
      writeFileSync(file, content);
      const slug = `notes/huge-${randomUUID().slice(0, 8)}`;
      expect(await importFromFile(engine, file, `${slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).toMatchObject({ status: 'imported' });
      const page = await segmentedPageRow(engine, slug);
      expect(page.body_storage).toBe('segmented');
      const [bytes] = await engine.executeRaw<{ n: string }>('SELECT body_bytes::text AS n FROM pages WHERE id=$1', [page.id]);
      expect(Number(bytes!.n)).toBeGreaterThan(PAGE_MAX_BYTES);
      await coordinated(engine, tx => tx.createVersion(slug, { sourceId: 'default' }));
      await openStaging(engine, slug, page.id);
      const shas = await shasOf(engine, page.id);
      expect(await textsLeft(engine, shas)).toBe(shas.length);
      expect(await stagingsOf(engine, slug)).toBeGreaterThan(0);

      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
      const result = await op('delete_page').handler(ctx(engine), { slug, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision }) as Record<string, any>;
      expect(result.status).toBe('purged');
      expect(result.purge.removed.page_body_manifest).toBeGreaterThan(0);
      expect(result.purge.removed.page_segment_texts).toBe(shas.length);
      expect(result.purge.removed.page_body_stagings).toBeGreaterThan(0);
      expect(result.purge.removed.page_versions).toBe(1);
      expect(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2', ['default', slug])).toHaveLength(0);
      expect(await engine.executeRaw('SELECT 1 FROM page_body_manifest WHERE page_id=$1', [page.id])).toHaveLength(0);
      expect(await textsLeft(engine, shas)).toBe(0);
      expect(await stagingsOf(engine, slug)).toBe(0);
      const segmentStore = (result.receipt.stores as Array<{ store: string; status: string }>).find(s => s.store === 'page_segment_texts');
      expect(segmentStore?.status).toBe('deleted');
      expect(await engine.executeRaw(`SELECT 1 FROM page_purges WHERE source_id='default' AND content_hash=$1`, [page.content_hash])).toHaveLength(1);
      expect(await errorText(importFromFile(engine, file, `${slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) }))).toContain('purged_content');
    }
  }), 900_000);

  test('the TTL hard delete sweeps a soft-deleted segmented page\'s texts and stagings, keeping shared texts', async () => withEnv(env, async () => {
    const shared = conversationPage(1_400_000, { seed: 89 });
    for (const engine of engines) {
      const slug = `notes/expired-${randomUUID().slice(0, 8)}`, keeper = `notes/keeper-${randomUUID().slice(0, 8)}`;
      await importFromContent(engine, slug, `${shared}\n## Own tail\n\nOnly the expired page says this.\n`, { noEmbed: true, sourceId: 'default' });
      await importFromContent(engine, keeper, `${shared}\n## Own tail\n\nOnly the keeper says this.\n`, { noEmbed: true, sourceId: 'default' });
      const page = await segmentedPageRow(engine, slug), kept = await segmentedPageRow(engine, keeper);
      expect(page.body_storage).toBe('segmented');
      await openStaging(engine, slug, page.id);
      const shas = await shasOf(engine, page.id), keeperShas = new Set(await shasOf(engine, kept.id));
      const own = shas.filter(sha => !keeperShas.has(sha)), common = shas.filter(sha => keeperShas.has(sha));
      expect(own.length).toBeGreaterThan(0);
      expect(common.length).toBeGreaterThan(0);
      await coordinated(engine, tx => tx.softDeletePage(slug, { sourceId: 'default' }));
      await engine.executeRaw(`UPDATE pages SET deleted_at=now() - interval '48 hours' WHERE source_id='default' AND slug=$1`, [slug]);

      const purged = await engine.purgeDeletedPages(24);
      expect(purged.slugs).toEqual([slug]);
      expect(await engine.executeRaw('SELECT 1 FROM page_body_manifest WHERE page_id=$1', [page.id])).toHaveLength(0);
      expect(await textsLeft(engine, own)).toBe(0);
      expect(await textsLeft(engine, common)).toBe(common.length);
      expect(await stagingsOf(engine, slug)).toBe(0);
    }
  }), 600_000);
});
