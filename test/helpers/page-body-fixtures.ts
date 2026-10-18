/**
 * Builders for segmented page storage tests (engine-sql/page-body.ts): segment
 * texts with their sha256, manifest rows, stagings, page metadata and body
 * columns, plus a one-call publish of a segmented page at generation 1.
 */
import { createHash, randomUUID } from 'crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { BodyFlipInput, BodyRegion, BodyStagingInput, ManifestRowInput, SegmentChunkInput, SegmentedBodyColumns,
  SegmentedPageMeta, SegmentTextInput } from '../../src/core/page-body/types.ts';
import { BODY_STAGING_HARD_MS, BODY_STAGING_IDLE_MS, DEFAULT_FLIP_RETIRE_MAX_ROWS } from '../../src/core/page-body/limits.ts';

export const sha256 = (body: Uint8Array | string): Uint8Array => new Uint8Array(createHash('sha256').update(body).digest());
export const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

export function segmentText(text: string): SegmentTextInput {
  const body = new TextEncoder().encode(text);
  return { sha256: sha256(body), body, lineCount: text.split('\n').length - (text.endsWith('\n') ? 1 : 0) };
}

export function manifestRow(input: { pageId: number; occurrenceId: number; genFrom: number; seq: number; text: SegmentTextInput;
  byteStart: number; stagingId: string | null; region?: BodyRegion; sourceId?: string; lineStart?: number }): ManifestRowInput {
  return {
    pageId: input.pageId, occurrenceId: input.occurrenceId, genFrom: input.genFrom, seq: input.seq, region: input.region ?? 'truth',
    sourceId: input.sourceId ?? 'default', sha256: input.text.sha256, byteStart: input.byteStart, byteLen: input.text.body.byteLength,
    lineStart: input.lineStart ?? 0, lineCount: input.text.lineCount, cutKind: 'heading',
    entryState: { fence: null, depth: 0, heading: ['Intro'] }, protectedRegions: [{ kind: 'facts', start: 0, end: 4 }],
    factsSlots: [], staticProjBytes: input.text.body.byteLength, staticProjLines: input.text.lineCount,
    outline: [{ level: 2, text: 'Intro', byte: 0 }], dateMin: '2026-01-02', dateMax: '2026-01-03',
    hashState: sha256(`state:${input.occurrenceId}:${input.genFrom}`), stagingId: input.stagingId,
  };
}

export function stagingInput(overrides: Partial<BodyStagingInput> & { slug: string }): BodyStagingInput {
  const now = Date.now();
  return {
    id: randomUUID(), kind: 'put', principalKind: 'local', principalId: 'test', clientRequestId: randomUUID(), sourceId: 'default',
    sourceIncarnation: randomUUID(), pageId: null, mode: 'create', baseRevision: null, baseGeneration: null, declaredBytes: 0,
    declaredSha256: null, reservedBytes: 0, idleExpiresAt: new Date(now + BODY_STAGING_IDLE_MS), hardExpiresAt: new Date(now + BODY_STAGING_HARD_MS),
    ...overrides,
  };
}

export const pageMeta = (title = 'Segmented probe'): SegmentedPageMeta => ({ type: 'note', title, frontmatter: { status: 'probe', nested: { a: 1 } } });

export function bodyColumns(texts: readonly SegmentTextInput[], overrides: Partial<SegmentedBodyColumns> = {}): SegmentedBodyColumns {
  const bytes = texts.reduce((n, t) => n + t.body.byteLength, 0);
  return {
    content_hash: hexOf(sha256(texts.map(t => new TextDecoder().decode(t.body)).join(''))), body_bytes: bytes, truth_bytes: bytes,
    body_lines: texts.reduce((n, t) => n + t.lineCount, 0), segment_count: texts.length, segmenter_version: 1,
    truth_lead: new TextDecoder().decode(texts[0]?.body ?? new Uint8Array()), timeline_lead: 'timeline lead mentions zephyrwinds',
    body_flags: { has_fences: false, regions: ['truth'] }, ...overrides,
  };
}

export function chunk(occurrenceId: number, localOrdinal: number, text: string): SegmentChunkInput {
  return { chunk_text: text, chunk_source: 'compiled_truth', occurrence_id: occurrenceId, local_ordinal: localOrdinal, raw_byte_start: 0, raw_byte_end: text.length };
}

export function flipInput(pageId: number, expectedGeneration: number, stagingId: string, texts: readonly SegmentTextInput[],
  overrides: Partial<BodyFlipInput> = {}): BodyFlipInput {
  return {
    pageId, expectedGeneration, newGeneration: expectedGeneration + 1, stagingId, closeOccurrences: [], retireChunkOccurrences: [],
    retireMaxRows: DEFAULT_FLIP_RETIRE_MAX_ROWS, body: bodyColumns(texts), meta: pageMeta(), ...overrides,
  };
}

/** Stage `texts` as consecutive manifest rows of a new staging at `genFrom` (texts, staging and rows in one transaction). */
export async function stageGeneration(engine: BrainEngine, input: { pageId: number; slug: string; genFrom: number; texts: readonly SegmentTextInput[];
  sourceId?: string; chunkTexts?: boolean }): Promise<{ stagingId: string; occurrences: number[] }> {
  const sourceId = input.sourceId ?? 'default';
  const staging = stagingInput({ slug: input.slug, pageId: input.pageId, sourceId, mode: input.genFrom === 1 ? 'create' : 'replace' });
  const occurrences = await engine.allocateBodyOccurrenceIds(input.texts.length);
  await engine.transaction(async tx => {
    await tx.openBodyStaging(staging);
    await tx.stageSegmentTexts(sourceId, input.texts);
    let byteStart = 0;
    await tx.stageManifestRows(input.texts.map((text, seq) => {
      const row = manifestRow({ pageId: input.pageId, occurrenceId: occurrences[seq]!, genFrom: input.genFrom, seq, text, byteStart, stagingId: staging.id, sourceId });
      byteStart += text.body.byteLength;
      return row;
    }));
    if (input.chunkTexts) {
      await tx.stageSegmentChunks(input.pageId, input.genFrom, input.texts.map((text, i) => chunk(occurrences[i]!, 0, new TextDecoder().decode(text.body))));
    }
  });
  return { stagingId: staging.id, occurrences };
}

/** Create a segmented page and publish `texts` as generation 1. */
export async function publishSegmentedPage(engine: BrainEngine, slug: string, texts: readonly SegmentTextInput[],
  opts: { sourceId?: string; chunkTexts?: boolean } = {}): Promise<{ pageId: number; stagingId: string; occurrences: number[] }> {
  const sourceId = opts.sourceId ?? 'default';
  const { id: pageId } = await engine.createSegmentedPageShell(slug, pageMeta(), { sourceId });
  const staged = await stageGeneration(engine, { pageId, slug, genFrom: 1, texts, sourceId, chunkTexts: opts.chunkTexts });
  await engine.transaction(async tx => {
    await tx.flipBodyGeneration(flipInput(pageId, 0, staged.stagingId, texts));
    await tx.setBodyStagingState(staged.stagingId, 'committed');
  });
  return { pageId, ...staged };
}
