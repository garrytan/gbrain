/**
 * The pages a private fact is judged on, shared by `gbrain repair open-facts` (repair/open-facts.ts, which opens such a
 * fact) and the GBRA-575 private-facts grant (access/member-facts.ts factVisibilitySql, which lets one credential read
 * it): its holding page, its provenance page and its entity page. A fact stays private when any of them is a member page,
 * derivation-private in any row with the slug (deleted or not), missing or quarantined, and a fact with no page to
 * check (unpagedFactSql) never opens through the grant. Pure SQL text, no imports beyond
 * the predicates it reuses, so both sides load it without a cycle.
 */
import { MEMBER_PAGE_PREFIX } from '../access/principals.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { derivationPrivateSql } from '../search/private-visibility.ts';

/**
 * The page a fact says it came from (not the page holding it): the page-write
 * session (`put_page:<slug>`, `sync:<slug>`), else the slug a page-write or
 * extract_facts lane records first in `context`.
 */
export function factProvenanceSlugSql(f: string): string {
  return `regexp_replace(COALESCE(
    CASE WHEN ${f}.source_session ~ '^(put_page|sync):' THEN regexp_replace(${f}.source_session, '^(put_page|sync):', '') END,
    CASE WHEN ${f}.source IN ('mcp:put_page','sync:import','file_upload','code_import','hook:writeback','mcp:extract_facts')
      THEN NULLIF(split_part(btrim(COALESCE(${f}.context,'')), ' ', 1), '') END), '\\.md$', '')`;
}

/** The transcript lanes: conversation extraction, capture hooks, the corpus sweep, transcripts and connectors. */
const transcriptLanesSql = (f: string) => `(${f}.source LIKE 'cli:extract-conversation-facts%' OR ${f}.source IN ('hook:writeback', 'hook:compact', 'sweep:corpus')
  OR ${f}.source LIKE 'transcript:%' OR ${f}.source LIKE 'connector:%')`;

/** A fact with no page to check: no holding page, or from a transcript lane (open-facts' unpaged:<lane> class; NULL reads as paged). */
export const unpagedFactSql = (f: string) => `(${f}.source_markdown_slug IS NULL OR ${transcriptLanesSql(f)})`;

/** Whether fact `f` is held on, provenanced from or about a member page (memory/members/<id>); NULL when no slug is set. */
export function factOnMemberPageSql(f: string): string {
  const member = (expr: string) => `left(${expr}, ${MEMBER_PAGE_PREFIX.length}) = '${MEMBER_PAGE_PREFIX}'`;
  return `(${member(`${f}.source_markdown_slug`)} OR ${member(`${f}.entity_slug`)} OR ${member(`(${factProvenanceSlugSql(f)})`)})`;
}

/** Any page row with the slug (deleted or not) that is derivation-private. */
const anyPrivatePage = (f: string, slug: string, alias: string) =>
  `EXISTS (SELECT 1 FROM pages ${alias} WHERE ${alias}.source_id = ${f}.source_id AND ${alias}.slug = ${slug} AND ${derivationPrivateSql(alias)})`;
const livePage = (f: string, slug: string, alias: string, extra = 'true') =>
  `EXISTS (SELECT 1 FROM pages ${alias} WHERE ${alias}.source_id = ${f}.source_id AND ${alias}.slug = ${slug} AND ${alias}.deleted_at IS NULL AND ${extra})`;

/** The page reasons fact `f` stays private, in the order the open-facts preview reports them: [reason, condition]. */
export function factPageReasons(f: string): Array<[string, string]> {
  const prov = `(${factProvenanceSlugSql(f)})`;
  const holding = `${f}.source_markdown_slug`;
  return [
    ['holding_page_private', `${holding} IS NOT NULL AND ${anyPrivatePage(f, holding, 'oh')}`],
    ['holding_page_missing', `${holding} IS NOT NULL AND NOT ${livePage(f, holding, 'oh')}`],
    ['holding_page_quarantined', `${holding} IS NOT NULL AND ${livePage(f, holding, 'oh', `NOT ${quarantineFilterFragment('oh')}`)}`],
    ['provenance_private', `${prov} IS NOT NULL AND ${anyPrivatePage(f, prov, 'op')}`],
    ['provenance_unresolved', `${prov} IS NOT NULL AND NOT ${livePage(f, prov, 'op')}`],
    ['provenance_quarantined', `${prov} IS NOT NULL AND ${livePage(f, prov, 'op', `NOT ${quarantineFilterFragment('op')}`)}`],
    ['entity_page_private', `${f}.entity_slug IS NOT NULL AND ${anyPrivatePage(f, `${f}.entity_slug`, 'oe')}`],
  ];
}

/** GBRA-575: none of fact `f`'s pages keeps it private (no member page, no page reason); a NULL test counts as not private. */
export function factPagesOpenSql(f: string): string {
  return `NOT COALESCE(${factOnMemberPageSql(f)} OR ${factPageReasons(f).map(([, condition]) => `(${condition})`).join(' OR ')}, false)`;
}
