/**
 * Wave B crash windows of a segmented write (spec 3.4, lane 1d).
 *
 * 1. Protects: a write that dies after any staging step, inside the flip, or
 *    after a create's projection staged its chunks leaves the page exactly at
 *    its previous generation: the body reconstructed from the live manifest,
 *    `content_hash` and keyword search all show the old content; the dead
 *    staging's rows are swept; an unsealed create converges through the
 *    projection queue without duplicating chunks.
 * 2. Fails when: a staged manifest or chunk row leaks into the live view, the
 *    flip commits partially, the projection queue misses an unsealed page, or
 *    a rebuild chunks an occurrence twice.
 * Serial: installs the process-wide fault hook.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { installFaultHook, type FaultPoint } from '../../src/core/persistence/fault-points.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { rebuildPendingSegmentedProjections } from '../../src/core/page-body/projection.ts';
import { BODY_STAGING_HARD_MS, SEGMENTED_CREATE_SEAL_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { conversationBody, conversationPage } from '../helpers/conversation-page.ts';

let engine: PGLiteEngine;
const NEEDLE = 'zqxflipneedle';
const original = conversationPage(2 * 1024 * 1024, { seed: 21 });
const rewritten = `${original.trimEnd()}\n\n${conversationBody(32 * 1024, { seed: 22, needles: [{ at: 0.5, word: NEEDLE }] })}\n`;

class Crash extends Error {}
function crashAt(point: FaultPoint): void {
  installFaultHook(async reached => { if (reached === point) throw new Crash(point); });
}

async function livePage(slug: string) {
  const [row] = await engine.executeRaw<{ id: number; body_generation: number; content_hash: string; knowledge_revision: string; text_projection_revision: string | null }>(
    `SELECT id, body_generation, content_hash, knowledge_revision::text AS knowledge_revision, text_projection_revision::text AS text_projection_revision
       FROM pages WHERE slug=$1`, [slug]);
  return row ? { ...row, id: Number(row.id), body_generation: Number(row.body_generation) } : null;
}

async function stagedRows(pageId: number) {
  const manifest = await engine.executeRaw('SELECT 1 FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NOT NULL', [pageId]);
  const chunks = await engine.executeRaw('SELECT 1 FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE c.page_id=$1 AND c.body_generation>p.body_generation', [pageId]);
  return manifest.length + chunks.length;
}

async function searchHits(word: string, slug: string): Promise<number> {
  return (await engine.searchKeyword(word, { limit: 20 })).filter(hit => hit.slug === slug).length;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
  await engine.setConfig('pages.segmented_storage', 'on');
});

afterEach(() => { installFaultHook(undefined); });

describe('replace: a crash at any step leaves the previous generation', () => {
  for (const point of ['segmented:texts_staged', 'segmented:manifest_staged', 'segmented:chunks_staged', 'segmented:flipped'] as const) {
    test(point, async () => {
      await importFromContent(engine, 'notes/flip', original, { sourceId: 'default', noEmbed: true });
      const before = (await livePage('notes/flip'))!;
      const bodyBefore = await materializeSegmentedBody(engine, before.id, 'default');

      crashAt(point);
      await expect(importFromContent(engine, 'notes/flip', rewritten, { sourceId: 'default', noEmbed: true })).rejects.toBeInstanceOf(Crash);
      installFaultHook(undefined);

      const after = (await livePage('notes/flip'))!;
      expect(after.body_generation).toBe(before.body_generation);
      expect(after.content_hash).toBe(before.content_hash);
      expect(after.knowledge_revision).toBe(before.knowledge_revision);
      expect(await materializeSegmentedBody(engine, after.id, 'default')).toEqual(bodyBefore);
      expect(await searchHits(NEEDLE, 'notes/flip')).toBe(0);

      await engine.sweepSegments({ pageId: after.id, expireStagings: true, now: new Date(Date.now() + BODY_STAGING_HARD_MS + 60_000) });
      expect(await stagedRows(after.id)).toBe(0);

      const retried = await importFromContent(engine, 'notes/flip', rewritten, { sourceId: 'default', noEmbed: true });
      expect(retried.status).toBe('imported');
      expect((await livePage('notes/flip'))!.body_generation).toBe(before.body_generation + 1);
      expect(await searchHits(NEEDLE, 'notes/flip')).toBe(1);
    }, 180_000);
  }
});

describe('create: a crash after the projection staged its chunks', () => {
  test('the page publishes unsealed, the projection queue seals it, and a second rebuild adds nothing', async () => {
    const created = conversationPage(SEGMENTED_CREATE_SEAL_MAX_BYTES + 256 * 1024, { seed: 31, needles: [{ at: 0.9, word: NEEDLE }] });
    crashAt('segmented:projection_staged');
    const result = await importFromContent(engine, 'notes/fresh', created, { sourceId: 'default', noEmbed: true });
    installFaultHook(undefined);
    expect(result.status).toBe('imported');

    const unsealed = (await livePage('notes/fresh'))!;
    expect(unsealed.body_generation).toBe(1);
    expect(unsealed.text_projection_revision).not.toBe(unsealed.knowledge_revision);
    const queued = await engine.executeRaw('SELECT 1 FROM page_projection_jobs WHERE slug=$1', ['notes/fresh']);
    expect(queued.length).toBe(1);

    expect((await rebuildPendingSegmentedProjections(engine, 10)).rebuilt).toBe(1);
    const sealed = (await livePage('notes/fresh'))!;
    expect(sealed.text_projection_revision).toBe(sealed.knowledge_revision);
    expect(await engine.executeRaw('SELECT 1 FROM page_projection_jobs WHERE slug=$1', ['notes/fresh'])).toEqual([]);
    expect(await searchHits(NEEDLE, 'notes/fresh')).toBe(1);

    const perOccurrence = async () => engine.executeRaw<{ occurrence_id: number; n: number }>(
      `SELECT occurrence_id, count(*)::int AS n FROM content_chunks WHERE page_id=$1 GROUP BY occurrence_id ORDER BY occurrence_id`, [sealed.id]);
    const once = await perOccurrence();
    await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation, slug, revision, reason)
      SELECT s.incarnation, $1, p.knowledge_revision, 'canonical_change' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug=$1`, ['notes/fresh']);
    await rebuildPendingSegmentedProjections(engine, 10);
    expect(await perOccurrence()).toEqual(once);
  }, 180_000);
});

describe('replace of a page whose projection never ran', () => {
  test('the rewrite chunks every kept occurrence with the flip and seals the page', async () => {
    const created = conversationPage(SEGMENTED_CREATE_SEAL_MAX_BYTES + 256 * 1024, { seed: 41, needles: [{ at: 0.2, word: NEEDLE }] });
    crashAt('segmented:projection_staged');
    await importFromContent(engine, 'notes/unchunked', created, { sourceId: 'default', noEmbed: true });
    installFaultHook(undefined);
    const unsealed = (await livePage('notes/unchunked'))!;
    expect(unsealed.text_projection_revision).not.toBe(unsealed.knowledge_revision);

    const appended = `${created.trimEnd()}\n\n${conversationBody(16 * 1024, { seed: 42 })}\n`;
    expect((await importFromContent(engine, 'notes/unchunked', appended, { sourceId: 'default', noEmbed: true })).status).toBe('imported');
    const sealed = (await livePage('notes/unchunked'))!;
    expect(sealed.body_generation).toBe(2);
    expect(sealed.text_projection_revision).toBe(sealed.knowledge_revision);
    const bare = await engine.executeRaw(`SELECT m.occurrence_id FROM page_body_manifest m WHERE m.page_id=$1 AND m.staging_id IS NULL
        AND m.gen_from <= $2 AND (m.gen_to IS NULL OR m.gen_to > $2)
        AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=m.page_id AND c.occurrence_id=m.occurrence_id
          AND c.body_generation <= $2)`, [sealed.id, sealed.body_generation]);
    expect(bare).toEqual([]);
    expect(await searchHits(NEEDLE, 'notes/unchunked')).toBe(1);
  }, 180_000);
});
