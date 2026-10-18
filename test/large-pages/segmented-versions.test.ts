/**
 * Wave B versions as manifests (spec 5).
 *
 * 1. Protects: a segmented page's version is an O(1) reference row (its body
 *    generation, body_bytes and content_hash, NULL bodies; no segment or
 *    chunk read); segmented retention keeps the newest
 *    `versions.segmented_max_per_page` and prunes oldest-first while bytes
 *    pinned beyond the live generation exceed
 *    max(`versions.segmented_max_pinned_bytes`, body_bytes); inline history is
 *    never pruned by it; a retained version keeps its generation's manifest
 *    rows alive through `sweepSegments`; get_versions returns size and a
 *    body_ref, never a body; revert_version refuses a segmented version with
 *    `page_body_segmented` (PR 3 adds it).
 * 2. Fails when: a segmented version copies or reads the body, retention
 *    prunes inline snapshots or keeps unbounded pinned history, or a revert
 *    rebuilds a page from a NULL body.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PAGE_BODY_CONFIG_KEYS } from '../../src/core/page-body/limits.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentPage } from '../helpers/segmented-chunks-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';

const SLUG = 'notes/segmented-history';
const KB = 1024;

for (const kind of testBackends()) {
  describe(`segmented versions (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let pageId: number;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    /**
     * Generation 1: occurrences 1 (live through every generation) and 2.
     * Generation 2 closes 2 and adds 3; generation 3 closes 3 and adds 4.
     * A version at generation 1 pins occurrence 2; at generation 2, occurrence 3.
     */
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw('DELETE FROM page_segment_texts');
      await engine.executeRaw(`DELETE FROM config WHERE key IN ($1, $2)`, [PAGE_BODY_CONFIG_KEYS.versionsMaxPerPage, PAGE_BODY_CONFIG_KEYS.versionsMaxPinnedBytes]);
      ({ pageId } = await segmentPage(engine, SLUG, {
        generation: 1,
        bodyBytes: 2 * KB,
        occurrences: [
          { id: 1, byteStart: 0, genFrom: 1, byteLen: KB, chunks: [{ text: 'opening passage' }] },
          { id: 2, byteStart: KB, genFrom: 1, genTo: 2, byteLen: 8 * KB, chunks: [{ text: 'first tail' }] },
          { id: 3, byteStart: KB, genFrom: 2, genTo: 3, byteLen: 8 * KB, chunks: [{ text: 'second tail' }] },
          { id: 4, byteStart: KB, genFrom: 3, byteLen: KB, chunks: [{ text: 'third tail' }] },
        ],
      }));
    });

    const atGeneration = (generation: number) => engine.executeRaw('UPDATE pages SET body_generation = $2 WHERE id = $1', [pageId, generation]);
    const segmentedVersions = async () => (await engine.executeRaw<{ body_generation: number }>(
      `SELECT body_generation FROM page_versions WHERE page_id = $1 AND body_storage = 'segmented' ORDER BY id`, [pageId])).map(r => Number(r.body_generation));

    test('a segmented version is an O(1) reference row that never reads segments or chunks', async () => {
      const exec = spyOn(engine, 'executeRaw');
      try {
        await engine.createVersion(SLUG);
        for (const [sql] of exec.mock.calls) expect(String(sql)).not.toMatch(/page_segment_texts|content_chunks/);
      } finally { exec.mockRestore(); }
      const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM page_versions WHERE page_id = $1', [pageId]);
      expect(row).toMatchObject({ body_storage: 'segmented', compiled_truth: null, timeline: null, title: SLUG });
      expect(Number(row!.body_generation)).toBe(1);
      expect(Number(row!.body_bytes)).toBe(2 * KB);
      expect(row!.content_hash).toEqual(expect.any(String));
    });

    test('retention keeps the newest versions_max_per_page', async () => {
      await engine.setConfig(PAGE_BODY_CONFIG_KEYS.versionsMaxPerPage, '2');
      for (const generation of [1, 2, 3]) { await atGeneration(generation); await engine.createVersion(SLUG); }
      expect(await segmentedVersions()).toEqual([2, 3]);
    });

    test('retention prunes oldest-first while pinned bytes exceed max(cap, body_bytes)', async () => {
      await engine.setConfig(PAGE_BODY_CONFIG_KEYS.versionsMaxPinnedBytes, String(10 * KB));
      await atGeneration(1); await engine.createVersion(SLUG);
      await atGeneration(2); await engine.createVersion(SLUG);
      // 8 KiB (generation 1) + 8 KiB (generation 2) pinned > 10 KiB: the oldest goes.
      expect(await segmentedVersions()).toEqual([2]);
      // The live generation pins nothing beyond itself.
      await atGeneration(3); await engine.createVersion(SLUG);
      expect(await segmentedVersions()).toEqual([2, 3]);
    });

    test('the byte cap is at least the page body_bytes', async () => {
      await engine.setConfig(PAGE_BODY_CONFIG_KEYS.versionsMaxPinnedBytes, String(KB));
      await engine.executeRaw('UPDATE pages SET body_bytes = $2 WHERE id = $1', [pageId, 64 * KB]);
      await atGeneration(1); await engine.createVersion(SLUG);
      await atGeneration(2); await engine.createVersion(SLUG);
      expect(await segmentedVersions()).toEqual([1, 2]);
    });

    test('inline history is never pruned by segmented retention', async () => {
      await engine.setConfig(PAGE_BODY_CONFIG_KEYS.versionsMaxPerPage, '1');
      const inline = await engine.putPage('notes/inline-history', { type: 'note', title: 'Inline', compiled_truth: 'v0', timeline: '', frontmatter: {} });
      for (let i = 1; i <= 4; i++) {
        await engine.createVersion('notes/inline-history');
        await engine.putPage('notes/inline-history', { type: 'note', title: 'Inline', compiled_truth: `v${i}`, timeline: '', frontmatter: {} });
      }
      const rows = await engine.executeRaw('SELECT id FROM page_versions WHERE page_id = $1', [inline.id]);
      expect(rows).toHaveLength(4);
    });

    test('a retained version keeps its generation manifest rows alive through sweepSegments', async () => {
      await engine.setConfig(PAGE_BODY_CONFIG_KEYS.versionsMaxPerPage, '1');
      await atGeneration(1); await engine.createVersion(SLUG);
      await atGeneration(3); await engine.createVersion(SLUG);
      await engine.sweepSegments({ pageId, graceMs: 0 });
      const occurrences = (await engine.executeRaw<{ occurrence_id: number }>(
        'SELECT occurrence_id FROM page_body_manifest WHERE page_id = $1 ORDER BY occurrence_id', [pageId])).map(r => Number(r.occurrence_id));
      // Generation 3 (the only version, and live) needs 1 and 4; 2 and 3 are dead.
      expect(occurrences).toEqual([1, 4]);
    });

    test('get_versions returns size and a body_ref for segmented versions, never a body', async () => {
      await engine.createVersion(SLUG);
      const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const [meta] = await operationsByName.get_versions!.handler(ctx, { slug: SLUG }) as Array<Record<string, unknown>>;
      expect(meta).toMatchObject({ body_storage: 'segmented', body_bytes: 2 * KB });
      expect(meta).not.toHaveProperty('compiled_truth');
      const [full] = await operationsByName.get_versions!.handler(ctx, { slug: SLUG, include_body: true }) as Array<Record<string, unknown>>;
      expect(full).not.toHaveProperty('compiled_truth');
      expect(full).not.toHaveProperty('timeline');
      expect(full!.body_ref).toEqual({ version_id: full!.id, total_bytes: 2 * KB,
        read: { tool: 'get_page', arguments: { slug: SLUG, version_id: full!.id, body: 'window' } } });
    });

    test('revertToVersion refuses a segmented version with page_body_segmented and writes nothing', async () => {
      const version = await engine.createVersion(SLUG);
      const before = await engine.executeRaw('SELECT body_generation, knowledge_revision FROM pages WHERE id = $1', [pageId]);
      await expect(engine.revertToVersion(SLUG, version.id)).rejects.toMatchObject({ code: 'page_body_segmented' });
      expect(await engine.executeRaw('SELECT body_generation, knowledge_revision FROM pages WHERE id = $1', [pageId])).toEqual(before);
    });
  });
}
