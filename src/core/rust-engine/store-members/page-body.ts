/**
 * Segmented page bodies: segment texts, manifests, staging, the generation flip, derivations and refreshPageBody, each
 * a thin call over the store's page_body family (rust/docs/store/page_body.md). Bytes cross the binding as lowercase
 * hex and dates as ISO strings; this file converts them to and from `Uint8Array` and `Date`.
 *
 * Served: allocateBodyOccurrenceIds, stageSegmentTexts, readSegmentTexts, stageManifestRows, readManifest,
 * stageSegmentChunks, createSegmentedPageShell, flipBodyGeneration, sealSegmentedPage, openBodyStaging, setBodyStagingState,
 * readSegmentDerivations, upsertSegmentDerivations, retireSegmentDerivations, refreshPageBody. stageSegmentChunks
 * refuses a chunk that carries a vector (vectors are not stored), as upsertChunks does.
 *
 * Refused with `engine_capability_missing` (not exported): sweepSegments (needs page_versions and journal roots).
 *
 * The flip and the staging members refuse as PGLite does: the store reports the refusal as an `invalid_state` error
 * whose message is `page_body:<json>`, and `bodyError` rebuilds the error PGLite's engine throws from that JSON.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import type { BodyFlipInput, BodyFlipResult, BodyRegion, BodyStagingInput, BodyStagingState, ManifestRow, ManifestRowInput,
  SegmentChunkInput, SegmentedPageMeta, SegmentTextInput } from '../../page-body/types.ts';
import type { SegmentDerivationInput, SegmentDerivationKind, SegmentDerivationRow } from '../../page-body/derivations.ts';
import { bodyGenerationIncompleteError, bodyStagingGoneError } from '../../engine-sql/page-body.ts';
import { opError } from '../../ops/contract.ts';
import { readFix } from '../../ops/op-fix.ts';
import { prepareChunks } from '../chunk-input.ts';
import { sanitizeRemoteBody } from '../../remote-body.ts';
import { storeErrorCode } from '../store-errors.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
const unhex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'));
const iso = (date: Date | null | undefined): string | null => (date === undefined || date === null ? null : date.toISOString());

/** The refusals the store reports as `page_body:<json>`, rebuilt as the errors engine-sql/page-body.ts throws. */
type BodyRefusal =
  | { kind: 'page_identity_changed'; page_id: number }
  | { kind: 'revision_changed'; slug: string; source_id: string; expected: number; current: number }
  | { kind: 'staging_gone'; slug: string | null; staging_id: string; state: string | null }
  | { kind: 'chunks_stale'; page_id: number; slug: string | null; staged_generation: number; current_generation: number | null }
  | { kind: 'generation_incomplete'; slug: string; staging_id: string; rows: number; covered: number; gapless: boolean;
      body_bytes: number; segment_count: number };

const BODY_REFUSAL = 'page_body:';

function bodyRefusal(error: unknown): BodyRefusal | null {
  if (storeErrorCode(error) !== 'invalid_state' || !(error instanceof Error) || !error.message.startsWith(BODY_REFUSAL)) return null;
  try {
    return JSON.parse(error.message.slice(BODY_REFUSAL.length)) as BodyRefusal;
  } catch {
    return null;
  }
}

