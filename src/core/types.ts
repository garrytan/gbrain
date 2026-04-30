// Page types
// email | slack | calendar-event: native Page types for inbox/chat/calendar
// ingest (and the amara-life-v1 eval corpus in the sibling gbrain-evals repo).
// Previously these collapsed into `source`, which lost workflow semantics
// (e.g. "attended meetings" vs "received emails").
// `code` (v0.19.0): tree-sitter-chunked source files; consumed by code-def /
// code-refs / code-callers / code-callees + Cathedral II two-pass retrieval.
export type PageType = 'person' | 'company' | 'deal' | 'yc' | 'civic' | 'project' | 'concept' | 'source' | 'media' | 'writing' | 'analysis' | 'guide' | 'hardware' | 'architecture' | 'meeting' | 'note' | 'email' | 'slack' | 'calendar-event' | 'code';

export interface Page {
  id: number;
  slug: string;
  type: PageType;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash?: string;
  created_at: Date;
  updated_at: Date;
}

export type PageKind = 'markdown' | 'code';

export interface PageInput {
  type: PageType;
  title: string;
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
  content_hash?: string;
  /**
   * v0.19.0: distinguishes markdown vs code pages at the DB level. Defaults
   * to 'markdown' when omitted so existing callers work unchanged. Set to
   * 'code' by importCodeFile; drives orphans filter, auto-link bypass, and
   * `query --lang` filtering.
   */
  page_kind?: PageKind;
  /**
   * v0.27.1: optional per-page source scope. Omitted callers keep the schema
   * default ('default'); named-source sync/import threads this explicitly so
   * writes land under the requested sources.id row.
   */
  source_id?: string;
}

export interface PageFilters {
  type?: PageType;
  tag?: string;
  limit?: number;
  offset?: number;
  /** ISO date string (YYYY-MM-DD or full ISO timestamp). Filter to pages updated_at > value. */
  updated_after?: string;
}

// Chunks
export interface Chunk {
  id: number;
  page_id: number;
  chunk_index: number;
  chunk_text: string;
  chunk_source: 'compiled_truth' | 'timeline' | 'fenced_code';
  embedding: Float32Array | null;
  model: string;
  token_count: number | null;
  embedded_at: Date | null;
  /** v0.19.0 code metadata (NULL for markdown chunks). */
  language?: string | null;
  symbol_name?: string | null;
  symbol_type?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  /** v0.20.0 Cathedral II (NULL for markdown chunks). */
  parent_symbol_path?: string[] | null;
  doc_comment?: string | null;
  symbol_name_qualified?: string | null;
}

/**
 * Lightweight row shape returned by `BrainEngine.listStaleChunks()`.
 * Excludes the `embedding` column on purpose — only chunks needing
 * an embedding come back, and we don't ship the (always-null on stale
 * rows) embedding bytes over the wire. See `embed --stale` egress fix.
 */
export interface StaleChunkRow {
  slug: string;
  chunk_index: number;
  chunk_text: string;
  chunk_source: 'compiled_truth' | 'timeline';
  model: string | null;
  token_count: number | null;
}

export interface ChunkInput {
  chunk_index: number;
  chunk_text: string;
  chunk_source: 'compiled_truth' | 'timeline' | 'fenced_code';
  embedding?: Float32Array;
  model?: string;
  token_count?: number;
  /**
   * v0.19.0: optional code-chunk metadata. Populated by importCodeFile from
   * the tree-sitter AST; NULL for markdown chunks. Drives `query --lang`,
   * `code-def`, `code-refs`, and the new searchCodeChunks engine method.
   */
  language?: string;
  symbol_name?: string;
  symbol_type?: string;
  start_line?: number;
  end_line?: number;
  /**
   * v0.20.0 Cathedral II: qualified symbol identity + parent scope +
   * doc-comment. All populated by importCodeFile from the AST (Layer 5/6);
   * NULL for markdown chunks unless D2 fence extraction populated them.
   */
  parent_symbol_path?: string[];
  doc_comment?: string;
  symbol_name_qualified?: string;
}

