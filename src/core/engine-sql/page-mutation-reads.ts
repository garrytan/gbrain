/**
 * The reads a page write makes before admission (src/core/persistence/page-mutations.ts) that ran through
 * `executeRaw`, as typed members: SQL once for both SQL engines, so the Rust store serves the same members
 * (rust/docs/store/page-mutation-reads.md). Each statement keeps the text its caller ran. The source's local path a
 * `capture --file` judges the file by is the existing `readSourceLocalPath` (engine-sql/memory-mutation-reads.ts,
 * the same statement).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The stored columns a put_page of a quoted read is unquoted against (no `deleted_at` filter: a soft-deleted page answers too). */
export interface StoredPageHead {
  type: string | null;
  trust_tier: string | null;
  title: string | null;
  /** JSONB: an object on the SQL engines; a caller that may see text parses it. */
  frontmatter: unknown;
}

export const PAGE_MUTATION_READS_SQL = {
  storedPageHead: 'SELECT type, trust_tier, title, frontmatter FROM pages WHERE source_id = $1 AND slug = $2',
  versionSourcePath: 'SELECT source_path FROM page_versions WHERE id=$1 AND page_id=$2',
} as const;

/** The stored type, tier, title and frontmatter of the page at (`sourceId`, `slug`), soft-deleted or not, or null. */
export async function readStoredPageHead(tx: Raw, sourceId: string, slug: string): Promise<StoredPageHead | null> {
  const [stored] = await tx.executeRaw<StoredPageHead>(PAGE_MUTATION_READS_SQL.storedPageHead, [sourceId, slug]);
  return stored ?? null;
}

/** The `source_path` of version `versionId` when it belongs to page `pageId`, or null. */
export async function readVersionSourcePath(tx: Raw, versionId: number, pageId: number): Promise<string | null> {
  const [version] = await tx.executeRaw<{ source_path: string | null }>(PAGE_MUTATION_READS_SQL.versionSourcePath, [versionId, pageId]);
  return version?.source_path ?? null;
}