function bodyError(refusal: BodyRefusal): Error {
  switch (refusal.kind) {
    case 'page_identity_changed':
      return opError('page_identity_changed', `Page ${refusal.page_id} was deleted while its segmented write was prepared.`,
        'The page was deleted or recreated while this write was prepared, so nothing was published. Read the page that holds the slug now, then write again.',
        { reason: 'page_deleted' });
    case 'revision_changed':
      return opError('revision_changed', `Page ${refusal.slug} moved to body generation ${refusal.current} while this write was prepared at ${refusal.expected}.`,
        'Another write published first. Read the page again and repeat this write against its current revision.',
        { legacy_error: 'invalid_params', detail: JSON.stringify({ expected_generation: refusal.expected, current_generation: refusal.current }),
          fix: readFix('Returns the current revision and size.', { argv: ['gbrain', 'get', '--source', refusal.source_id, '--', refusal.slug],
            mcp: { tool: 'get_page', arguments: { slug: refusal.slug, source_id: refusal.source_id, body: 'none' } } }) });
    case 'chunks_stale':
      return opError('revision_changed', `Page ${refusal.slug ?? refusal.page_id} moved to body generation ${refusal.current_generation ?? 'none'} while chunks for generation ${refusal.staged_generation} were staged.`,
        'Another write published first. Read the page again and repeat this write against its current revision.',
        { legacy_error: 'invalid_params', detail: JSON.stringify({ staged_generation: refusal.staged_generation, current_generation: refusal.current_generation }) });
    case 'staging_gone':
      return bodyStagingGoneError(refusal.slug ?? refusal.staging_id, refusal.staging_id, refusal.state);
    case 'generation_incomplete':
      return bodyGenerationIncompleteError(refusal.slug, refusal.staging_id,
        { rows: refusal.rows, covered: refusal.covered, gapless: refusal.gapless },
        { body_bytes: refusal.body_bytes, segment_count: refusal.segment_count });
  }
}

/** `storeCall` that first rebuilds a `page_body:` refusal into PGLite's error. */
async function bodyCall<T>(member: string, run: () => Promise<T>): Promise<T> {
  return storeCall({ member }, async () => {
    try {
      return await run();
    } catch (error) {
      const refusal = bodyRefusal(error);
      throw refusal ? bodyError(refusal) : error;
    }
  });
}

interface StoredManifestRow extends Omit<ManifestRow, 'sha256' | 'hashState'> { sha256: string; hashState: string }

function toManifestRow(row: StoredManifestRow): ManifestRow {
  return { ...row, sha256: unhex(row.sha256), hashState: unhex(row.hashState) };
}

function manifestInput(row: ManifestRowInput): Record<string, unknown> {
  return {
    pageId: row.pageId, occurrenceId: row.occurrenceId, genFrom: row.genFrom, seq: row.seq, region: row.region,
    sourceId: row.sourceId, sha256: hex(row.sha256), byteStart: row.byteStart, byteLen: row.byteLen, lineStart: row.lineStart,
    lineCount: row.lineCount, cutKind: row.cutKind, entryState: row.entryState, protectedRegions: row.protectedRegions,
    factsSlots: row.factsSlots, staticProjBytes: row.staticProjBytes, staticProjLines: row.staticProjLines, outline: row.outline,
    dateMin: row.dateMin, dateMax: row.dateMax, hashState: hex(row.hashState), stagingId: row.stagingId,
  };
}

function metaInput(meta: SegmentedPageMeta): Record<string, unknown> {
  return { ...meta, effective_date: iso(meta.effective_date) };
}

interface StoredDerivationRow extends Omit<SegmentDerivationRow, 'segmentSha256' | 'contextHash'> { segmentSha256: string; contextHash: string }

export const allocateBodyOccurrenceIds: StoreMember<[count: number], number[]> = async (brain, count) =>
  storeCall({ member: 'allocateBodyOccurrenceIds' }, () => brain.allocateBodyOccurrenceIds(count));

export const stageSegmentTexts: StoreMember<[sourceId: string, texts: readonly SegmentTextInput[], opts?: { stagingId?: string }], { inserted: number }> =
  async (brain, sourceId, texts, opts) => {
    const o = takeOptions('stageSegmentTexts', opts, ['stagingId']);
    const rows = texts.map(text => ({ sha256: hex(text.sha256), body: hex(text.body), lineCount: text.lineCount }));
    return storeCall({ member: 'stageSegmentTexts', sourceId }, () => brain.stageSegmentTexts(sourceId, rows, o));
  };

