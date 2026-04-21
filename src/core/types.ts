// Page types
export type PageType = 'person' | 'company' | 'deal' | 'yc' | 'civic' | 'project' | 'concept' | 'source' | 'media' | 'writing' | 'analysis' | 'guide' | 'hardware' | 'architecture';

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

export interface PageInput {
  type: PageType;
  title: string;
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
  content_hash?: string;
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
  chunk_source: 'compiled_truth' | 'timeline';
  embedding: Float32Array | null;
  model: string;
  token_count: number | null;
  embedded_at: Date | null;
}

export interface ChunkInput {
  chunk_index: number;
  chunk_text: string;
  chunk_source: 'compiled_truth' | 'timeline';
  embedding?: Float32Array;
  model?: string;
  token_count?: number;
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
}

export interface SearchOpts {
  limit?: number;
  offset?: number;
  type?: PageType;
  exclude_slugs?: string[];
  detail?: 'low' | 'medium' | 'high';
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
