/**
 * restore_page of a page stored in segments ends chunked, sealed and searchable (Wave B PR 2, fix lane M, item 11).
 *
 * 1. Protects: after a soft delete and restore_page, a segmented page (one within the single-string ceiling, which the
 *    restore re-imports, and one over it, which the restore clears without re-importing) is sealed at its new revision,
 *    has a chunk row for every live occurrence and none of a retired one, has no queued projection, and keyword search
 *    finds text from its last segment. A page whose chunks were never built (its create's post-commit projection died
 *    and it was deleted before the resident built it) and whose restore's post-commit projection dies too is queued by
 *    the restore, and `gbrain projections drain` builds it exactly once, leaving no stale row.
 * 2. Fails when: a restore seals a page an occurrence of which has no chunks, or leaves an unsealed page with no queued
 *    projection (the soft delete removed its queue row and nothing queues it again).
 * 3. Existing coverage: restore-deferred-retire.test.ts restores a page whose deferred retirement left rows of retired
 *    occurrences, with its post-commit projection running.
 * 4. Runs on PGLite, and on Postgres when DATABASE_URL is set. The lost projections are forced with the
 *    `segmented:projection_staged` fault seam (each build stages its chunks, then throws before sealing); the create's
 *    rows are then removed, as a process killed before its chunk batches committed leaves the page.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { operations } from '../../src/core/operations.ts';
import { occurrencesWithoutChunks } from '../../src/core/page-body/ingest.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { hasStaleChunks } from '../../src/core/page-body/projection.ts';
import { drainProjections } from '../../src/core/page-state/projections.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-restore-reprojects-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const MiB = 1024 * 1024;
const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind, embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: join(home, 'storage') } },
  logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const restoreOp = operations.find(o => o.name === 'restore_page')!;
const page = (bytes: number, needle: string, seed: number) =>
  `---\ntitle: Group chat\ntype: note\n---\n\n${conversationBody(bytes, { seed, needles: [{ at: 0.995, word: needle }] })}\n`;

afterAll(() => { rmSync(home, { recursive: true, force: true }); });
afterEach(() => installFaultHook(undefined));

for (const kind of testBackends()) describe(`restore_page re-projects a segmented page (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => withEnv(env, async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    await registerLocalWriter(engine, 'cli');
    await engine.setConfig('pages.segmented_storage', 'on');
  }), 120_000);
  afterAll(async () => withEnv(env, async () => { await disposePersistenceConsumer(engine); await close?.(); }));

  const found = async (needle: string, slug: string) => (await engine.searchKeyword(needle, { limit: 10 })).some(hit => hit.slug === slug);
  const queued = async (slug: string) => (await engine.executeRaw<{ reason: string }>(`SELECT reason FROM page_projection_jobs
    WHERE slug=$1 AND source_incarnation=(SELECT incarnation FROM sources WHERE id='default')`, [slug])).map(row => row.reason);
  const softDelete = (slug: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.softDeletePage(slug, { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));
  /** A restore over the single-string ceiling can outlast the reply wait: the same call (same request_id) is repeated until it settles. */
  async function restore(slug: string): Promise<Record<string, unknown>> {
    const params = { slug, request_id: randomUUID(), expected_revision: (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))!.revision };
    for (let attempt = 0; ; attempt++) {
      try { return await restoreOp.handler(ctx(engine), params) as Record<string, unknown>; }
      catch (error) { if ((error as { code?: string }).code !== 'write_pending' || attempt >= 300) throw error; await Bun.sleep(1000); }
    }
  }

  /** Sealed at the live revision, every live occurrence chunked, no row of another occurrence, nothing queued. */
  async function expectProjected(slug: string, needle: string): Promise<void> {
    const row = await segmentedPageRow(engine, slug);
    expect(row.body_storage).toBe('segmented');
    expect(row.text_projection_revision).toBe(row.knowledge_revision);
    const live = await engine.readManifest(row.id);
    expect(live.length).toBeGreaterThan(1);
    expect(await occurrencesWithoutChunks(engine, row.id, row.body_generation, live)).toEqual([]);
    expect(await hasStaleChunks(engine, row.id, row.body_generation, live.map(occurrence => Number(occurrence.occurrenceId)))).toBe(false);
    expect(await queued(slug)).toEqual([]);
    expect(await found(needle, slug)).toBe(true);
  }

  /** Imported from a file, as sync imports it (a page over the single-string ceiling is streamed). */
  async function imported(slug: string, bytes: number, needle: string, seed: number) {
    const dir = join(home, randomUUID().slice(0, 8));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'page.md'), page(bytes, needle, seed));
    return importFromFile(engine, join(dir, 'page.md'), `${slug}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) });
  }

  /** A create whose post-commit projection died before any chunk row committed, then soft-deleted (its queue row goes). */
  async function unbuiltDeletedPage(slug: string, bytes: number, needle: string, seed: number): Promise<void> {
    installFaultHook(point => { if (point === 'segmented:projection_staged') throw new Error('post-commit build died (probe)'); });
    expect(await imported(slug, bytes, needle, seed)).toMatchObject({ status: 'imported', searchable: 'pending' });
    installFaultHook(undefined);
    await engine.executeRaw("DELETE FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE source_id='default' AND slug=$1)", [slug]);
    await softDelete(slug);
    expect(await queued(slug)).toEqual([]);
  }

  for (const [label, bytes] of [['within the single-string ceiling', 6 * MiB], ['over the single-string ceiling', PAGE_MAX_BYTES + MiB]] as const) {
    test(`a sealed page ${label} is sealed, chunked and searchable after its restore`, async () => withEnv(env, async () => {
      const slug = `notes/sealed-${bytes}-${randomUUID().slice(0, 8)}`;
      const needle = `zzrestoredsealed${kind}${bytes}`;
      expect(await imported(slug, bytes, needle, 31)).toMatchObject({ status: 'imported' });
      await drainProjections(engine);
      await expectProjected(slug, needle);
      await softDelete(slug);
      expect(await found(needle, slug)).toBe(false);
      expect((await restore(slug)).status).toBe('restored');
      await expectProjected(slug, needle);
    }), 600_000);

    test(`a page ${label} whose chunks were never built is projected by its restore, or queued by it and built by one drain`, async () => withEnv(env, async () => {
      const slug = `notes/unbuilt-${bytes}-${randomUUID().slice(0, 8)}`;
      const needle = `zzrestoredunbuilt${kind}${bytes}`;
      await unbuiltDeletedPage(slug, bytes, needle, 47);
      let lost = 0;
      installFaultHook(point => { if (point === 'segmented:projection_staged') { lost++; throw new Error('post-commit build died (probe)'); } });
      const restored = await restore(slug);
      expect(restored.status).toBe('restored');
      // The restore's post-commit build (if it runs one) dies before its seal; wait for it to have died.
      for (let polls = 0; restored.projection === 'pending' && lost === 0 && polls < 600; polls++) await Bun.sleep(100);
      // The resident's queue route may have tried it under the probe too (`rebuild_failed`); stop it so the drain is the only build.
      await disposePersistenceConsumer(engine);
      installFaultHook(undefined);
      if (bytes <= PAGE_MAX_BYTES) {
        // The restore re-imports the body: its preparation chunks every occurrence and its publication seals.
        await expectProjected(slug, needle);
        return;
      }
      expect(restored.projection).toBe('pending');
      expect(await found(needle, slug)).toBe(false);
      const row = await segmentedPageRow(engine, slug);
      expect(row.text_projection_revision).not.toBe(row.knowledge_revision);
      expect((await queued(slug)).length).toBe(1);
      let builds = 0;
      installFaultHook(point => { if (point === 'segmented:projection_staged') builds++; });
      const drained = await drainProjections(engine);
      expect(drained.failed).toEqual([]);
      expect(builds).toBe(1);
      await expectProjected(slug, needle);
    }), 600_000);
  }
});
