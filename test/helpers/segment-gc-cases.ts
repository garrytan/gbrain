/**
 * Segment garbage collection cases (engine-sql/page-body.ts sweepSegments,
 * spec 3.5), shared by the PGLite arm (test/large-pages/segment-gc.test.ts)
 * and the Postgres arm (test/e2e/segment-gc-parity.test.ts). Each case runs in
 * its own source so a sweep never reaches another case's rows. The concurrent
 * cases need two connections and run on Postgres only.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { BODY_STAGING_HARD_MS } from '../../src/core/page-body/limits.ts';
import { chunk, flipInput, hexOf, manifestRow, publishSegmentedPage, segmentText, stageGeneration, stagingInput } from './page-body-fixtures.ts';

async function freshSource(engine: BrainEngine): Promise<string> {
  const id = `gc-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [id]);
  return id;
}

async function textExists(engine: BrainEngine, sourceId: string, text: { sha256: Uint8Array }): Promise<boolean> {
  return (await engine.readSegmentTexts(sourceId, [text.sha256])).has(hexOf(text.sha256));
}

async function ageTexts(engine: BrainEngine, sourceId: string): Promise<void> {
  await engine.executeRaw("UPDATE page_segment_texts SET created_at = now() - interval '2 hours' WHERE source_id = $1", [sourceId]);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function defineSegmentGcCases(opts: { getEngine: () => BrainEngine; concurrentConnections: boolean }): void {
  test('a text referenced in the same transaction as its ON CONFLICT insert survives a sweep', async () => {
    const engine = opts.getEngine();
    const sourceId = await freshSource(engine);
    const shared = segmentText('# Shared\nsegment text reused by a second page\n');
    await publishSegmentedPage(engine, `notes/gc-first-${sourceId}`, [shared], { sourceId });
    await engine.executeRaw('DELETE FROM pages WHERE source_id = $1', [sourceId]);
    await ageTexts(engine, sourceId);
    const { id: pageId } = await engine.createSegmentedPageShell(`notes/gc-second-${sourceId}`, { type: 'note', title: 'Second', frontmatter: {} }, { sourceId });
    const staging = stagingInput({ slug: `notes/gc-second-${sourceId}`, pageId, sourceId });
    const [occ] = await engine.allocateBodyOccurrenceIds(1);
    await engine.transaction(async tx => {
      await tx.openBodyStaging(staging);
      expect(await tx.stageSegmentTexts(sourceId, [shared])).toEqual({ inserted: 0 });
      await tx.stageManifestRows([manifestRow({ pageId, occurrenceId: occ!, genFrom: 1, seq: 0, text: shared, byteStart: 0, stagingId: staging.id, sourceId })]);
      const swept = await tx.sweepSegments({ sourceId, graceMs: 0 });
      expect(swept.textsDeleted).toBe(0);
    });
    expect(await textExists(engine, sourceId, shared)).toBe(true);
  });

  if (opts.concurrentConnections) {
    test('a sweep on another connection skips a text an open writer transaction references', async () => {
      const engine = opts.getEngine();
      const sourceId = await freshSource(engine);
      const shared = segmentText('# Shared\nreferenced while a sweep runs\n');
      expect(await engine.stageSegmentTexts(sourceId, [shared])).toEqual({ inserted: 1 });
      await ageTexts(engine, sourceId);
      const { id: pageId } = await engine.createSegmentedPageShell(`notes/gc-race-${sourceId}`, { type: 'note', title: 'Race', frontmatter: {} }, { sourceId });
      const staging = stagingInput({ slug: `notes/gc-race-${sourceId}`, pageId, sourceId });
      const [occ] = await engine.allocateBodyOccurrenceIds(1);
      await engine.transaction(async tx => {
        await tx.openBodyStaging(staging);
        await tx.stageSegmentTexts(sourceId, [shared]);
        await tx.stageManifestRows([manifestRow({ pageId, occurrenceId: occ!, genFrom: 1, seq: 0, text: shared, byteStart: 0, stagingId: staging.id, sourceId })]);
        const swept = await engine.sweepSegments({ sourceId, graceMs: 0 });
        expect(swept.textsDeleted).toBe(0);
      });
      expect(await textExists(engine, sourceId, shared)).toBe(true);
    }, 30_000);

    test('a writer that re-stages a text an open sweep is deleting waits and re-inserts it', async () => {
      const engine = opts.getEngine();
      const sourceId = await freshSource(engine);
      const orphan = segmentText('# Orphan\nunreferenced, then referenced mid-sweep\n');
      await engine.stageSegmentTexts(sourceId, [orphan]);
      await ageTexts(engine, sourceId);
      const { id: pageId } = await engine.createSegmentedPageShell(`notes/gc-late-${sourceId}`, { type: 'note', title: 'Late', frontmatter: {} }, { sourceId });
      const staging = stagingInput({ slug: `notes/gc-late-${sourceId}`, pageId, sourceId });
      await engine.openBodyStaging(staging);
      const [occ] = await engine.allocateBodyOccurrenceIds(1);
      let writer: Promise<unknown> | null = null;
      let writerSettled = false;
      await engine.transaction(async gc => {
        expect((await gc.sweepSegments({ sourceId, graceMs: 0 })).textsDeleted).toBe(1);
        writer = engine.transaction(async tx => {
          await tx.stageSegmentTexts(sourceId, [orphan]);
          await tx.stageManifestRows([manifestRow({ pageId, occurrenceId: occ!, genFrom: 1, seq: 0, text: orphan, byteStart: 0, stagingId: staging.id, sourceId })]);
        }).finally(() => { writerSettled = true; });
        await sleep(300);
        expect(writerSettled).toBe(false);
      });
      await writer;
      expect(await textExists(engine, sourceId, orphan)).toBe(true);
      expect((await engine.readManifest(pageId, { stagingId: staging.id })).length).toBe(1);
    }, 30_000);

    test('chunk staging on another connection waits for the page guard instead of deadlocking with it', async () => {
      const engine = opts.getEngine();
      const sourceId = await freshSource(engine);
      const slug = `notes/gc-lock-order-${sourceId}`;
      const page = await publishSegmentedPage(engine, slug, [segmentText('# Lock order\nguarded projection\n')], { sourceId });
      const occurrence = page.occurrences[0]!;
      let writer: Promise<unknown> | null = null;
      await engine.transaction(async guard => {
        await guard.lockPageKeys([{ sourceId, slug }]);
        writer = engine.stageSegmentChunks(page.pageId, 2, [chunk(occurrence, 0, 'staged by a preparation')]);
        await sleep(300);
        await guard.stageSegmentChunks(page.pageId, 1, [chunk(occurrence, 0, 'staged by the projection')]);
      });
      await writer;
      const rows = await engine.executeRaw<{ chunk_text: string }>('SELECT chunk_text FROM content_chunks WHERE page_id = $1 ORDER BY chunk_index', [page.pageId]);
      expect(rows.map(row => row.chunk_text)).toEqual(['staged by the projection', 'staged by a preparation']);
    }, 30_000);
  }

  test('deleting a referenced text is refused by the manifest foreign key', async () => {
    const engine = opts.getEngine();
    const sourceId = await freshSource(engine);
    const t = segmentText('# Referenced\nlive text\n');
    await publishSegmentedPage(engine, `notes/gc-fk-${sourceId}`, [t], { sourceId });
    await expect(engine.executeRaw('DELETE FROM page_segment_texts WHERE source_id = $1', [sourceId])).rejects.toThrow(/foreign key/i);
    expect(await textExists(engine, sourceId, t)).toBe(true);
  });

  test('young unreferenced texts wait out the grace window; old ones go', async () => {
    const engine = opts.getEngine();
    const sourceId = await freshSource(engine);
    const t = segmentText('# Orphan\nnever referenced\n');
    await engine.stageSegmentTexts(sourceId, [t]);
    expect((await engine.sweepSegments({ sourceId })).textsDeleted).toBe(0);
    await ageTexts(engine, sourceId);
    expect((await engine.sweepSegments({ sourceId })).textsDeleted).toBe(1);
    expect(await textExists(engine, sourceId, t)).toBe(false);
  });

  test('staging expiry deletes the staged rows and parts; a request-held staging stays', async () => {
    const engine = opts.getEngine();
    const sourceId = await freshSource(engine);
    const page = await publishSegmentedPage(engine, `notes/gc-expiry-${sourceId}`, [segmentText('# Base\nbody\n')], { sourceId });
    const staged = await stageGeneration(engine, { pageId: page.pageId, slug: `notes/gc-expiry-${sourceId}`, genFrom: 2, sourceId,
      texts: [segmentText('# Base\nabandoned edit\n')], chunkTexts: true });
    await engine.executeRaw(`INSERT INTO page_body_staging_parts (staging_id, part_no, byte_start, byte_len, sha256, body)
      VALUES ($1::uuid, 0, 0, 3, decode(repeat('00', 32), 'hex'), convert_to('abc', 'UTF8'))`, [staged.stagingId]);
    const held = await stageGeneration(engine, { pageId: page.pageId, slug: `notes/gc-expiry-${sourceId}`, genFrom: 2, sourceId,
      texts: [segmentText('# Base\nqueued edit\n')], chunkTexts: true });
    await engine.executeRaw("UPDATE page_body_stagings SET idle_expires_at = now() - interval '1 minute' WHERE id = ANY($1::uuid[])", [[staged.stagingId, held.stagingId]]);
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id = $1', [sourceId]);
    await engine.executeRaw(`INSERT INTO persistence_requests (principal_kind, principal_id, request_id, operation, source_id, source_incarnation, slug, digest,
        authority, intent_bytes, terminal_reservation, intent)
      VALUES ('local_cli', 'test', $1::uuid, 'put_page', $2, $3::uuid, $4, 'digest', '{}'::jsonb, 0, 0, $5::text::jsonb)`,
      [randomUUID(), sourceId, incarnation, `notes/gc-expiry-${sourceId}`, JSON.stringify({ body_ref: { staging_id: held.stagingId } })]);

    const result = await engine.sweepSegments({ sourceId, expireStagings: true });
    expect(result.stagingsExpired).toBe(1);
    const states = await engine.executeRaw<{ id: string; state: string }>('SELECT id::text AS id, state FROM page_body_stagings WHERE source_id = $1', [sourceId]);
    expect(new Map(states.map(s => [s.id, s.state]))).toEqual(new Map([[page.stagingId, 'committed'], [staged.stagingId, 'expired'], [held.stagingId, 'open']]));
    expect(await engine.readManifest(page.pageId, { stagingId: staged.stagingId })).toEqual([]);
    expect((await engine.readManifest(page.pageId, { stagingId: held.stagingId })).length).toBe(1);
    const chunks = await engine.executeRaw<{ occurrence_id: number }>('SELECT occurrence_id::int AS occurrence_id FROM content_chunks WHERE page_id = $1 AND body_generation = 2', [page.pageId]);
    expect(chunks.map(c => c.occurrence_id)).toEqual(held.occurrences);
    const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_staging_parts WHERE staging_id = $1::uuid', [staged.stagingId]);
    expect(n).toBe(0);
    expect((await engine.readManifest(page.pageId)).length).toBe(1);

    const later = new Date(Date.now() + BODY_STAGING_HARD_MS + 60_000);
    await engine.executeRaw("UPDATE persistence_requests SET state = 'failed' WHERE source_id = $1", [sourceId]);
    await engine.sweepSegments({ sourceId, expireStagings: true, now: later });
    const left = await engine.executeRaw<{ id: string; state: string }>('SELECT id::text AS id, state FROM page_body_stagings WHERE source_id = $1', [sourceId]);
    expect(left).toEqual([{ id: held.stagingId, state: 'expired' }]);
  });

  test('a closed manifest row a retained version references survives; unreferenced closed rows go, and the flips already deleted the retired chunks', async () => {
    const engine = opts.getEngine();
    const sourceId = await freshSource(engine);
    const v1 = [segmentText('# One\nfirst\n'), segmentText('# Two\nsecond\n')];
    const page = await publishSegmentedPage(engine, `notes/gc-versions-${sourceId}`, v1, { sourceId, chunkTexts: true });
    await engine.executeRaw(`INSERT INTO page_versions (page_id, compiled_truth, timeline, frontmatter, body_storage, body_generation, body_bytes, content_hash)
      VALUES ($1, NULL, NULL, '{}'::jsonb, 'segmented', 1, 10, 'h1')`, [page.pageId]);
    const v2 = [segmentText('# Two\nsecond, edited\n')];
    const s2 = await stageGeneration(engine, { pageId: page.pageId, slug: `notes/gc-versions-${sourceId}`, genFrom: 2, texts: v2, sourceId, chunkTexts: true });
    await engine.executeRaw('UPDATE page_body_manifest SET seq = 1 WHERE staging_id = $1::uuid', [s2.stagingId]);
    await engine.flipBodyGeneration(flipInput(page.pageId, 1, s2.stagingId, v2, { closeOccurrences: [page.occurrences[1]!], retireChunkOccurrences: [page.occurrences[1]!] }));
    const v3 = [segmentText('# Two\nsecond, edited again\n')];
    const s3 = await stageGeneration(engine, { pageId: page.pageId, slug: `notes/gc-versions-${sourceId}`, genFrom: 3, texts: v3, sourceId, chunkTexts: true });
    await engine.executeRaw('UPDATE page_body_manifest SET seq = 1 WHERE staging_id = $1::uuid', [s3.stagingId]);
    await engine.flipBodyGeneration(flipInput(page.pageId, 2, s3.stagingId, v3, { closeOccurrences: s2.occurrences, retireChunkOccurrences: s2.occurrences }));
    await ageTexts(engine, sourceId);
    const chunkOccurrences = async () => (await engine.executeRaw<{ occurrence_id: number }>(
      'SELECT DISTINCT occurrence_id::int AS occurrence_id FROM content_chunks WHERE page_id = $1 ORDER BY 1', [page.pageId])).map(r => r.occurrence_id);
    expect(await chunkOccurrences()).toEqual([page.occurrences[0]!, s3.occurrences[0]!]);

    const first = await engine.sweepSegments({ pageId: page.pageId, graceMs: 0 });
    expect(first.manifestRowsDeleted).toBe(1);
    expect(first.retiredChunksDeleted).toBe(0);
    expect(first.textsDeleted).toBe(1);
    expect(await textExists(engine, sourceId, v2[0]!)).toBe(false);
    expect((await engine.readManifest(page.pageId, { generation: 1 })).map(r => r.occurrenceId)).toEqual(page.occurrences);
    expect(await textExists(engine, sourceId, v1[1]!)).toBe(true);

    await engine.executeRaw('DELETE FROM page_versions WHERE page_id = $1', [page.pageId]);
    const second = await engine.sweepSegments({ pageId: page.pageId, graceMs: 0 });
    expect(second.manifestRowsDeleted).toBe(1);
    expect(second.textsDeleted).toBe(1);
    expect(await textExists(engine, sourceId, v1[1]!)).toBe(false);
    expect((await engine.readManifest(page.pageId)).map(r => r.occurrenceId)).toEqual([page.occurrences[0], s3.occurrences[0]]);
  });

  test('staged chunk rows no live staging owns are swept; a live staging keeps its rows', async () => {
    const engine = opts.getEngine();
    const sourceId = await freshSource(engine);
    const page = await publishSegmentedPage(engine, `notes/gc-orphan-chunks-${sourceId}`, [segmentText('# Base\nbody\n')], { sourceId });
    const live = await stageGeneration(engine, { pageId: page.pageId, slug: `notes/gc-orphan-chunks-${sourceId}`, genFrom: 2, sourceId,
      texts: [segmentText('# Base\nlive staging\n')], chunkTexts: true });
    const [orphanOcc] = await engine.allocateBodyOccurrenceIds(1);
    await engine.stageSegmentChunks(page.pageId, 2, [chunk(orphanOcc!, 0, 'chunk row without a manifest row')]);
    const result = await engine.sweepSegments({ pageId: page.pageId });
    expect(result.retiredChunksDeleted).toBe(1);
    const rows = await engine.executeRaw<{ occurrence_id: number }>('SELECT occurrence_id::int AS occurrence_id FROM content_chunks WHERE page_id = $1 AND body_generation = 2', [page.pageId]);
    expect(rows.map(r => r.occurrence_id)).toEqual(live.occurrences);
  });

  test('JSONB columns round-trip as objects and arrays and bytea round-trips exactly', async () => {
    const engine = opts.getEngine();
    const sourceId = await freshSource(engine);
    const t = segmentText('# Bytes ☃\n\u0000 and multibyte ü text\n');
    const page = await publishSegmentedPage(engine, `notes/gc-jsonb-${sourceId}`, [t], { sourceId });
    const [types] = await engine.executeRaw<Record<string, string>>(`SELECT jsonb_typeof(m.entry_state) AS entry_state, jsonb_typeof(m.protected_regions) AS protected_regions,
        jsonb_typeof(m.outline) AS outline, jsonb_typeof(p.body_flags) AS body_flags, jsonb_typeof(p.frontmatter) AS frontmatter
      FROM page_body_manifest m JOIN pages p ON p.id = m.page_id WHERE m.page_id = $1`, [page.pageId]);
    expect(types).toEqual({ entry_state: 'object', protected_regions: 'array', outline: 'array', body_flags: 'object', frontmatter: 'object' });
    const [row] = await engine.readManifest(page.pageId);
    expect(row!.entryState).toEqual({ fence: null, depth: 0, heading: ['Intro'] });
    expect(row!.protectedRegions).toEqual([{ kind: 'facts', start: 0, end: 4 }]);
    expect(hexOf(row!.hashState).length).toBe(64);
    const read = await engine.readSegmentTexts(sourceId, [t.sha256]);
    expect(Buffer.from(read.get(hexOf(t.sha256))!).equals(Buffer.from(t.body))).toBe(true);
    const [{ hex }] = await engine.executeRaw<{ hex: string }>('SELECT encode(body, \'hex\') AS hex FROM page_segment_texts WHERE source_id = $1', [sourceId]);
    expect(hex).toBe(Buffer.from(t.body).toString('hex'));
  });
}
