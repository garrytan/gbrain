/**
 * The moves of the twin merge (persistence/twin-merge.ts `mergeTwinInto`) and the moved-pages fold as typed members:
 * `moveTwinRelationships` (links and link transitions: the colliding derived rows dropped, the rest moved onto the
 * survivor, with the relationship keys before and after), `moveTwinPageChildren` (timeline rows and events, raw data,
 * tags, file attachments and free-text page aliases), `moveTwinFacts` (facts other pages assert about the twin) and
 * `movePageVersions` (the fold moves the twin's page versions). Both SQL engines delegate here; the statement texts are
 * the ones mergeTwinInto and the fold sent. The Rust store serves each as one write (rust/crates/gbrain-store/src/
 * repair_twin_merge.rs); the merge itself (`mergeTwinInto`) runs on the Rust engine too, since the fact rekey members
 * `dropRekeyDuplicates` calls are served there (store-members/ontology-repair.ts).
 */
import type { BrainEngine } from '../engine.ts';
import type { RelationshipKey } from '../link-relationships.ts';
import { twinLinkLosersStatement, twinMoveRowsStatement, twinTransitionLosersStatement } from './repair-page-scans.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The twin and the page that replaces it. */
export interface TwinMergeIds { twinId: number; survivorId: number }

/** What `moveTwinRelationships` did: the relationship keys of the twin before and of the survivor after, the moved link ids, the moved transition count and the dropped duplicates. */
export interface TwinRelationshipMoves { before: RelationshipKey[]; after: RelationshipKey[]; linksMoved: number[]; transitionsMoved: number; deduplicated: number }

const RELATIONSHIP_KEYS_SQL = {
  links: `SELECT DISTINCT from_page_id, to_page_id, link_type FROM links
    WHERE from_page_id=ANY($1::int[]) OR to_page_id=ANY($1::int[])`,
  link_transitions: `SELECT DISTINCT from_page_id, to_page_id, link_type FROM link_transitions
    WHERE from_page_id=ANY($1::int[]) OR to_page_id=ANY($1::int[])`,
} as const;

async function relationshipKeys(exec: Raw, table: 'links' | 'link_transitions', pageId: number): Promise<RelationshipKey[]> {
  return (await exec.executeRaw<RelationshipKey>(RELATIONSHIP_KEYS_SQL[table], [[pageId]]))
    .map(row => ({ from_page_id: Number(row.from_page_id), to_page_id: Number(row.to_page_id), link_type: row.link_type }));
}

/**
 * Moves the twin's links and link transitions in every role onto the survivor: a row that would land on another row's
 * key is dropped first (the merge's conflict check refuses before this when such a row is distinct evidence), rows
 * between the pair stay. Run it in the merge's transaction with both page keys held.
 */
export async function moveTwinRelationships(exec: Raw, ids: TwinMergeIds): Promise<TwinRelationshipMoves> {
  const { twinId, survivorId } = ids;
  const before = [...await relationshipKeys(exec, 'links', twinId), ...await relationshipKeys(exec, 'link_transitions', twinId)];
  const linkLosersSql = twinLinkLosersStatement(twinId, survivorId);
  const transitionLosersSql = twinTransitionLosersStatement(twinId, survivorId);
  const linkLosers = (await exec.executeRaw<{ id: number }>(linkLosersSql.text, linkLosersSql.params)).map(row => Number(row.id));
  const transitionLosers = (await exec.executeRaw<{ id: number }>(transitionLosersSql.text, transitionLosersSql.params)).map(row => Number(row.id));
  if (linkLosers.length) await exec.executeRaw('DELETE FROM links WHERE id=ANY($1::int[])', [linkLosers]);
  if (transitionLosers.length) await exec.executeRaw('DELETE FROM link_transitions WHERE id=ANY($1::bigint[])', [transitionLosers]);
  const moveLinksSql = twinMoveRowsStatement('links', twinId, survivorId);
  const linksMoved = (await exec.executeRaw<{ id: number }>(moveLinksSql.text, moveLinksSql.params)).map(row => Number(row.id));
  const moveTransitionsSql = twinMoveRowsStatement('link_transitions', twinId, survivorId);
  const transitionsMoved = (await exec.executeRaw(moveTransitionsSql.text, moveTransitionsSql.params)).length;
  const after = [...await relationshipKeys(exec, 'links', survivorId), ...await relationshipKeys(exec, 'link_transitions', survivorId)];
  return { before, after, linksMoved, transitionsMoved, deduplicated: linkLosers.length + transitionLosers.length };
}

