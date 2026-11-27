/**
 * The open-twins scan (src/core/access/open-twins.ts openTwins) that ran through `executeRaw`: the live rows with a
 * changed page's slug in another source that a caller outside the change could still read. The statement keeps its text
 * and parameters; the readers and folder-rule predicates of each outside identity are the vetted builders, joined by OR.
 */
import { folderRulesAllowedSql, privateSnapshotFilterFragment, readersAllowedSql } from '../search/private-visibility.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** How many twins one scan lists. */
export const OPEN_TWINS_LISTED = 50;

/** One identity outside the change: its principals and the folder rules it satisfies. */
export interface OpenTwinReader { identity: readonly string[]; satisfied: readonly string[] }
/** A twin row, the smallest source id of the changed page it twins, and the total count of twins. */
export interface OpenTwinRow { source_id: string; slug: string; twin_of: string; n: number }

/** The twins of `pages` that some `outside` identity can read, by (source, slug), at most OPEN_TWINS_LISTED. */
export async function listOpenTwinRows(raw: EngineRawRead, pages: ReadonlyArray<{ source_id: string; slug: string }>,
  outside: readonly OpenTwinReader[]): Promise<OpenTwinRow[]> {
  const readable = joinFragments(outside.map(reader =>
    sqlFragment`(${trustedSql(readersAllowedSql('t', reader.identity))} AND ${trustedSql(folderRulesAllowedSql('t', reader.satisfied))})`), ' OR ');
  const { text, params } = renderFragment(sqlFragment`${trustedSql(`SELECT t.source_id, t.slug, min(c.source_id) AS twin_of,
      count(*) OVER ()::int AS n FROM unnest($1::text[], $2::text[]) AS c(source_id, slug)
    JOIN pages t ON t.slug = c.slug AND t.source_id <> c.source_id AND t.deleted_at IS NULL
    WHERE NOT EXISTS (SELECT 1 FROM unnest($1::text[], $2::text[]) AS w(source_id, slug) WHERE w.source_id = t.source_id AND w.slug = t.slug)
      AND `)}${trustedSql(privateSnapshotFilterFragment('t'))}${trustedSql(' AND (')}${readable}${trustedSql(`)
    GROUP BY t.source_id, t.slug ORDER BY t.source_id, t.slug LIMIT 50`)}`);
  if (params.length !== 0) throw new Error('listOpenTwinRows: a fragment bound a value ahead of the hand-numbered parameters');
  return raw<OpenTwinRow>(text, [pages.map(page => page.source_id), pages.map(page => page.slug)]);
}
