/**
 * Segmented page storage (Wave B): the row shapes shared by the engine
 * methods (engine-sql/page-body.ts), the pure segmenter (page-body/segmenter.ts)
 * and the ingest/publication path. Parser state, protected regions, facts
 * slots, outline and page flags are opaque JSON to the engine: the segmenter
 * owns their contents.
 */
import type { ChunkInput, PageType, PageKind, EffectiveDateSource } from '../types.ts';

export type BodyStorage = 'inline' | 'segmented';
export type BodyRegion = 'truth' | 'timeline';
export type SegmentCutKind = 'heading' | 'day' | 'message' | 'blank' | 'forced' | 'region_end' | 'eof';
export type BodyStagingKind = 'upload' | 'import' | 'sync' | 'put' | 'append' | 'edit' | 'resegment';
export type BodyStagingMode = 'create' | 'replace' | 'append';
export type BodyStagingState = 'open' | 'sealed' | 'prepared' | 'committed' | 'aborted' | 'expired';
export type JsonObject = Record<string, unknown>;

/** One segment's stored text, deduplicated per (source, sha256). */
export interface SegmentTextInput {
  /** sha256 of `body` (32 bytes). */
  sha256: Uint8Array;
  /** Raw UTF-8 bytes, 1..SEGMENT_MAX_BYTES, always valid UTF-8. */
  body: Uint8Array;
  lineCount: number;
}

/** One `page_body_manifest` row as written. */
export interface ManifestRowInput {
  pageId: number;
  /** Stable identity of this segment position; survives offset shifts. */
  occurrenceId: number;
  genFrom: number;
  /** Order within the generation (dense for the live generation). */
  seq: number;
  region: BodyRegion;
  sourceId: string;
  sha256: Uint8Array;
  /** Raw offset in the stored stream (truth bytes, then timeline bytes). */
  byteStart: number;
  byteLen: number;
  /** 0-based raw line number of the segment's first line. */
  lineStart: number;
  lineCount: number;
  cutKind: SegmentCutKind;
  entryState: JsonObject;
  protectedRegions: unknown[];
  factsSlots: unknown[];
  staticProjBytes: number;
  staticProjLines: number;
  outline: unknown[];
  /** ISO dates (YYYY-MM-DD) or null. */
  dateMin: string | null;
  dateMax: string | null;
  /** SHA-256 midstate of the content_hash stream after this row (sha256-resumable.ts exportState). */
  hashState: Uint8Array;
  /** Non-null while the row belongs to an unpublished staging. */
  stagingId: string | null;
}

/** A manifest row as read: the input plus the generation it was closed at. */
export interface ManifestRow extends ManifestRowInput {
  /** Null while live; otherwise the first generation the row is not part of. */
  genTo: number | null;
}

/** A chunk of one segment occurrence, staged under a body generation before the flip. */
export interface SegmentChunkInput extends Omit<ChunkInput, 'chunk_index'> {
  occurrence_id: number;
  /** Order of the chunk inside its occurrence; document order is (manifest byte_start, local_ordinal). */
  local_ordinal: number;
  /** Stored span relative to the occurrence's segment (add the manifest row's byte_start), so it survives a shift. */
  raw_byte_start: number;
  raw_byte_end: number;
}

/** Page metadata a segmented write sets (everything putPage sets except the body columns). */
export interface SegmentedPageMeta {
  type: PageType;
  title: string;
  frontmatter: JsonObject;
  page_kind?: PageKind;
  effective_date?: Date | null;
  effective_date_source?: EffectiveDateSource | null;
  import_filename?: string | null;
  source_path?: string | null;
  source_kind?: string | null;
  source_uri?: string | null;
  ingested_via?: string | null;
  chunker_version?: number | null;
}

/** The body columns of a segmented page after a flip. */
export interface SegmentedBodyColumns {
  content_hash: string;
  body_bytes: number;
  truth_bytes: number;
  body_lines: number;
  segment_count: number;
  segmenter_version: number;
  truth_lead: string;
  timeline_lead: string;
  body_flags: JsonObject;
}

export interface BodyFlipInput {
  pageId: number;
  /** The generation the preparer read; anything else refuses with `revision_changed`. */
  expectedGeneration: number;
  /** Always expectedGeneration + 1. */
  newGeneration: number;
  /** Staged manifest rows of this staging become the live generation. */
  stagingId: string;
  /** Live manifest rows closed at newGeneration (retired and shifted occurrences). */
  closeOccurrences: readonly number[];
  /** Occurrences whose chunk rows at or below expectedGeneration the flip deletes (retired occurrences, and older duplicates of re-chunked kept ones). */
  retireChunkOccurrences: readonly number[];
  /** Promotion from inline: the page's inline chunk rows (body_generation NULL) are deleted too. */
  retireInlineChunks?: boolean;
  /** Delete at most this many retired chunk rows in the transaction; above it the flip deletes none and reports `retireDeferred`. */
  retireMaxRows: number;
  body: SegmentedBodyColumns;
  meta: SegmentedPageMeta;
}

export interface BodyFlipResult {
  /** Retired chunk rows the flip deleted. */
  retiredChunks: number;
  /** True when retirement exceeded `retireMaxRows`: the caller leaves the projection unsealed and queues the retirement. */
  retireDeferred: boolean;
}

export interface BodyStagingInput {
  id: string;
  kind: BodyStagingKind;
  principalKind: string;
  principalId: string;
  clientRequestId: string;
  sourceId: string;
  sourceIncarnation: string;
  slug: string;
  pageId: number | null;
  mode: BodyStagingMode;
  baseRevision: string | null;
  baseGeneration: number | null;
  declaredBytes: number;
  declaredSha256: Uint8Array | null;
  reservedBytes: number;
  idleExpiresAt: Date;
  hardExpiresAt: Date;
}

export interface SegmentSweepOptions {
  sourceId?: string;
  pageId?: number;
  /** Texts younger than this are never swept. Defaults to SEGMENT_TEXT_GC_GRACE_MS. */
  graceMs?: number;
  /** Expire open stagings past their deadlines and delete their staged rows. */
  expireStagings?: boolean;
  now?: Date;
}

export interface SegmentSweepResult {
  retiredChunksDeleted: number;
  manifestRowsDeleted: number;
  textsDeleted: number;
  stagingsExpired: number;
}
