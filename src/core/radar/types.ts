/**
 * GBrain Radar — snapshot schema types.
 *
 * Radar is a visual MIRROR of a brain, generated from the GBrain engine in a
 * single full pass (`gbrain radar export`). These types define the on-disk
 * snapshot contract. See docs/designs/RADAR_SNAPSHOT_EXPORT.md for the
 * architecture + the load-bearing invariants (engine-only boundary, atomic
 * swap, source-scoped identity, lean-search, incremental-ready primitives).
 *
 * Versioning:
 *  - SCHEMA_VERSION bumps when the snapshot file shapes change (breaking the
 *    contract a frontend consumes). Additive fields do NOT require a bump.
 *  - EXPORTER_VERSION tags the generator build for provenance / debugging.
 */

/** On-disk snapshot schema version. Bump on breaking shape changes only. */
export const SCHEMA_VERSION = 1;

/** Generator build tag, recorded in the manifest for provenance. */
export const EXPORTER_VERSION = '0.1.0';

/** Export mode. v1 only ever emits 'full'; 'incremental' is reserved (D3). */
export type RadarExportMode = 'full' | 'incremental';

/** Snapshot-relative file paths, recorded in the manifest. */
export interface SnapshotFiles {
  manifest: string;
  tree: string;
  pages_index: string;
  graph: string;
  search_index: string;
  views_recent: string;
  /** Directory (relative) holding per-page JSON files. */
  pages_dir: string;
}

/** One source descriptor in the manifest. */
export interface SnapshotSource {
  source_id: string;
  name: string | null;
  /** Count of pages from this source INCLUDED in the snapshot (post-privacy filter). */
  page_count: number;
}

