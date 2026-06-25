// src/core/office/types.ts
//
// DocIR (Document Intermediate Representation) — the versioned contract between
// the Docling FastAPI sidecar and gbrain's office-ingest adapter.
//
// Authoritative spec: docs/proposals/office-ingest.md §6.
// Sidecar (Python) and this adapter MUST stay byte-compatible on these shapes;
// bump DOCIR_VERSION on any field-semantics change.

/** DocIR contract version. The adapter rejects a DocIR whose version it does
 *  not understand (fail-closed) rather than mis-parse silently. */
export const DOCIR_VERSION = '1.0' as const;

export type DocFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'image';

export type DocBlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'figure'
  | 'code';

/**
 * chunk_source values produced by the office adapter. Additive to the existing
 * content_chunks.chunk_source set ('compiled_truth' | 'timeline' | 'fenced_code').
 */
export type OfficeChunkSource = 'doc_block' | 'table_summary' | 'table_rows';

/**
 * Precise location of a block/chunk inside the source document. Keys are always
 * present (null when not applicable) per spec §6 C3 — never omitted.
 *
 *  - page:       1-based page index (pdf). For a chunk spanning blocks, the
 *                START page (min). null otherwise.
 *  - slide:      1-based slide index (pptx).
 *  - sheet:      sheet name (xlsx).
 *  - cell_range: A1 notation including sheet, e.g. "Q3!B4:D9". xlsx ONLY.
 *  - table_id:   id of the owning table block (table / table_rows chunks).
 *  - row_range:  [startRow, endRow] 0-based within a table — the precise
 *                locator for pdf/docx/pptx tables which have no cell coords.
 *  - bbox:       [x0, y0, x1, y1] page coordinates (optional).
 */
export interface SourceLocator {
  page: number | null;
  slide: number | null;
  sheet: string | null;
  cell_range: string | null;
  table_id: string | null;
  row_range: [number, number] | null;
  bbox: [number, number, number, number] | null;
}

export interface DocTable {
  header_rows: number;
  n_rows: number;
  n_cols: number;
  columns: string[];
  /** Regular 2D array of stringified cell values (formulas already evaluated). */
  rows: string[][];
}

export interface DocBlock {
  /** Document-stable block id (e.g. "b7"). */
  id: string;
  type: DocBlockType;
  /** Heading level (1-based); null for non-headings. */
  level: number | null;
  /** Normalized markdown — the body gbrain ingests. */
  markdown: string;
  /** Plain text — used for FTS and zero-LLM edge extraction. */
  text: string;
  /** Global document order (ascending, non-overlapping per spec §6 C1). */
  order: number;
  locator: SourceLocator;
  /** Present iff type === 'table' (spec §6 C2). */
  table: DocTable | null;
  /** Present iff type === 'figure' (visual block); references DocAsset.id (C2). */
  asset_ref: string | null;
}

export interface DocAsset {
  id: string;
  kind: 'image';
  mime: string;
  /** base64-encoded image bytes (extracted figure or rendered page). */
  data_b64: string;
  /** true when this is a full-page render (used for OCR / multimodal). */
  is_rendered_page: boolean;
  locator: SourceLocator;
}

export interface DocMeta {
  format: DocFormat;
  /** pdf = pages, pptx = slides, xlsx = sheet count, docx = null. */
  page_count: number | null;
  /** sha256 over the original bytes; gbrain re-verifies (dedup key, C4). */
  content_hash: string;
  /** Parser provenance, e.g. "docling@2.x". */
  parser: string;
}

/** The full payload returned by the sidecar's POST /parse. */
export interface DocIR {
  docir_version: string;
  doc: DocMeta;
  blocks: DocBlock[];
  assets: DocAsset[];
  /** Signals such as "LOW_CONFIDENCE_TABLE:b9" — gate Facts extraction (§11). */
  warnings: string[];
}

/**
 * Output of the doc-block chunker, consumed by importOfficeFile and persisted
 * into content_chunks. chunk_index is assigned by the adapter at write time.
 * source_locator is written via executeRawJsonb — never JSON.stringify into a
 * ::jsonb cast (gbrain JSONB invariant, guarded by check-jsonb-pattern.sh).
 */
export interface OfficeChunk {
  chunk_text: string;
  chunk_source: OfficeChunkSource;
  source_locator: SourceLocator;
}

/** A locator with every dimension null. */
export function emptyLocator(): SourceLocator {
  return {
    page: null,
    slide: null,
    sheet: null,
    cell_range: null,
    table_id: null,
    row_range: null,
    bbox: null,
  };
}

/**
 * Merge several block locators into one spanning locator for a merged prose
 * chunk (spec §21.1). `page` takes the minimum (start) page; scalar dims
 * (slide, sheet) survive only when unanimous. Table-specific dims
 * (cell_range/table_id/row_range/bbox) are dropped — they belong to single
 * table/figure chunks, never to merged prose.
 */
export function mergeLocators(locators: SourceLocator[]): SourceLocator {
  const out = emptyLocator();
  if (locators.length === 0) return out;

  const pages = locators
    .map((l) => l.page)
    .filter((p): p is number => p != null);
  if (pages.length > 0) out.page = Math.min(...pages);

  const unanimous = <T>(values: Array<T | null>): T | null => {
    const set = new Set(values.filter((v): v is T => v != null));
    return set.size === 1 ? [...set][0] : null;
  };
  out.slide = unanimous(locators.map((l) => l.slide));
  out.sheet = unanimous(locators.map((l) => l.sheet));

  return out;
}
