/**
 * Build a segmented page with the engine members directly (Wave B PR 1), independent of the
 * streaming ingest: cut each region at line boundaries into segments of at most
 * SEGMENT_MAX_BYTES, then create the shell, stage texts and manifest rows and flip to
 * generation 1 in one transaction. Segment boundaries are deliberately naive (no
 * protected-region or fence awareness); tests that need the segmenter's cuts use the ingest.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { BODY_LEAD_BYTES, DEFAULT_FLIP_RETIRE_MAX_ROWS, SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import type { BodyRegion, JsonObject, ManifestRowInput, SegmentedPageMeta, SegmentTextInput } from '../../src/core/page-body/types.ts';
import { boundedRawPrefix } from '../../src/core/page-window/bounded-lead.ts';
import { contentHash } from '../../src/core/utils.ts';

export interface SegmentedPageInput {
  slug: string;
  sourceId?: string;
  truth: string;
  timeline?: string;
  meta?: Partial<SegmentedPageMeta>;
  flags?: JsonObject;
}

export interface SegmentedPageState {
  body_storage: string;
  body_generation: number;
  content_hash: string;
  body_bytes: number;
  compiled_truth: string | null;
  timeline: string | null;
  manifest: Array<{ occurrenceId: number; sha256: string; byteStart: number; byteLen: number; genTo: number | null }>;
  texts: number;
}

/** Lines of `text` packed greedily into pieces of at most `max` UTF-8 bytes; a longer line is cut on a code point. */
export function cutAtLines(text: string, max = SEGMENT_MAX_BYTES): string[] {
  const pieces: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (currentBytes + bytes > max && current) { pieces.push(current); current = ''; currentBytes = 0; }
    if (bytes <= max) { current += line; currentBytes += bytes; continue; }
    for (let rest = line; rest;) {
      const head = boundedRawPrefix(rest, max);
      pieces.push(head);
      rest = rest.slice(head.length);
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

const lineCount = (text: string) => (text.match(/\n/g)?.length ?? 0) + (text.endsWith('\n') || !text ? 0 : 1);

/** Create `input.slug` as a segmented page at body_generation 1; returns its page id. */
export async function createSegmentedPage(engine: BrainEngine, input: SegmentedPageInput): Promise<{ id: number }> {
  const sourceId = input.sourceId ?? 'default';
  const timeline = input.timeline ?? '';
  const meta: SegmentedPageMeta = { type: 'note', title: input.slug, frontmatter: {}, ...input.meta };
  const regions: Array<[BodyRegion, string[]]> = [['truth', cutAtLines(input.truth)], ['timeline', cutAtLines(timeline)]];
  const pieces = regions.flatMap(([region, texts]) => texts.map(text => ({ region, text, bytes: Buffer.from(text, 'utf8') })));
  return engine.transaction(async tx => {
    const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
    const { id } = await tx.createSegmentedPageShell(input.slug, meta, { sourceId });
    const stagingId = randomUUID();
    const now = Date.now();
    const totalBytes = pieces.reduce((n, p) => n + p.bytes.length, 0);
    await tx.openBodyStaging({ id: stagingId, kind: 'import', principalKind: 'test', principalId: 'segmented-page-helper', clientRequestId: randomUUID(),
      sourceId, sourceIncarnation: source!.incarnation, slug: input.slug, pageId: id, mode: 'create', baseRevision: null, baseGeneration: 0,
      declaredBytes: totalBytes, declaredSha256: null, reservedBytes: totalBytes, idleExpiresAt: new Date(now + 3_600_000), hardExpiresAt: new Date(now + 7_200_000) });
    const texts: SegmentTextInput[] = pieces.map(p => ({ sha256: createHash('sha256').update(p.bytes).digest(), body: p.bytes, lineCount: lineCount(p.text) }));
    await tx.stageSegmentTexts(sourceId, texts);
    const occurrences = await tx.allocateBodyOccurrenceIds(pieces.length);
    let byteStart = 0, lineStart = 0;
    const rows: ManifestRowInput[] = pieces.map((p, seq) => {
      const row: ManifestRowInput = { pageId: id, occurrenceId: occurrences[seq]!, genFrom: 1, seq, region: p.region, sourceId, sha256: texts[seq]!.sha256,
        byteStart, byteLen: p.bytes.length, lineStart, lineCount: texts[seq]!.lineCount, cutKind: seq === pieces.length - 1 ? 'eof' : 'forced',
        entryState: {}, protectedRegions: [], factsSlots: [], staticProjBytes: p.bytes.length, staticProjLines: texts[seq]!.lineCount, outline: [],
        dateMin: null, dateMax: null, hashState: new Uint8Array(32), stagingId };
      byteStart += p.bytes.length;
      lineStart += texts[seq]!.lineCount;
      return row;
    });
    await tx.stageManifestRows(rows);
    await tx.flipBodyGeneration({ pageId: id, expectedGeneration: 0, newGeneration: 1, stagingId, closeOccurrences: [], retireChunkOccurrences: [],
      retireMaxRows: DEFAULT_FLIP_RETIRE_MAX_ROWS, meta, body: {
        content_hash: contentHash({ ...meta, compiled_truth: input.truth, timeline }),
        body_bytes: totalBytes, truth_bytes: Buffer.byteLength(input.truth, 'utf8'), body_lines: lineCount(input.truth) + lineCount(timeline),
        segment_count: pieces.length, segmenter_version: 1,
        truth_lead: boundedRawPrefix(input.truth, BODY_LEAD_BYTES), timeline_lead: boundedRawPrefix(timeline, BODY_LEAD_BYTES),
        body_flags: input.flags ?? { has_protected: false },
      } });
    await tx.setBodyStagingState(stagingId, 'committed');
    return { id };
  });
}

/** What a mutation probe compares: the page's body columns, its live manifest and the source's segment texts. */
export async function segmentedPageState(engine: BrainEngine, pageId: number, sourceId = 'default'): Promise<SegmentedPageState> {
  const [page] = await engine.executeRaw<Record<string, unknown>>(
    'SELECT body_storage, body_generation, content_hash, body_bytes, compiled_truth, timeline FROM pages WHERE id=$1', [pageId]);
  const [texts] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_segment_texts WHERE source_id=$1', [sourceId]);
  const manifest = (await engine.readManifest(pageId)).map(r => ({ occurrenceId: Number(r.occurrenceId), sha256: Buffer.from(r.sha256).toString('hex'),
    byteStart: Number(r.byteStart), byteLen: Number(r.byteLen), genTo: r.genTo }));
  return { body_storage: String(page!.body_storage), body_generation: Number(page!.body_generation), content_hash: String(page!.content_hash),
    body_bytes: Number(page!.body_bytes), compiled_truth: page!.compiled_truth as string | null, timeline: page!.timeline as string | null,
    manifest, texts: Number(texts?.n ?? 0) };
}