/** Validation outcome for the snapshot (computed before swap). */
export interface SnapshotValidation {
  /** 'pass' = all hard checks held. 'warn' = soft issues recorded in warnings. */
  status: 'pass' | 'warn';
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

/** manifest.json — identity, provenance, counts, validation. */
export interface RadarManifest {
  schema_version: number;
  snapshot_id: string;
  generated_at: string; // ISO-8601
  mode: RadarExportMode;
  /** Id of the snapshot this one replaces; null on first run. Incremental-ready (D3). */
  previous_snapshot_id: string | null;
  /** Fingerprint over every included page's content hash. Incremental-ready (D3). */
  content_hash: string;
  generator: {
    gbrain_version: string;
    exporter_version: string;
    engine: 'postgres' | 'pglite';
  };
  brain_id: string;
  source_ids: string[];
  sources: SnapshotSource[];
  /** What the operator asked for (provenance for the consumer). */
  requested: {
    scope: string | null;
    source_id: string | null;
    include_private: boolean;
  };
  counts: {
    pages: number;
    edges: number;
    edges_resolved: number;
    edges_dangling: number;
    search_docs: number;
    private_excluded: number;
    tags: number;
  };
  files: SnapshotFiles;
  warnings: string[];
  validation: SnapshotValidation;
}

/** A heading parsed from a page body. */
export interface PageHeading {
  level: number; // 1..6
  text: string;
}

/** pages-index.json row — lean per-page metadata (no body). */
export interface PageIndexEntry {
  page_key: string; // "<source_id>::<slug>"
  brain_id: string;
  source_id: string;
  slug: string;
  title: string;
  /** Snapshot-relative path to the per-page JSON detail file. */
  page_path: string;
  /** Original repo-relative source path, when GBrain recorded one. */
  source_path: string | null;
  /** Top-level folder derived from the slug (segment before the first '/'), or null. */
  folder: string | null;
  type: string;
  /** Frontmatter-derived classification fields (best-effort; null when absent). */
  status: string | null;
  scope: string | null;
  privacy: string | null;
  authority: string | null;
  tags: string[];
  /** ISO date strings; null when GBrain had no value. */
  created_at: string | null;
  updated_at: string | null;
  effective_date: string | null;
  content_hash: string;
  headings_count: number;
  inlinks_count: number;
  outlinks_count: number;
  flags: {
    private: boolean;
    has_timeline: boolean;
    orphan: boolean; // zero inbound AND zero outbound resolved links
  };
}

/** pages-index.json top-level shape. */
export interface PagesIndexFile {
  schema_version: number;
  snapshot_id: string;
  pages: PageIndexEntry[];
}

/** One edge endpoint reference inside a per-page detail file. */
export interface PageLinkRef {
  page_key: string | null; // null when the target is not in scope / unresolved
  slug: string;
  link_type: string;
  link_source: string | null;
  resolved: boolean;
}

/** pages/<slug>.json — per-page detail (D6: raw markdown, NO rendered HTML). */
export interface PageDetail {
  page_key: string;
  brain_id: string;
  source_id: string;
  slug: string;
  title: string;
  type: string;
  source_path: string | null;
  /** Full reconstructed Markdown WITH frontmatter (raw; client renders — D6). */
  markdown: string;
  /** Body only (compiled truth), without frontmatter or the timeline section. */
  body: string;
  /** Timeline section text, when present. */
  timeline: string | null;
  frontmatter: Record<string, unknown>;
  headings: PageHeading[];
  tags: string[];
  outlinks: PageLinkRef[];
  backlinks: PageLinkRef[];
  created_at: string | null;
  updated_at: string | null;
  effective_date: string | null;
  content_hash: string;
  flags: {
    private: boolean;
  };
  warnings: string[];
}

/** graph.json node. */
export interface GraphNode {
  page_key: string;
  slug: string;
  source_id: string;
  title: string;
  type: string;
  inlinks: number;
  outlinks: number;
}

/** graph.json edge (only edges whose source page is in scope). */
export interface GraphEdge {
  from_key: string;
  to_key: string | null; // null when the target resolves to nothing in scope
  from_slug: string;
  to_slug: string;
  link_type: string;
  link_source: string | null;
  resolved: boolean;
}

/** graph.json top-level shape. */
export interface GraphFile {
  schema_version: number;
  snapshot_id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** search-index.json doc — lean (D8): no full body. */
export interface SearchDoc {
  page_key: string;
  slug: string;
  source_id: string;
  title: string;
  /** Original source path, when available, else the slug. */
  path: string;
  folder: string | null;
  type: string;
  tags: string[];
  /** Heading texts only (not levels) — keeps the index lean. */
  headings: string[];
  /** Concatenated short frontmatter text (title/aliases/summary/description/tags). */
  frontmatter_text: string;
}

/** search-index.json top-level shape. */
export interface SearchIndexFile {
  schema_version: number;
  snapshot_id: string;
  docs: SearchDoc[];
}

/** A node in tree.json (folder). */
export interface TreeNode {
  name: string;
  path: string; // slug-prefix path of this folder
  folders: TreeNode[];
  pages: Array<{ page_key: string; slug: string; title: string }>;
}

/** tree.json top-level shape. */
export interface TreeFile {
  schema_version: number;
  snapshot_id: string;
  root: TreeNode;
}

/** views/recent.json — most-recently-updated pages. */
export interface RecentView {
  schema_version: number;
  snapshot_id: string;
  generated_at: string;
  pages: Array<{
    page_key: string;
    slug: string;
    title: string;
    type: string;
    date: string | null; // effective_date ?? updated_at
  }>;
}

/** The full in-memory snapshot model produced by buildSnapshot(). */
export interface SnapshotModel {
  manifest: RadarManifest;
  tree: TreeFile;
  pagesIndex: PagesIndexFile;
  graph: GraphFile;
  searchIndex: SearchIndexFile;
  recent: RecentView;
  pages: PageDetail[];
}

/** Options for buildSnapshot / runRadar export. */
export interface RadarExportOpts {
  /** Base output dir. Snapshot lands under <out>/snapshot/. */
  out: string;
  /** Single-source scope; when null, all sources are included. */
  sourceId: string | null;
  /** Operator scope label, recorded in the manifest. */
  scope: string | null;
  /** Include pages classified private. Default false. */
  includePrivate: boolean;
  /** Pretty-print JSON (2-space) instead of compact. */
  pretty: boolean;
  /** Cap on pages exported (smoke/testing). Undefined = no cap. */
  maxPages?: number;
  /** Number of pages in views/recent.json. Default 100. */
  recentLimit?: number;
}
