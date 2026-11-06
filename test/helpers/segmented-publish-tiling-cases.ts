/**
 * GST-1209: a segmented publish commits only a generation whose rows tile its body. Shared by the PGLite arm
 * (test/large-pages/segmented-publish-tiling.serial.test.ts) and the Postgres arm (test/e2e/segmented-publish-tiling-postgres.test.ts).
 *
 * 1. Protects: a staging that a fact purge aborted, or a sweep expired, while its write was still preparing (the sweep then
 *    deletes the staging's staged rows) stays terminal: the preparation's move to `prepared` refuses (body_staging_expired)
 *    instead of reviving it, so the flip never closes the live rows and publishes none. Independently, the flip refuses a
 *    publication whose new generation does not tile its body (here: staged rows deleted under a live staging). Either way
 *    the page stays at its previous generation, whole and readable.
 * 2. Fails when: the write commits a generation whose rows cover less than its body_bytes (the damaged shape: live rows
 *    closed, new rows missing), or a refusal leaves the page at a different generation.
 * 3. Serial: installs the process-wide fault hook.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { BODY_STAGING_IDLE_MS } from '../../src/core/page-body/limits.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { readTiledManifest } from '../../src/core/page-body/body-tiling.ts';
import { conversationBody, conversationPage } from './conversation-page.ts';

const SLUG = 'notes/tiling-example';
const original = conversationPage(2 * 1024 * 1024, { seed: 31 });
const rewritten = `${original.trimEnd()}\n\n${conversationBody(32 * 1024, { seed: 32 })}\n`;

type Live = { id: number; body_generation: number; body_bytes: number; content_hash: string };
async function livePage(engine: BrainEngine): Promise<Live> {
  const [row] = await engine.executeRaw<Live>('SELECT id, body_generation, body_bytes, content_hash FROM pages WHERE slug=$1', [SLUG]);
  return { ...row!, id: Number(row!.id), body_generation: Number(row!.body_generation), body_bytes: Number(row!.body_bytes) };
}

/** Bytes the live generation's rows cover, gapless from 0. */
async function coveredBytes(engine: BrainEngine, page: Live): Promise<number> {
  const rows = await engine.executeRaw<{ byte_start: string; byte_len: number }>(`SELECT byte_start, byte_len FROM page_body_manifest
    WHERE page_id=$1 AND staging_id IS NULL AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$2) ORDER BY seq`, [page.id, page.body_generation]);
  let end = 0;
  for (const row of rows) { if (Number(row.byte_start) !== end) return -1; end += row.byte_len; }
  return end;
}

export function defineSegmentedPublishTilingCases(opts: { getEngine: () => BrainEngine }): void {
  beforeEach(async () => {
    const engine = opts.getEngine();
    await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [SLUG]);
    await engine.setConfig('pages.segmented_storage', 'on');
  });
  afterEach(() => { installFaultHook(undefined); });

  /** Each race, the refusal it earns, and the state the write's staging ends in (a terminal one stays as the race left it). */
  const races: Array<[string, string, string, (engine: BrainEngine, pageId: number) => Promise<void>]> = [
    ['a fact purge aborts the staging and sweeps it', 'is aborted, so nothing was published', 'aborted', async (engine, pageId) => {
      await engine.executeRaw("UPDATE page_body_stagings SET state='aborted', updated_at=now() WHERE page_id=$1 AND state IN ('open','sealed','prepared')", [pageId]);
      await engine.sweepSegments({ pageId });
    }],
    ['a sweep expires the staging past its idle deadline', 'is expired, so nothing was published', 'expired', async (engine, pageId) => {
      await engine.sweepSegments({ pageId, expireStagings: true, now: new Date(Date.now() + BODY_STAGING_IDLE_MS + 60_000) });
    }],
    ['staged rows go missing under a live staging (the flip guard)', '-byte body (', 'aborted', async (engine, pageId) => {
      await engine.executeRaw('DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NOT NULL', [pageId]);
    }],
  ];

  for (const [name, refusal, staging, race] of races) {
    test(`${name} while the write prepares: the write refuses and the page keeps its previous generation`, async () => {
      const engine = opts.getEngine();
      await importFromContent(engine, SLUG, original, { sourceId: 'default', noEmbed: true });
      const before = await livePage(engine);
      expect(await coveredBytes(engine, before)).toBe(before.body_bytes);
      const bodyBefore = await materializeSegmentedBody(engine, before.id, 'default');

      installFaultHook(async reached => {
        if (reached !== 'segmented:chunks_staged') return;
        installFaultHook(undefined);
        await race(engine, before.id);
      });
      const error = await importFromContent(engine, SLUG, rewritten, { sourceId: 'default', noEmbed: true }).then(() => null, (e: unknown) => e as { code?: string; message?: string });
      installFaultHook(undefined);

      const after = await livePage(engine);
      expect({ code: error?.code, generation: after.body_generation, covered: await coveredBytes(engine, after) })
        .toEqual({ code: 'body_staging_expired', generation: before.body_generation, covered: before.body_bytes });
      expect(error?.message).toContain(refusal);
      expect(after.content_hash).toBe(before.content_hash);
      expect(await engine.executeRaw("SELECT state FROM page_body_stagings WHERE page_id=$1 AND state <> 'committed'", [after.id])).toEqual([{ state: staging }]);
      expect((await readTiledManifest(engine, after.id)).generation).toBe(before.body_generation);
      expect(await materializeSegmentedBody(engine, after.id, 'default')).toEqual(bodyBefore);

      await importFromContent(engine, SLUG, rewritten, { sourceId: 'default', noEmbed: true });
      const retried = await livePage(engine);
      expect(retried.body_generation).toBe(before.body_generation + 1);
      expect(await coveredBytes(engine, retried)).toBe(retried.body_bytes);
    }, 300_000);
  }

  test('a staging that is no longer live keeps its state: an abort leaves a committed one and a move on of a terminal one refuses', async () => {
    const engine = opts.getEngine();
    await importFromContent(engine, SLUG, original, { sourceId: 'default', noEmbed: true });
    const [{ id }] = await engine.executeRaw<{ id: string }>("SELECT id FROM page_body_stagings WHERE slug=$1 AND state='committed'", [SLUG]);
    const state = async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id=$1', [id]))[0]!.state;
    await engine.setBodyStagingState(id, 'aborted');
    await engine.setBodyStagingState(id, 'expired');
    expect(await state()).toBe('committed');
    await expect(engine.setBodyStagingState(id, 'prepared')).rejects.toMatchObject({ code: 'body_staging_expired' });
    await engine.executeRaw("UPDATE page_body_stagings SET state='aborted' WHERE id=$1", [id]);
    await expect(engine.setBodyStagingState(id, 'committed')).rejects.toMatchObject({ code: 'body_staging_expired' });
    expect(await state()).toBe('aborted');
  }, 300_000);
}
