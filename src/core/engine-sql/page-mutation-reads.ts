/**
 * The reads a page write makes before admission (src/core/persistence/page-mutations.ts) that ran through
 * `executeRaw`, as typed members: SQL once for both SQL engines, so the Rust store serves the same members
 * (rust/docs/store/page-mutation-reads.md). Each statement keeps the text its caller ran. The source's local path a
 * `capture --file` judges the file by is the existing `readSourceLocalPath` (engine-sql/memory-mutation-reads.ts,
 * the same statement).
 */
import type { BrainEngine } from '../engine.ts';
import { callerAccessAllowedSql, labelledOnlyForSql, privacyPartSql, readPolicyFragment } from '../search/private-visibility.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

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
  storedPageLabels: 'SELECT type, frontmatter, compiled_truth, timeline, body_storage, body_bytes FROM pages WHERE source_id = $1 AND slug = $2 LIMIT 1',
  slugFolderRules: 'SELECT gbrain_access_folder_rules($1, $2) AS ids',
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

/** The stored columns the enforced member CLI's label check compares (a segmented page's body columns are null). */
export interface StoredPageLabels {
  type: string | null;
  frontmatter: unknown;
  compiled_truth: string | null;
  timeline: string | null;
  body_storage: 'inline' | 'segmented' | null;
  body_bytes: number | null;
}

/** The labels row of the page at (`sourceId`, `slug`) as stored, soft-deleted or not (no withdrawal overlay), or null. */
export async function readStoredPageLabels(tx: Raw, sourceId: string, slug: string): Promise<StoredPageLabels | null> {
  const [row] = await tx.executeRaw<StoredPageLabels>(PAGE_MUTATION_READS_SQL.storedPageLabels, [sourceId, slug]);
  return row ?? null;
}

/**
 * The read policy the enforced member CLI judges an existing page by (enforced-member.ts memberPageView): the member's
 * access and the privacy part for `identity`, in the current caller record, and for a labelled-only member the page must
 * also name it. The Rust store member renders this same text to know what it is asked to apply.
 */
export function memberViewPolicySql(identity: readonly string[], satisfied: readonly string[], labelled: boolean): string {
  return readPolicyFragment('p', identity, true, satisfied) + (labelled ? ' AND ' + labelledOnlyForSql('p', [identity], satisfied) : '');
}

/**
 * Whether the member's read policy admits the page at (`sourceId`, `slug`), soft-deleted or not; null when the source
 * holds no row there. A policy that evaluates to NULL does not admit it.
 */
export async function readMemberPageReadable(tx: Raw, sourceId: string, slug: string, identity: readonly string[], satisfied: readonly string[], labelled: boolean): Promise<boolean | null> {
  const { text, params } = renderFragment(sqlFragment`SELECT (${trustedSql(memberViewPolicySql(identity, satisfied, labelled))}) AS ok FROM pages p WHERE p.source_id = ${sourceId} AND p.slug = ${slug} LIMIT 1`);
  const [row] = await tx.executeRaw<{ ok: boolean | null }>(text, params);
  return row ? row.ok === true : null;
}

/**
 * The source-qualified ids (`<source>:<rule id>`, by rule id) of every folder rule of `sourceId` that covers `slug`,
 * whether or not a page exists there (a create judges its slug by them); null when none does.
 */
export async function readSlugFolderRules(tx: Raw, sourceId: string, slug: string): Promise<string[] | null> {
  const [row] = await tx.executeRaw<{ ids: string[] | null }>(PAGE_MUTATION_READS_SQL.slugFolderRules, [sourceId, slug]);
  return row?.ids ?? null;
}

/** The text the output guard judges a page by (enforced-member.ts namesHiddenPage): member access, then privacy, in the current caller record. */
export const hiddenSlugsPolicySql = (): string => '(' + callerAccessAllowedSql('p') + ' AND ' + privacyPartSql('p') + ')';

/**
 * Each of `slugs` that names a page row (soft-deleted ones too) in some source and no row that passes the current
 * caller's policy outside `hiddenSources`, in byte order. A row whose policy evaluates to NULL counts as visible.
 */
export async function readHiddenPageSlugs(tx: Raw, slugs: readonly string[], hiddenSources: readonly string[]): Promise<string[]> {
  const hidden = hiddenSources.length
    ? sqlFragment`(NOT ${trustedSql(hiddenSlugsPolicySql())} OR p.source_id = ANY(${[...hiddenSources]}::text[]))`
    : sqlFragment`NOT ${trustedSql(hiddenSlugsPolicySql())}`;
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug FROM pages p WHERE p.slug = ANY(${[...slugs]}::text[]) GROUP BY p.slug HAVING bool_and(COALESCE(${hidden}, false)) ORDER BY p.slug COLLATE "C"`);
  const rows = await tx.executeRaw<{ slug: string }>(text, params);
  return rows.map(r => r.slug);
}