export const readSegmentTexts: StoreMember<[sourceId: string, sha256s: readonly Uint8Array[]], Map<string, Uint8Array>> = async (brain, sourceId, sha256s) => {
  if (sha256s.length === 0) return new Map();
  const pairs: [string, string][] = await storeCall({ member: 'readSegmentTexts', sourceId }, () => brain.readSegmentTexts(sourceId, sha256s.map(hex)));
  return new Map(pairs.map(([sha, body]) => [sha, unhex(body)]));
};

export const stageManifestRows: StoreMember<[rows: readonly ManifestRowInput[]], void> = async (brain, rows) => {
  if (rows.length === 0) return;
  const input = rows.map(manifestInput);
  await storeCall({ member: 'stageManifestRows' }, () => brain.stageManifestRows(input));
};

export const readManifest: StoreMember<[pageId: number, opts?: { generation?: number; stagingId?: string; region?: BodyRegion; lastN?: number }], ManifestRow[]> =
  async (brain, pageId, opts) => {
    const o = takeOptions('readManifest', opts, ['generation', 'stagingId', 'region', 'lastN']);
    const rows: StoredManifestRow[] = await storeCall({ member: 'readManifest' }, () => brain.readManifest(pageId, o));
    return rows.map(toManifestRow);
  };

/**
 * The chunks get PGLite's normalisation (`prepareChunks`: model default, empty values to null, scrubbed text) plus
 * their place in the occurrence; `chunk_index` is the store's to pick. `opts.embeddingColumn` is refused: PGLite takes
 * the default model label from it, and the store has no embedding columns.
 */
export const stageSegmentChunks: StoreMember<[pageId: number, generation: number, chunks: readonly SegmentChunkInput[], opts?: { embeddingColumn?: unknown }], number[]> =
  async (brain, pageId, generation, chunks, opts) => {
    takeOptions('stageSegmentChunks', opts, []);
    if (chunks.length === 0) return [];
    for (const chunk of chunks) {
      if (chunk.embedding !== undefined || chunk.embedding_image !== undefined) refuseMember('stageSegmentChunks', 'chunk vectors are not stored');
    }
    const prepared = await prepareChunks(brain, chunks.map(chunk => ({ ...chunk, chunk_index: 0 })));
    const sent = prepared.map((row, i) => {
      const { chunk_index: _index, ...rest } = row;
      const c = chunks[i]!;
      return { ...rest, occurrence_id: c.occurrence_id, local_ordinal: c.local_ordinal, raw_byte_start: c.raw_byte_start, raw_byte_end: c.raw_byte_end };
    });
    return bodyCall('stageSegmentChunks', () => brain.stageSegmentChunks(pageId, generation, sent));
  };

export const createSegmentedPageShell: StoreMember<[slug: string, meta: SegmentedPageMeta, opts: { sourceId: string }], { id: number }> =
  async (brain, slug, meta, opts) => {
    const o = takeOptions('createSegmentedPageShell', opts, ['sourceId']);
    return storeCall({ member: 'createSegmentedPageShell', slug, sourceId: o.sourceId as string | undefined },
      () => brain.createSegmentedPageShell(slug, metaInput(meta), o));
  };

export const flipBodyGeneration: StoreMember<[input: BodyFlipInput], BodyFlipResult> = async (brain, input) => {
  if (input.newGeneration !== input.expectedGeneration + 1) throw new TypeError('newGeneration must be expectedGeneration + 1');
  const sent = { ...input, closeOccurrences: [...input.closeOccurrences], retireChunkOccurrences: [...input.retireChunkOccurrences], meta: metaInput(input.meta) };
  return bodyCall('flipBodyGeneration', () => brain.flipBodyGeneration(sent));
};

/**
 * The store reads the page's stored timeline lead and revision (`readSegmentedSealLead`, not a member), this side
 * sanitizes the lead (`timelineLead` when given) with `sanitizeRemoteBody` as engine-sql/page-body.ts does, and the
 * store seals the page at that revision and records the text (`pages::record_search_timeline`). A page that moved in
 * between refuses `revision_conflict`; a missing page is a no-op. PGLite overlays the page's withdrawals and global
 * purges on the lead first; here that overlay is the identity, because the store keeps no withdrawal ledger or purge
 * markers (its readPageSnapshot reports no withdrawals), so the stored lead is the overlaid lead.
 */
