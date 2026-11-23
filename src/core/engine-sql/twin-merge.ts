/**
 * The row moves of the twin merge (persistence/twin-merge.ts `mergeTwinInto`), the statements it ran through
 * `executeRaw`, with the same text and parameters; only their home moved. Each runs inside the caller's merge
 * transaction.
 *
 *   - `listPageRelationshipKeys`: the relationship keys of the links, then of the link transitions, touching the pages;
 *   - `moveTwinRelations`: drops the twin's link and transition rows that would land on another row's key, then points
 *     the rest at the survivor (rows between the pair stay);
 *   - `moveTwinPageRows`: timeline rows and event projections, raw data, the tag claim, files, page aliases and the
 *     person-added tags;
 *   - `moveTwinFacts`: facts other pages assert about the twin name the survivor;
 *   - `recordSlugRename`: `recordRenameAlias` (page-state/rename-alias.ts) as an engine member.
 */
import type { BrainEngine } from '../engine.ts';
import type { RelationshipKey } from '../link-relationships.ts';
import { recordRenameAlias } from '../page-state/rename-alias.ts';
import { twinLinkLosersStatement, twinMoveRowsStatement, twinTransitionLosersStatement } from './repair-page-scans.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** What `moveTwinRelations` did: the loser rows it dropped, the link ids it moved and how many transitions moved. */
export interface TwinRelationsMoved { deduplicated: number; links_moved: number[]; transitions_moved: number }
/** The pair `moveTwinPageRows` moves rows between. */
export interface TwinPageRows { sourceId: string; twinId: number; survivorId: number; twinSlug: string; survivorSlug: string }

const toKey = (row: RelationshipKey): RelationshipKey => ({ from_page_id: Number(row.from_page_id), to_page_id: Number(row.to_page_id), link_type: row.link_type });

/** The relationship keys of the links, then of the link transitions, that touch `pageIds`. Read-only. */
export async function listPageRelationshipKeys(raw: Raw, pageIds: number[]): Promise<RelationshipKey[]> {
  const links = await raw.executeRaw<RelationshipKey>(`SELECT DISTINCT from_page_id, to_page_id, link_type FROM links
    WHERE from_page_id=ANY($1::int[]) OR to_page_id=ANY($1::int[])`, [pageIds]);
  const transitions = await raw.executeRaw<RelationshipKey>(`SELECT DISTINCT from_page_id, to_page_id, link_type FROM link_transitions
    WHERE from_page_id=ANY($1::int[]) OR to_page_id=ANY($1::int[])`, [pageIds]);
  return [...links.map(toKey), ...transitions.map(toKey)];
}

/** Drops the twin's relationship rows that would land on another row's key, then moves the rest to the survivor. */
export async function moveTwinRelations(raw: Raw, twinId: number, survivorId: number): Promise<TwinRelationsMoved> {
  const linkLosersSql = twinLinkLosersStatement(twinId, survivorId);
  const transitionLosersSql = twinTransitionLosersStatement(twinId, survivorId);
  const linkLosers = (await raw.executeRaw<{ id: number }>(linkLosersSql.text, linkLosersSql.params)).map(row => Number(row.id));
  const transitionLosers = (await raw.executeRaw<{ id: number }>(transitionLosersSql.text, transitionLosersSql.params)).map(row => Number(row.id));
  if (linkLosers.length) await raw.executeRaw('DELETE FROM links WHERE id=ANY($1::int[])', [linkLosers]);
  if (transitionLosers.length) await raw.executeRaw('DELETE FROM link_transitions WHERE id=ANY($1::bigint[])', [transitionLosers]);
  const moveLinksSql = twinMoveRowsStatement('links', twinId, survivorId);
  const movedLinks = (await raw.executeRaw<{ id: number }>(moveLinksSql.text, moveLinksSql.params)).map(row => Number(row.id));
  const moveTransitionsSql = twinMoveRowsStatement('link_transitions', twinId, survivorId);
  const movedTransitions = await raw.executeRaw(moveTransitionsSql.text, moveTransitionsSql.params);
  return { deduplicated: linkLosers.length + transitionLosers.length, links_moved: movedLinks, transitions_moved: movedTransitions.length };
}

/** Moves the twin's timeline, raw data, files, page aliases and person-added tags to the survivor; returns the moved tags. */
export async function moveTwinPageRows(raw: Raw, pair: TwinPageRows): Promise<string[]> {
  const params = [pair.twinId, pair.survivorId];
  const statements: Array<[string, unknown[]]> = [
    [`DELETE FROM timeline_entries s WHERE s.page_id=$1 AND EXISTS (SELECT 1 FROM timeline_entries o WHERE o.page_id=$2 AND o.date=s.date
        AND md5(o.summary)=md5(s.summary) AND o.source=s.source)`, params],
    ['UPDATE timeline_entries SET page_id=$2 WHERE page_id=$1', params],
    ['DELETE FROM timeline_entries s WHERE s.event_page_id=$1 AND EXISTS (SELECT 1 FROM timeline_entries o WHERE o.event_page_id=$2 AND o.date=s.date)', params],
    ['UPDATE timeline_entries SET event_page_id=$2 WHERE event_page_id=$1', params],
    ['UPDATE raw_data r SET page_id=$2 WHERE r.page_id=$1 AND NOT EXISTS (SELECT 1 FROM raw_data o WHERE o.page_id=$2 AND o.source=r.source)', params],
    [`UPDATE tags o SET tag_source='added' WHERE o.page_id=$2 AND o.tag_source='frontmatter'
        AND EXISTS (SELECT 1 FROM tags s WHERE s.page_id=$1 AND s.tag=o.tag AND s.tag_source='added')`, params],
    ['UPDATE files SET page_id=$2, page_slug=$3 WHERE page_id=$1', [...params, pair.survivorSlug]],
    [`UPDATE page_aliases a SET slug=$3 WHERE a.source_id=$1 AND a.slug=$2
        AND NOT EXISTS (SELECT 1 FROM page_aliases o WHERE o.source_id=$1 AND o.slug=$3 AND o.alias_norm=a.alias_norm AND o.origin=a.origin)`, [pair.sourceId, pair.twinSlug, pair.survivorSlug]],
  ];
  for (const [sql, values] of statements) await raw.executeRaw(sql, values);
  return (await raw.executeRaw<{ tag: string }>(`UPDATE tags s SET page_id=$2 WHERE s.page_id=$1 AND s.tag_source IS DISTINCT FROM 'frontmatter'
    AND NOT EXISTS (SELECT 1 FROM tags o WHERE o.page_id=$2 AND o.tag=s.tag) RETURNING tag`, params)).map(row => row.tag);
}

/** Facts of `sourceId` about the twin that the twin's page does not hold now name the survivor; returns their ids. */
export async function moveTwinFacts(raw: Raw, sourceId: string, twinSlug: string, survivorSlug: string): Promise<number[]> {
  return (await raw.executeRaw<{ id: number }>(`UPDATE facts SET entity_slug=$3 WHERE source_id=$1 AND entity_slug=$2
    AND source_markdown_slug IS DISTINCT FROM $2 RETURNING id`, [sourceId, twinSlug, survivorSlug])).map(row => Number(row.id));
}

/** `recordRenameAlias` on this engine or transaction handle. */
export function recordSlugRename(tx: Pick<BrainEngine, 'transaction'>, sourceId: string, oldSlug: string, newSlug: string): Promise<void> {
  return recordRenameAlias(tx, sourceId, oldSlug, newSlug);
}