// Search
export interface SearchResult {
  slug: string;
  page_id: number;
  title: string;
  type: PageType;
  chunk_text: string;
  chunk_source: 'compiled_truth' | 'timeline';
  chunk_id: number;
  chunk_index: number;
  score: number;
  stale: boolean;
  /**
   * v0.18.0: the sources.id the page belongs to. Dedup composite-keys
   * on (source_id, slug) — see src/core/search/dedup.ts. Defaults to
   * 'default' for pre-v0.17 rows that lacked the column.
   */
  source_id?: string;
}

export interface SearchOpts {
  limit?: number;
  offset?: number;
  type?: PageType;
  exclude_slugs?: string[];
  /**
   * Slug-prefix excludes — additive over DEFAULT_HARD_EXCLUDES (test/, archive/,
   * attachments/, .raw/) and the GBRAIN_SEARCH_EXCLUDE env var. Stacks with
   * `exclude_slugs` (exact match) — a row is filtered if it matches either set.
   */
  exclude_slug_prefixes?: string[];
  /**
   * Opt-back-in list — subtracts entries from the resolved hard-exclude set.
   * E.g. `include_slug_prefixes: ['test/']` lets a query see test/ pages even
   * though they're hard-excluded by default.
   */
  include_slug_prefixes?: string[];
  detail?: 'low' | 'medium' | 'high';
  /**
   * v0.20.0 Cathedral II: filter by content_chunks.language (e.g., 'typescript',
   * 'python', 'ruby'). Used by `gbrain query --lang <lang>`. NULL/undefined
   * returns all languages.
   */
  language?: string;
  /**
   * v0.20.0 Cathedral II: filter by content_chunks.symbol_type (e.g., 'function',
   * 'class', 'method', 'type', 'interface'). Used by `gbrain query --symbol-kind`.
   */
  symbolKind?: string;
  /**
   * v0.20.0 Cathedral II: anchor the two-pass retrieval at a specific qualified
   * symbol name. Pairs with walkDepth. Used by `gbrain query --near-symbol`.
   */
  nearSymbol?: string;
  /**
   * v0.20.0 Cathedral II: structural walk depth for two-pass retrieval. 0 = off
   * (default), 1 or 2 = expand that many hops through code_edges_chunk. Capped
   * at 2 in A2. When walkDepth > 0, dedup's per-page cap lifts to
   * min(10, walkDepth * 5).
   */
  walkDepth?: number;
  /**
   * v0.20.0 Cathedral II: scope search to a specific source. When set,
   * results are filtered by pages.source_id. Use '__all__' or leave
   * undefined to search all sources.
   */
  sourceId?: string;
}

/**
 * v0.20.0 Cathedral II: input for addCodeEdges. One row per edge.
 * from_chunk_id is always known (we're extracting edges from a freshly
 * imported chunk). to_chunk_id may be null (target symbol not yet
 * resolved — row lands in code_edges_symbol instead of code_edges_chunk).
 */
export interface CodeEdgeInput {
  from_chunk_id: number;
  /** Resolved target chunk ID. Undefined/null → row lands in code_edges_symbol. */
  to_chunk_id?: number | null;
  from_symbol_qualified: string;
  to_symbol_qualified: string;
  /** 'calls' | 'imports' | 'extends' | 'implements' | 'mixes_in' | 'type_refs' | 'declares'. */
  edge_type: string;
  edge_metadata?: Record<string, unknown>;
  source_id?: string | null;
}

/**
 * v0.20.0 Cathedral II: result row from code edge queries (getCallersOf,
 * getCalleesOf, getEdgesByChunk). `resolved=true` means the row came from
 * code_edges_chunk (to_chunk_id is a known chunk); `resolved=false` means
 * code_edges_symbol (to_chunk_id is null).
 */
export interface CodeEdgeResult {
  id: number;
  from_chunk_id: number;
  to_chunk_id: number | null;
  from_symbol_qualified: string;
  to_symbol_qualified: string;
  edge_type: string;
  edge_metadata: Record<string, unknown>;
  source_id: string | null;
  resolved: boolean;
}

