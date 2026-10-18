/**
 * Segmented page storage engine SQL (engine-sql/page-body.ts) on PGLite: every
 * Wave B engine member, the manifest generation reads, the flip (happy path,
 * revision_changed, retire bound, two preparers), the body CHECK and the page
 * triggers on a body_generation-only flip. GC: test/large-pages/segment-gc.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { STAGE_BATCH_BYTES } from '../src/core/page-body/limits.ts';
import { chunk, flipInput, hexOf, pageMeta, publishSegmentedPage, segmentText, stageGeneration, stagingInput } from './helpers/page-body-fixtures.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING");
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function pageRow(pageId: number) {
  const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT body_storage, compiled_truth, timeline, body_generation::int AS body_generation,
      body_bytes::int AS body_bytes, segment_count, truth_lead, timeline_lead, body_flags, content_hash, generation::int AS generation,
      knowledge_revision::text AS knowledge_revision, text_projection_revision::text AS text_projection_revision, search_vector::text AS search_vector, title
    FROM pages WHERE id = $1`, [pageId]);
  return rows[0]!;
}

async function chunkRows(pageId: number) {
  return engine.executeRaw<{ chunk_index: number; occurrence_id: number | null; body_generation: number | null; chunk_text: string }>(
    `SELECT chunk_index, occurrence_id::int AS occurrence_id, body_generation::int AS body_generation, chunk_text
       FROM content_chunks WHERE page_id = $1 ORDER BY chunk_index`, [pageId]);
}

describe('allocateBodyOccurrenceIds', () => {
  test('returns distinct increasing ids and nothing for a zero count', async () => {
    const ids = await engine.allocateBodyOccurrenceIds(3);
    expect(ids.length).toBe(3);
    expect(ids[1]).toBeGreaterThan(ids[0]!);
    expect(ids[2]).toBeGreaterThan(ids[1]!);
    const more = await engine.allocateBodyOccurrenceIds(1);
    expect(more[0]).toBeGreaterThan(ids[2]!);
    expect(await engine.allocateBodyOccurrenceIds(0)).toEqual([]);
  });
});

describe('segment texts', () => {
  test('dedupe per source and round-trip bytes exactly', async () => {
    const a = segmentText('alpha segment ☃ with a NUL \u0000 byte\n');
    const b = segmentText('beta segment\nsecond line\n');
    const c = segmentText('gamma segment\n');
    expect(await engine.stageSegmentTexts('default', [a, b])).toEqual({ inserted: 2 });
    expect(await engine.stageSegmentTexts('default', [a, c])).toEqual({ inserted: 1 });
    expect(await engine.stageSegmentTexts('other', [a])).toEqual({ inserted: 1 });
    const read = await engine.readSegmentTexts('default', [a.sha256, b.sha256, segmentText('never staged').sha256]);
    expect([...read.keys()].sort()).toEqual([hexOf(a.sha256), hexOf(b.sha256)].sort());
    expect(Buffer.from(read.get(hexOf(a.sha256))!).equals(Buffer.from(a.body))).toBe(true);
    expect(read.get(hexOf(b.sha256))).toBeInstanceOf(Uint8Array);
    expect(await engine.readSegmentTexts('default', [])).toEqual(new Map());
  });

  test('a stage larger than one statement batch inserts every text', async () => {
    const segmentBytes = 300 * 1024;
    const count = Math.ceil((STAGE_BATCH_BYTES.pglite * 2) / segmentBytes);
    const texts = Array.from({ length: count }, (_, i) => segmentText(`${i}:`.padEnd(segmentBytes, 'x')));
    expect(await engine.stageSegmentTexts('default', texts)).toEqual({ inserted: count });
    const read = await engine.readSegmentTexts('default', texts.map(t => t.sha256));
    expect(read.size).toBe(count);
  });
});

describe('manifest and flip', () => {
  test('a published page reads generation 1 in seq order; staged rows stay invisible until the flip', async () => {
    const t = [segmentText('# Intro\none\n'), segmentText('## Two\ntwo\n'), segmentText('## Three\nthree\n')];
    const page = await publishSegmentedPage(engine, 'notes/manifest-reads', t);
    const live = await engine.readManifest(page.pageId);
    expect(live.map(r => r.seq)).toEqual([0, 1, 2]);
    expect(live.map(r => r.genFrom)).toEqual([1, 1, 1]);
    expect(live.every(r => r.genTo === null && r.stagingId === null)).toBe(true);
    expect(hexOf(live[1]!.sha256)).toBe(hexOf(t[1]!.sha256));
    expect(live[0]!.entryState).toEqual({ fence: null, depth: 0, heading: ['Intro'] });
    expect(live[0]!.outline).toEqual([{ level: 2, text: 'Intro', byte: 0 }]);
    expect(live[0]!.dateMin).toBe('2026-01-02');

    const replacement = segmentText('## Three, edited\nthree!\n');
    const staged = await stageGeneration(engine, { pageId: page.pageId, slug: 'notes/manifest-reads', genFrom: 2, texts: [replacement] });
    await engine.executeRaw('UPDATE page_body_manifest SET seq = 2 WHERE staging_id = $1::uuid', [staged.stagingId]);
    expect((await engine.readManifest(page.pageId)).length).toBe(3);
    const stagedRows = await engine.readManifest(page.pageId, { stagingId: staged.stagingId });
    expect(stagedRows.map(r => r.occurrenceId)).toEqual(staged.occurrences);

    const before = await pageRow(page.pageId);
    const result = await engine.flipBodyGeneration(flipInput(page.pageId, 1, staged.stagingId, [t[0]!, t[1]!, replacement],
      { closeOccurrences: [page.occurrences[2]!], retireChunkOccurrences: [page.occurrences[2]!] }));
    expect(result).toEqual({ retiredChunks: 0, retireDeferred: false });
    const gen2 = await engine.readManifest(page.pageId);
    expect(gen2.map(r => r.occurrenceId)).toEqual([page.occurrences[0], page.occurrences[1], staged.occurrences[0]]);
    const gen1 = await engine.readManifest(page.pageId, { generation: 1 });
    expect(gen1.map(r => r.occurrenceId)).toEqual(page.occurrences);
    expect(gen1[2]!.genTo).toBe(2);
    const tail = await engine.readManifest(page.pageId, { region: 'truth', lastN: 2 });
    expect(tail.map(r => r.seq)).toEqual([1, 2]);
    expect(await engine.readManifest(page.pageId, { region: 'timeline' })).toEqual([]);

    const after = await pageRow(page.pageId);
    expect(after.body_generation).toBe(2);
    expect(after.compiled_truth).toBeNull();
    expect(after.timeline).toBeNull();
    expect(after.body_storage).toBe('segmented');
    expect(after.segment_count).toBe(3);
    expect(after.body_flags).toEqual({ has_fences: false, regions: ['truth'] });
    expect(after.generation).toBeGreaterThan(before.generation as number);
    expect(after.knowledge_revision).not.toBe(before.knowledge_revision);
    expect(String(after.search_vector)).toContain('zephyrwind');
  });

  test('a flip against a moved generation refuses revision_changed with a read fix and changes nothing', async () => {
    const t = [segmentText('# Moved\nbody\n')];
    const page = await publishSegmentedPage(engine, 'notes/flip-moved', t);
    const staged = await stageGeneration(engine, { pageId: page.pageId, slug: 'notes/flip-moved', genFrom: 2, texts: [segmentText('# Moved\nnew\n')] });
    const before = await pageRow(page.pageId);
    const err = await engine.flipBodyGeneration(flipInput(page.pageId, 0, staged.stagingId, t)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OperationError);
    const op = err as OperationError;
    expect(op.canonical ?? op.code).toBe('revision_changed');
    expect(op.fix?.mcp).toEqual({ tool: 'get_page', arguments: { slug: 'notes/flip-moved', source_id: 'default', body: 'none' } });
    expect(JSON.parse(op.detail!)).toEqual({ expected_generation: 0, current_generation: 1 });
    expect(await pageRow(page.pageId)).toEqual(before);
    expect((await engine.readManifest(page.pageId, { stagingId: staged.stagingId })).length).toBe(1);
    const gone = await engine.flipBodyGeneration(flipInput(2_000_000_000, 0, staged.stagingId, t)).then(() => null, (e: unknown) => e);
    expect((gone as OperationError).code).toBe('page_identity_changed');
    expect(() => engine.flipBodyGeneration(flipInput(page.pageId, 1, staged.stagingId, t, { newGeneration: 3 }))).toThrow(TypeError);
  });

  test('retirement above retireMaxRows deletes none and reports retireDeferred; within the bound it deletes them', async () => {
    const t = [segmentText('# A\na\n'), segmentText('# B\nb\n'), segmentText('# C\nc\n')];
    const page = await publishSegmentedPage(engine, 'notes/flip-retire-bound', t, { chunkTexts: true });
    const replacement = [segmentText('# A2\na\n'), segmentText('# B2\nb\n'), segmentText('# C2\nc\n')];
    const staged = await stageGeneration(engine, { pageId: page.pageId, slug: 'notes/flip-retire-bound', genFrom: 2, texts: replacement, chunkTexts: true });
    const deferred = await engine.transaction(tx => tx.flipBodyGeneration(flipInput(page.pageId, 1, staged.stagingId, replacement,
      { closeOccurrences: page.occurrences, retireChunkOccurrences: page.occurrences, retireMaxRows: 2 })));
    expect(deferred).toEqual({ retiredChunks: 0, retireDeferred: true });
    const rows = await chunkRows(page.pageId);
    expect(rows.filter(r => r.body_generation === 1).map(r => r.occurrence_id).sort()).toEqual([...page.occurrences].sort());
    expect((await pageRow(page.pageId)).body_generation).toBe(2);

    const next = [segmentText('# A3\na\n')];
    const staged3 = await stageGeneration(engine, { pageId: page.pageId, slug: 'notes/flip-retire-bound', genFrom: 3, texts: next, chunkTexts: true });
    const retired = await engine.flipBodyGeneration(flipInput(page.pageId, 2, staged3.stagingId, next,
      { closeOccurrences: staged.occurrences, retireChunkOccurrences: [...page.occurrences, ...staged.occurrences], retireMaxRows: 6 }));
    expect(retired).toEqual({ retiredChunks: 6, retireDeferred: false });
    const after = await chunkRows(page.pageId);
    expect(after.map(r => r.occurrence_id)).toEqual(staged3.occurrences);
  });

  test('two preparers at one generation: the loser\'s staged chunk rows are deleted with the winner\'s flip', async () => {
    const t = [segmentText('# Race\nbase\n')];
    const page = await publishSegmentedPage(engine, 'notes/flip-two-stagings', t, { chunkTexts: true });
    const winner = await stageGeneration(engine, { pageId: page.pageId, slug: 'notes/flip-two-stagings', genFrom: 2, texts: [segmentText('# Race\nwinner\n')], chunkTexts: true });
    const loser = await stageGeneration(engine, { pageId: page.pageId, slug: 'notes/flip-two-stagings', genFrom: 2, texts: [segmentText('# Race\nloser\n')], chunkTexts: true });
    const result = await engine.flipBodyGeneration(flipInput(page.pageId, 1, winner.stagingId, [segmentText('# Race\nwinner\n')],
      { closeOccurrences: page.occurrences, retireChunkOccurrences: page.occurrences }));
    expect(result).toEqual({ retiredChunks: 2, retireDeferred: false });
    const rows = await chunkRows(page.pageId);
    expect(rows.map(r => r.occurrence_id)).toEqual([winner.occurrences[0]!]);
    expect((await engine.readManifest(page.pageId)).map(r => r.occurrenceId)).toEqual(winner.occurrences);
  });

  test('promotion from inline deletes the inline chunk rows and NULLs the body columns', async () => {
    await engine.putPage('notes/promote-inline', { type: 'note', title: 'Promote', compiled_truth: 'inline body', timeline: '' });
    const [{ id: pageId }] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = 'notes/promote-inline' AND source_id = 'default'");
    await engine.upsertChunks('notes/promote-inline', [{ chunk_index: 0, chunk_text: 'inline body', chunk_source: 'compiled_truth' }]);
    const t = [segmentText('# Promoted\nbody\n')];
    const staged = await stageGeneration(engine, { pageId, slug: 'notes/promote-inline', genFrom: 1, texts: t, chunkTexts: true });
    const result = await engine.flipBodyGeneration(flipInput(pageId, 0, staged.stagingId, t, { retireInlineChunks: true }));
    expect(result).toEqual({ retiredChunks: 1, retireDeferred: false });
    const rows = await chunkRows(pageId);
    expect(rows.map(r => [r.chunk_index, r.body_generation])).toEqual([[1, 1]]);
    const page = await pageRow(pageId);
    expect([page.body_storage, page.compiled_truth, page.timeline, page.body_generation]).toEqual(['segmented', null, null, 1]);
  });
});

describe('stageSegmentChunks and the page shell', () => {
  test('chunk indexes continue past the page maximum and carry segment identity and generation', async () => {
    const t = [segmentText('# Chunks\nbody\n')];
    const page = await publishSegmentedPage(engine, 'notes/stage-chunks', t, { chunkTexts: true });
    const [occ] = await engine.allocateBodyOccurrenceIds(1);
    const vector = new Float32Array(await embeddingDims());
    vector[0] = 1;
    const indexes = await engine.stageSegmentChunks(page.pageId, 2, [chunk(occ!, 0, 'first staged'), { ...chunk(occ!, 1, 'second staged'), embedding: vector, model: 'test-model' }]);
    expect(indexes).toEqual([1, 2]);
    const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT chunk_index, local_ordinal, raw_byte_start::int AS raw_byte_start, raw_byte_end::int AS raw_byte_end,
        body_generation::int AS body_generation, embedding IS NULL AS no_vector, embedding_pending_since IS NOT NULL AS pending, embedded_at IS NOT NULL AS embedded,
        embedded_text_hash, model FROM content_chunks WHERE page_id = $1 AND occurrence_id = $2 ORDER BY chunk_index`, [page.pageId, occ]);
    expect(rows.map(r => [r.chunk_index, r.local_ordinal, r.body_generation, r.no_vector, r.pending, r.embedded])).toEqual([
      [1, 0, 2, true, true, false], [2, 1, 2, false, false, true]]);
    expect(rows[1]!.model).toBe('test-model');
    expect(rows[1]!.embedded_text_hash).not.toBeNull();
    expect([rows[0]!.raw_byte_start, rows[0]!.raw_byte_end]).toEqual([0, 'first staged'.length]);
    expect(await engine.stageSegmentChunks(page.pageId, 2, [])).toEqual([]);
  });

  test('createSegmentedPageShell inserts a segmented row at generation 0 with the meta columns', async () => {
    const { id } = await engine.createSegmentedPageShell('notes/shell-probe', { ...pageMeta('Shell'), source_path: 'notes/shell-probe.md', ingested_via: 'test' }, { sourceId: 'default' });
    const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT body_storage, body_generation::int AS g, body_bytes::int AS b, compiled_truth, timeline,
        title, frontmatter, source_path, ingested_via, ingested_at IS NOT NULL AS ingested FROM pages WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ body_storage: 'segmented', g: 0, b: 0, compiled_truth: null, timeline: null, title: 'Shell',
      frontmatter: { status: 'probe', nested: { a: 1 } }, source_path: 'notes/shell-probe.md', ingested_via: 'test', ingested: true });
    expect(() => engine.createSegmentedPageShell('../bad slug', pageMeta(), { sourceId: 'default' })).toThrow();
  });
});

describe('stagings', () => {
  test('openBodyStaging records the row; setBodyStagingState moves it and keeps the commit request id', async () => {
    const input = stagingInput({ slug: 'notes/staging-probe', declaredBytes: 12, declaredSha256: segmentText('x').sha256 });
    await engine.openBodyStaging(input);
    const read = async () => (await engine.executeRaw<Record<string, unknown>>(`SELECT state, kind, mode, declared_bytes::int AS declared,
        encode(declared_sha256, 'hex') AS sha, commit_request_id::text AS req FROM page_body_stagings WHERE id = $1::uuid`, [input.id]))[0];
    expect(await read()).toEqual({ state: 'open', kind: 'put', mode: 'create', declared: 12, sha: hexOf(input.declaredSha256!), req: null });
    const req = crypto.randomUUID();
    await engine.setBodyStagingState(input.id, 'committed', { commitRequestId: req });
    await engine.setBodyStagingState(input.id, 'committed');
    expect(await read()).toMatchObject({ state: 'committed', req });
    await expect(engine.openBodyStaging({ ...input, id: crypto.randomUUID() })).rejects.toThrow();
  });
});

describe('schema guards', () => {
  test('the body CHECK refuses an old-shape body write to a segmented page and a NULL body on an inline page', async () => {
    const page = await publishSegmentedPage(engine, 'notes/check-probe', [segmentText('# Check\nbody\n')]);
    await expect(engine.executeRaw("UPDATE pages SET compiled_truth = 'x' WHERE id = $1", [page.pageId])).rejects.toThrow(/pages_body_storage_chk/);
    await engine.putPage('notes/check-inline', { type: 'note', title: 'Inline', compiled_truth: 'inline', timeline: '' });
    await expect(engine.executeRaw("UPDATE pages SET compiled_truth = NULL WHERE slug = 'notes/check-inline'")).rejects.toThrow(/pages_body_storage_chk/);
    await expect(engine.executeRaw(`INSERT INTO page_versions (page_id, compiled_truth, body_storage) VALUES ($1, NULL, 'inline')`, [page.pageId])).rejects.toThrow(/page_versions_body_chk/);
  });

  test('a body_generation-only update moves generation and knowledge_revision and clears the projection seal', async () => {
    const page = await publishSegmentedPage(engine, 'notes/revision-probe', [segmentText('# Rev\nbody\n')]);
    await engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE id = $1', [page.pageId]);
    const before = await pageRow(page.pageId);
    await engine.executeRaw('UPDATE pages SET body_generation = body_generation + 1 WHERE id = $1', [page.pageId]);
    const after = await pageRow(page.pageId);
    expect(after.generation).toBe((before.generation as number) + 1);
    expect(after.knowledge_revision).not.toBe(before.knowledge_revision);
    expect(after.text_projection_revision).toBeNull();
  });

  test('the page search vector trigger fires on a timeline_lead-only update', async () => {
    const page = await publishSegmentedPage(engine, 'notes/lead-probe', [segmentText('# Lead\nbody\n')]);
    await engine.executeRaw("UPDATE pages SET timeline_lead = 'quixotically renamed lead' WHERE id = $1", [page.pageId]);
    expect(String((await pageRow(page.pageId)).search_vector)).toContain('quixot');
    const [trigger] = await engine.executeRaw<{ cols: string }>(`SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS cols FROM pg_trigger t
      JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = ANY(t.tgattr::int2[]) WHERE t.tgname = 'trg_pages_search_vector'`);
    expect(trigger!.cols).toBe('timeline,timeline_lead,title');
  });

  test('JSONB manifest and page columns are stored as objects and arrays, not strings', async () => {
    const page = await publishSegmentedPage(engine, 'notes/jsonb-probe', [segmentText('# Json\nbody\n')]);
    const [types] = await engine.executeRaw<Record<string, string>>(`SELECT jsonb_typeof(m.entry_state) AS entry_state, jsonb_typeof(m.protected_regions) AS protected_regions,
        jsonb_typeof(m.outline) AS outline, jsonb_typeof(p.body_flags) AS body_flags
      FROM page_body_manifest m JOIN pages p ON p.id = m.page_id WHERE m.page_id = $1`, [page.pageId]);
    expect(types).toEqual({ entry_state: 'object', protected_regions: 'array', outline: 'array', body_flags: 'object' });
  });
});

async function embeddingDims(): Promise<number> {
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`);
  return Number(rows[0]!.dim);
}
