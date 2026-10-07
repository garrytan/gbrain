import type { PageReadScope } from '../types.ts';

/** Complete canonical version fields are optional only for legacy partial snapshots. */
export interface PageVersion {
  /** NULL/absent on legacy versions: reverting preserves current deletion state. */
  is_deleted?: boolean | null;
  knowledge_revision?: string | null;
  timeline?: string | null;
  title?: string | null;
  type?: string | null;
  tags?: string[] | null;
  /** The page's recorded canonical file when the version was taken; NULL on file-less pages and legacy versions. */
  source_path?: string | null;
  id: number;
  page_id: number;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
  snapshot_at: Date;
}

/** A version without its snapshot bodies (`get_versions` with `include_body: false`). */
export type PageVersionMetadata = Omit<PageVersion, 'compiled_truth' | 'timeline'>;

/** `getVersions` options: the read scope plus a newest-first row bound and the body projection. */
export interface GetVersionsOpts<B extends boolean = true> extends PageReadScope {
  /** Newest-first prefix length, applied in SQL after every scope and privacy predicate. */
  limit?: number;
  /** false selects no compiled_truth/timeline columns. */
  includeBody?: B;
}

/** `getVersions` rows: bodies unless `includeBody` is false. */
export type PageVersionRows<B extends boolean> = B extends false ? PageVersionMetadata[] : PageVersion[];
