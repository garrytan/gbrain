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
