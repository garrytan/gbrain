/**
 * Access setup and policy-store reads outside access/policy.ts: one SQL implementation for both engines. The open-page
 * count of access/open-pages.ts (gbrain access serves, access serves several, doctor open_shared_pages) and the page
 * reads of commands/access.ts whoCanRead (gbrain access who-can-read). Each statement is the text its caller ran
 * through `executeRaw`, byte for byte (test/engine-sql-caller-raw-sql-pins.test.ts). Every member runs on the
 * executor it is given, so a member of a transaction-bound engine runs on that transaction, and a statement built from
 * the caller record renders in the record the caller set (whoCanRead's member checks run inside one).
 */
import { accessAllowedSql, folderRulesAllowedSql, privacyPartSql } from '../search/private-visibility.ts';
import { ownerOnlyPageSql, type OwnerOnlyForm } from '../access/owner-only.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** The engine's own executeRaw (a transaction-bound engine inside a transaction). */
export interface AccessSetupExec {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/** The open pages of one (source, top-level folder, type, privacy part) group (access/open-pages.ts). */
export interface OpenPageCount { source: string; folder: string; type: string | null; visible: boolean; pages: number }

/** A prefix of a source the open-page count leaves out. */
export interface OpenPageExclusion { source: string; prefix: string }

/** The open-page predicate over pages alias `p`: live, and the read path's floor with an empty identity admits it. */
export const openPageSql = (p: string) => `${p}.deleted_at IS NULL AND ${accessAllowedSql(p, [], [])}`;

/**
 * The statement access/open-pages.ts openPages ran through `executeRaw`, rendered in the current access context (the
 * caller runs it outside any caller record): the open pages of `sources`, less each excluded prefix, grouped by source,
 * top-level folder ('(root)' for a slug with no '/'), type and whether privacyPartSql admits the page.
 */
export function openPagesStatement(sources: readonly string[], exclude: readonly OpenPageExclusion[]): { text: string; params: unknown[] } {
  const excluded = exclude.map(x => sqlFragment` AND NOT (p.source_id = ${x.source} AND starts_with(p.slug, ${x.prefix}))`);
  return renderFragment(sqlFragment`SELECT p.source_id AS source, CASE WHEN strpos(p.slug, '/') > 0 THEN split_part(p.slug, '/', 1) ELSE '(root)' END AS folder,
              p.type AS type, (${trustedSql(privacyPartSql('p'))}) AS visible, count(*)::int AS pages
         FROM pages p
        WHERE ${trustedSql(openPageSql('p'))} AND p.source_id = ANY(${[...sources]}::text[])${joinFragments(excluded, '')}
        GROUP BY 1, 2, 3, 4`);
}

/** The open pages of `sources` (openPagesStatement), one row per group in no set order; an empty list reads nothing. */
export async function countOpenPages(exec: AccessSetupExec, sources: readonly string[], exclude: readonly OpenPageExclusion[]): Promise<OpenPageCount[]> {
  if (!sources.length) return [];
  const { text, params } = openPagesStatement(sources, exclude);
  return (await exec.executeRaw<{ source: string; folder: string; type: string | null; visible: unknown; pages: number | string }>(text, params))
    .map(r => ({ source: r.source, folder: r.folder, type: r.type, visible: r.visible === true, pages: Number(r.pages) }));
}

/** One page row whoCanRead explains: soft-deleted rows too; `owner_only` is ownerOnlyPageSql in the caller's form. */
export interface WhoCanReadPageRow {
  slug: string;
  source_id: string;
  type: string | null;
  frontmatter: unknown;
  folder_rule_ids: string[] | null;
  owner_only: boolean;
}

/** The statement whoCanRead ran through `executeRaw`: every row with slug `$1` (in source `$2` when one is named), by source. */
export function whoCanReadPagesStatement(slug: string, sourceId: string | undefined, form: OwnerOnlyForm): { text: string; params: unknown[] } {
  const scoped = sourceId ? sqlFragment` AND p.source_id = ${sourceId}` : trustedSql('');
  return renderFragment(sqlFragment`SELECT p.slug, p.source_id, p.type, p.frontmatter, p.folder_rule_ids, ${trustedSql(ownerOnlyPageSql('p', form))} AS owner_only
       FROM pages p WHERE p.slug = ${slug}${scoped} ORDER BY p.source_id`);
}

/** The page rows named `slug` (in `sourceId` when given), soft-deleted ones too, by source id. */
export async function listWhoCanReadPages(exec: AccessSetupExec, slug: string, sourceId: string | undefined, form: OwnerOnlyForm): Promise<WhoCanReadPageRow[]> {
  const { text, params } = whoCanReadPagesStatement(slug, sourceId, form);
  return exec.executeRaw<WhoCanReadPageRow>(text, params);
}

/**
 * Whether the read path's floor for reader identity `identity` admits the page row: accessAllowedSql rendered in the
 * caller record the caller set (its folder rules, owner flag and remote policy).
 */
export async function readPageAdmitsCaller(exec: AccessSetupExec, sourceId: string, slug: string, identity: readonly string[]): Promise<boolean> {
  const { text, params } = renderFragment(sqlFragment`SELECT 1 FROM pages p WHERE p.source_id = ${sourceId} AND p.slug = ${slug} AND ${trustedSql(accessAllowedSql('p', identity))}`);
  return (await exec.executeRaw(text, params)).length > 0;
}

/** Whether every folder rule covering the page row is one of `satisfied` (folderRulesAllowedSql). */
export async function readPageFolderRulesAdmit(exec: AccessSetupExec, sourceId: string, slug: string, satisfied: readonly string[]): Promise<boolean> {
  const { text, params } = renderFragment(sqlFragment`SELECT 1 FROM pages p WHERE p.source_id = ${sourceId} AND p.slug = ${slug} AND ${trustedSql(folderRulesAllowedSql('p', satisfied))}`);
  return (await exec.executeRaw(text, params)).length > 0;
}

/**
 * How many of a page's qualified rule ids (`<source>:<rule>`) name no applied raw-only rule (`covers_derived` false)
 * of `sourceId`: rules that keep derived pages and facts to their readers, or ids no applied rule answers.
 */
export async function countLineageClosingRules(exec: AccessSetupExec, ruleIds: readonly string[], sourceId: string): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM unnest($1::text[]) AS x WHERE NOT EXISTS (SELECT 1 FROM access_rules r WHERE r.source_id = $2 AND x = $2 || ':' || r.rule_id AND NOT r.covers_derived)`,
    [ruleIds, sourceId]);
  return Number(row?.n ?? 0);
}