/** The twin's own rows the merge hands to the survivor: which page, by id, slug and source. */
export interface TwinPageChildrenMove extends TwinMergeIds { sourceId: string; twinSlug: string; survivorSlug: string }

/**
 * Moves the twin's timeline rows and events (dropping exact duplicates the survivor holds), raw data of a source the
 * survivor lacks, user-added tags (a survivor tag the import owns becomes user-added when the twin's was), file
 * attachments and free-text page aliases. Returns the tags moved, in the order Postgres returned them.
 */
export async function moveTwinPageChildren(exec: Raw, move: TwinPageChildrenMove): Promise<string[]> {
  const params = [move.twinId, move.survivorId];
  const statements: Array<[string, unknown[]]> = [
    [`DELETE FROM timeline_entries s WHERE s.page_id=$1 AND EXISTS (SELECT 1 FROM timeline_entries o WHERE o.page_id=$2 AND o.date=s.date
        AND md5(o.summary)=md5(s.summary) AND o.source=s.source)`, params],
    ['UPDATE timeline_entries SET page_id=$2 WHERE page_id=$1', params],
    ['DELETE FROM timeline_entries s WHERE s.event_page_id=$1 AND EXISTS (SELECT 1 FROM timeline_entries o WHERE o.event_page_id=$2 AND o.date=s.date)', params],
    ['UPDATE timeline_entries SET event_page_id=$2 WHERE event_page_id=$1', params],
    ['UPDATE raw_data r SET page_id=$2 WHERE r.page_id=$1 AND NOT EXISTS (SELECT 1 FROM raw_data o WHERE o.page_id=$2 AND o.source=r.source)', params],
    [`UPDATE tags o SET tag_source='added' WHERE o.page_id=$2 AND o.tag_source='frontmatter'
        AND EXISTS (SELECT 1 FROM tags s WHERE s.page_id=$1 AND s.tag=o.tag AND s.tag_source='added')`, params],
    ['UPDATE files SET page_id=$2, page_slug=$3 WHERE page_id=$1', [...params, move.survivorSlug]],
    [`UPDATE page_aliases a SET slug=$3 WHERE a.source_id=$1 AND a.slug=$2
        AND NOT EXISTS (SELECT 1 FROM page_aliases o WHERE o.source_id=$1 AND o.slug=$3 AND o.alias_norm=a.alias_norm AND o.origin=a.origin)`, [move.sourceId, move.twinSlug, move.survivorSlug]],
  ];
  for (const [sql, values] of statements) await exec.executeRaw(sql, values);
  return (await exec.executeRaw<{ tag: string }>(`UPDATE tags s SET page_id=$2 WHERE s.page_id=$1 AND s.tag_source IS DISTINCT FROM 'frontmatter'
    AND NOT EXISTS (SELECT 1 FROM tags o WHERE o.page_id=$2 AND o.tag=s.tag) RETURNING tag`, params)).map(row => row.tag);
}

/** Rekeys the facts of source `sourceId` that other pages assert about the twin's slug to the survivor's slug; the moved fact ids. */
export async function moveTwinFacts(exec: Raw, sourceId: string, twinSlug: string, survivorSlug: string): Promise<number[]> {
  return (await exec.executeRaw<{ id: number }>(`UPDATE facts SET entity_slug=$3 WHERE source_id=$1 AND entity_slug=$2
    AND source_markdown_slug IS DISTINCT FROM $2 RETURNING id`, [sourceId, twinSlug, survivorSlug])).map(row => Number(row.id));
}

/** Moves every page version of page `fromPageId` to page `toPageId` (the moved-pages fold); the moved version ids, in id order. */
export async function movePageVersions(exec: Raw, fromPageId: number, toPageId: number): Promise<number[]> {
  return (await exec.executeRaw<{ id: number }>('UPDATE page_versions SET page_id=$2 WHERE page_id=$1 RETURNING id', [fromPageId, toPageId]))
    .map(row => Number(row.id)).sort((a, b) => a - b);
}