export const sealSegmentedPage: StoreMember<[pageId: number, opts?: { timelineLead?: string }], void> = async (brain, pageId, opts) => {
  const o = takeOptions('sealSegmentedPage', opts, ['timelineLead']);
  const stored: { lead: string; revision: string } | null =
    await storeCall({ member: 'sealSegmentedPage' }, () => brain.readSegmentedSealLead(pageId));
  if (!stored) return;
  const lead = typeof o.timelineLead === 'string' ? o.timelineLead : stored.lead;
  await storeCall({ member: 'sealSegmentedPage', expectedRevision: stored.revision },
    () => brain.sealSegmentedPage(pageId, sanitizeRemoteBody(lead), stored.revision));
};

export const openBodyStaging: StoreMember<[input: BodyStagingInput], void> = async (brain, input) => {
  const sent = { ...input, declaredSha256: input.declaredSha256 ? hex(input.declaredSha256) : null,
    idleExpiresAt: iso(input.idleExpiresAt), hardExpiresAt: iso(input.hardExpiresAt) };
  await storeCall({ member: 'openBodyStaging', slug: input.slug, sourceId: input.sourceId }, () => brain.openBodyStaging(sent));
};

export const setBodyStagingState: StoreMember<[id: string, state: BodyStagingState, opts?: { commitRequestId?: string | null }], void> =
  async (brain, id, state, opts) => {
    const o = takeOptions('setBodyStagingState', opts, ['commitRequestId']);
    await bodyCall('setBodyStagingState', () => brain.setBodyStagingState(id, state, o));
  };

export const readSegmentDerivations: StoreMember<[pageId: number, opts?: { kind?: SegmentDerivationKind; occurrenceIds?: readonly number[] }], SegmentDerivationRow[]> =
  async (brain, pageId, opts) => {
    const o = takeOptions('readSegmentDerivations', opts, ['kind', 'occurrenceIds']);
    if (Array.isArray(o.occurrenceIds)) {
      if (o.occurrenceIds.length === 0) return [];
      o.occurrenceIds = [...o.occurrenceIds];
    }
    const rows: StoredDerivationRow[] = await storeCall({ member: 'readSegmentDerivations' }, () => brain.readSegmentDerivations(pageId, o));
    return rows.map(row => ({ ...row, segmentSha256: unhex(row.segmentSha256), contextHash: unhex(row.contextHash) }));
  };

export const upsertSegmentDerivations: StoreMember<[rows: readonly SegmentDerivationInput[]], void> = async (brain, rows) => {
  if (rows.length === 0) return;
  const sent = rows.map(row => ({ ...row, segmentSha256: hex(row.segmentSha256), contextHash: hex(row.contextHash),
    output: row.output ?? null, receipt: row.receipt ?? null }));
  await storeCall({ member: 'upsertSegmentDerivations' }, () => brain.upsertSegmentDerivations(sent));
};

export const retireSegmentDerivations: StoreMember<[pageId: number, live: readonly number[], opts?: { kind?: SegmentDerivationKind }], number> =
  async (brain, pageId, live, opts) => {
    const o = takeOptions('retireSegmentDerivations', opts, ['kind']);
    return storeCall({ member: 'retireSegmentDerivations' }, () => brain.retireSegmentDerivations(pageId, [...live], o));
  };

export const refreshPageBody: StoreMember<[slug: string, sourceId: string, compiledTruth: string, timeline: string, contentHash: string], void> =
  async (brain, slug, sourceId, compiledTruth, timeline, contentHash) => {
    await storeCall({ member: 'refreshPageBody', slug, sourceId }, () => brain.refreshPageBody(slug, sourceId, compiledTruth, timeline, contentHash));
  };
