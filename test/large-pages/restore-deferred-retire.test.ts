/**
 * restore_page of a segmented page over the single-string ceiling whose retirement was deferred (Wave B PR 2, lane A).
 *
 * 1. Protects: a page over PAGE_MAX_BYTES whose replace deferred its chunk retirement (more rows than
 *    pages.flip_retire_max_rows) and whose post-commit projection never ran, then was soft-deleted (as sync does
 *    when its file goes), is restored
 *    unsealed with its projection pending, and the restore's projection retires the old rows before it seals: the
 *    old body's text is never searchable after the restore.
 * 2. Fails when: the restore seals once every live occurrence has chunks, ignoring rows of retired occurrences that
 *    are still stored (chunkVisibleFilter shows every row at or below the live generation of a sealed page).
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. The lost projection is forced: the replace runs on an
 *    engine whose projection page read throws (the import catches it, as a process death after commit leaves it).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { operations } from '../../src/core/operations.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-restore-deferred-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };

const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind, embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: join(home, 'storage') } },
  logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;
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

const before = conversationPage(PAGE_MAX_BYTES + 1024 * 1024, { seed: 97, needles: [{ at: 0.5, word: 'oldmarkerxylophone' }] });
const after = before.replace('oldmarkerxylophone', 'newmarkerzeppelin');
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

for (const kind of testBackends()) describe(`restore_page of a page whose retirement was deferred (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => withEnv(env, async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    await registerLocalWriter(engine, 'cli');
    await engine.setConfig('pages.segmented_storage', 'on');
  }), 120_000);
  afterAll(async () => withEnv(env, async () => { await disposePersistenceConsumer(engine); await close?.(); }));

  test('the restore leaves the page unsealed until its projection retired the old rows', async () => withEnv(env, async () => {
    {
      const dir = join(home, `restore-${randomUUID().slice(0, 8)}`);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'huge.md');
      const slug = `notes/huge-${randomUUID().slice(0, 8)}`;
      writeFileSync(file, before);
      expect(await importFromFile(engine, file, `${slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).toMatchObject({ status: 'imported' });
      await engine.setConfig('pages.flip_retire_max_rows', '1');
      writeFileSync(file, after);
      expect(await importFromFile(projectionLost(engine), file, `${slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) }))
        .toMatchObject({ status: 'imported' });
      await engine.setConfig('pages.flip_retire_max_rows', '20000');
      const page = await segmentedPageRow(engine, slug);
      expect(page.text_projection_revision).not.toBe(page.knowledge_revision);
      const [stale] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1 AND strpos(chunk_text, 'oldmarkerxylophone') > 0`, [page.id]);
      expect(Number(stale!.n)).toBeGreaterThan(0);

      // Soft-deleted as sync leaves a page whose file was removed (no write of its own drains the projection queue).
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.softDeletePage(slug, { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));
      const restored = await op('restore_page').handler(ctx(engine), { slug, request_id: randomUUID(),
        expected_revision: (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))!.revision }) as Record<string, unknown>;
      expect(restored.status).toBe('restored');
      const found = async (word: string) => (await engine.searchKeyword(word, { limit: 10 })).filter(r => r.slug === slug).length;
      expect(await found('oldmarkerxylophone')).toBe(0);
      expect(restored.projection).toBe('pending');
      const row = await segmentedPageRow(engine, slug);
      expect(row.text_projection_revision).toBe(row.knowledge_revision);
      expect(await found('newmarkerzeppelin')).toBeGreaterThan(0);
    }
  }), 1_200_000);
});