// Links
export interface Link {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
  /**
   * Provenance (v0.13+). NULL = legacy row (pre-v0.13, unknown source).
   * 'markdown' = extracted from `[Name](path)` refs. 'frontmatter' = extracted
   * from YAML frontmatter fields (company, investors, attendees, etc.).
   * 'manual' = user-created via addLink with explicit source.
   * Reconciliation in runAutoLink filters on link_source to avoid touching
   * markdown / manual edges when rewriting a page's frontmatter.
   */
  link_source?: string | null;
  /**
   * For link_source='frontmatter': the slug of the page whose frontmatter
   * created this edge. Lets reconciliation scope "my edges" precisely when
   * multiple pages reference the same (from, to, type) tuple.
   */
  origin_slug?: string | null;
  /**
   * The frontmatter field name that created this edge (e.g. 'key_people',
   * 'investors'). Used for debug output and the `unresolved` response list.
   */
  origin_field?: string | null;
}

export interface GraphNode {
  slug: string;
  title: string;
  type: PageType;
  depth: number;
  links: { to_slug: string; link_type: string }[];
}

/**
 * Edge in a graph traversal. Used by traversePaths() and graph-query.
 * Unlike GraphNode (which only carries outgoing links), GraphPath represents an
 * actual edge with direction, type, and depth from the root.
 */
export interface GraphPath {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
  /** Depth of `to_slug` from the root (1 for direct neighbors). */
  depth: number;
}

// Timeline
export interface TimelineEntry {
  id: number;
  page_id: number;
  date: string;
  source: string;
  summary: string;
  detail: string;
  created_at: Date;
}

export interface TimelineInput {
  date: string;
  source?: string;
  summary: string;
  detail?: string;
}

export interface TimelineOpts {
  limit?: number;
  after?: string;
  before?: string;
}

// Raw data
export interface RawData {
  source: string;
  data: Record<string, unknown>;
  fetched_at: Date;
}

// Versions
export interface PageVersion {
  id: number;
  page_id: number;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
  snapshot_at: Date;
}

// Stats + Health
export interface BrainStats {
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  link_count: number;
  tag_count: number;
  timeline_entry_count: number;
  pages_by_type: Record<string, number>;
}

export interface BrainHealth {
  page_count: number;
  embed_coverage: number;
  stale_pages: number;
  /**
   * Islanded pages — zero inbound AND zero outbound links. A hub page
   * that has references out but no back-references is NOT an orphan under
   * this definition (it's working as intended as an index). The metric
   * aims at "pages I forgot to connect to anything", not the stricter
   * graph-theory "no inbound" definition. Both engines share this
   * semantics after Bug 11 doc-drift fix.
   */
  orphan_pages: number;
  missing_embeddings: number;
  /**
   * Composite quality score, 0-100. Weighted sum of five components: embed
   * coverage, link density, timeline coverage, orphan avoidance, dead-link
   * avoidance. See the per-component *_score fields below for breakdown.
   */
  brain_score: number;
  /**
   * Number of links whose to_page_id no longer resolves to a page. Under
   * `ON DELETE CASCADE` this is always 0, but malformed data or direct SQL
   * DELETEs can produce dangling references.
   */
  dead_links: number;
  /** Fraction of entity pages (person/company) with >= 1 inbound link. */
  link_coverage: number;
  /** Fraction of entity pages (person/company) with >= 1 structured timeline entry. */
  timeline_coverage: number;
  /** Top 5 entities by total link count (in + out). */
  most_connected: Array<{ slug: string; link_count: number }>;
  /**
   * Per-component contribution to brain_score. Sum equals brain_score by
   * construction. Displayed by `gbrain doctor` when brain_score < 100.
   * Field names are distinct from the entity-scoped link_coverage /
   * timeline_coverage above to avoid semantic collision (these reflect
   * whole-brain measures used in the score formula).
   */
  embed_coverage_score: number;     // 0-35
  link_density_score: number;        // 0-25
  timeline_coverage_score: number;   // 0-15
  no_orphans_score: number;          // 0-15
  no_dead_links_score: number;       // 0-10
}

// Ingest log
export interface IngestLogEntry {
  id: number;
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
  created_at: Date;
}

export interface IngestLogInput {
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
}

// Config
export interface EngineConfig {
  database_url?: string;
  database_path?: string;
  engine?: 'postgres' | 'pglite';
}

// Errors
export class GBrainError extends Error {
  constructor(
    public problem: string,
    public cause_description: string,
    public fix: string,
    public docs_url?: string,
  ) {
    super(`${problem}: ${cause_description}. Fix: ${fix}`);
    this.name = 'GBrainError';
  }
}
