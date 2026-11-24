/**
 * One merge primitive for a duplicate page ("twin") that a surviving page replaces, used by `gbrain repair origin-twins`
 * and the sync-time heal (#6948). It runs inside the caller's write with both page keys held and moves what other pages
 * and the twin's own rows say about the twin to the survivor:
 *
 *   1. links in every role (from, to, origin) and dated link transitions, so manual and custom relationships the twin
 *      holds database-only survive it; links and transitions between the pair stay on the twin. The temporal
 *      relationship state of every touched key is recomputed;
 *   2. timeline rows and timeline events that name the twin, raw data, file attachments, user-added tags (a survivor tag
 *      the import owns becomes user-added when the twin's was), free-text page aliases and facts other pages assert
 *      about the twin;
 *   3. the twin's slug becomes a `slug_aliases` row for the survivor, so links written against it keep resolving;
 *   4. the twin forgets its recorded file (`source_path`, `source_uri` cleared, marked `origin_twin`) and is soft-deleted:
 *      the file stays, the 72 h retention purge removes the twin database-only, and a restored twin writes or removes
 *      no file, so a restore can never claim the survivor's file again;
 *   5. the twin's sync import record is dropped: it describes what the file imported into the twin.
 *
 * A row that lands on a survivor row with the same unique key is dropped only when it says the same thing (same payload)
 * or is re-derived from page bodies (body and frontmatter links, their transitions). Anything else is distinct evidence
 * the merge would lose, so `twinMergeConflicts` lists it and the merge refuses before writing (the group needs a person).
 *
 * Kept on the twin (they go with it when it is purged and come back if it is restored): its import-owned tags, chunks,
 * embeddings, page versions and the projections of its own body. A page version of the twin is written first.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { noteBelief } from '../belief/ledger.ts';
import { recordRenameAlias } from '../page-state/rename-alias.ts';
import { dropRekeyDuplicates } from '../facts/ontology-rekey.ts';
import { refreshRelationships, type RelationshipKey } from '../link-relationships.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from './sync-holds.ts';
import { ORIGIN_TWIN_REASON } from './origin-twins.ts';
import { twinLinkLosersStatement, twinMoveRowsStatement, twinTransitionLosersStatement } from '../engine-sql/repair-page-scans.ts';
import { requireRawSql } from '../rust-engine/errors.ts';

/** Link provenances re-derived from page bodies and frontmatter: a survivor with the same body re-derives each one. */
export const DERIVED_LINK_SOURCES = ['markdown', 'frontmatter', 'mentions', 'wikilink-resolved'];
/** Transition producers re-derived from page bodies; `explicit` and `manual` are stated by a person. */
const DERIVED_TRANSITION_PRODUCERS = ['timeline', 'frontmatter', 'inline', 'dream'];

export interface TwinMergePage { page_id: number; slug: string }
export interface TwinMergeResult { links_moved: number[]; facts_moved: number[]; transitions_moved: number; tags_moved: string[]; deduplicated: number }
/** `id` is the row's id; a raw_data row (unique per page and source, the detail names the source) carries the twin's page id. */
export interface TwinMergeConflict { table: 'links' | 'link_transitions' | 'timeline_entries' | 'raw_data'; id: number; detail: string }

type Exec = Pick<BrainEngine, 'executeRaw'>;

/**
 * Rows of the twin whose move would discard distinct evidence; empty when the merge loses nothing. Read-only. The
 * engine reads what the move lands on (engine-sql/repair-page-scans.ts `listTwinMergeLosers`); a row re-derived from
 * page bodies (a derived link source or transition producer) is not a conflict. A raw_data row is named by the twin's
 * page id and its source (raw_data rows are unique per page and source).
 */
export async function twinMergeConflicts(engine: Pick<BrainEngine, 'listTwinMergeLosers'>, survivorId: number, twinId: number): Promise<TwinMergeConflict[]> {
  const losers = await engine.listTwinMergeLosers(survivorId, twinId);
  const links = losers.links.filter(row => !row.same && !DERIVED_LINK_SOURCES.includes(row.link_source ?? ''))
    .map(row => ({ table: 'links' as const, id: row.id, detail: `a ${row.link_source ?? 'legacy'} link whose context or metadata differs from the survivor's` }));
  const transitions = losers.transitions.filter(row => !row.same && !DERIVED_TRANSITION_PRODUCERS.includes(row.producer))
    .map(row => ({ table: 'link_transitions' as const, id: row.id, detail: `a ${row.producer} relationship date whose precision differs from the survivor's` }));
  const timeline = losers.timeline.map(row => ({ table: 'timeline_entries' as const, id: row.id, detail: 'a timeline entry whose detail differs from the survivor\'s' }));
  const raw = losers.raw_data.map(row => ({ table: 'raw_data' as const, id: twinId, detail: `raw data of source ${row.source} that differs from the survivor's` }));
  return [...links, ...transitions, ...timeline, ...raw];
}

/**
 * The named refusal of the twin merge on an engine without raw SQL (the Rust engine, until `mergeTwinInto` gets typed
 * members). The caller asks before it opens its transaction or submits its request, so nothing of the merge ran and
 * the refusal names the merge, not the first raw statement. PGLite, Postgres and transaction handles pass.
 */
export function requireTwinMerge(engine: object, step: string): void {
  requireRawSql(engine, `${step} (mergeTwinInto moves the twin's links, timeline, raw data, tags, aliases and facts through raw SQL)`);
}

async function relationshipKeys(exec: Exec, table: 'links' | 'link_transitions', pageIds: number[]): Promise<RelationshipKey[]> {
  return (await exec.executeRaw<RelationshipKey>(`SELECT DISTINCT from_page_id, to_page_id, link_type FROM ${table}
    WHERE from_page_id=ANY($1::int[]) OR to_page_id=ANY($1::int[])`, [pageIds])).map(row => ({ from_page_id: Number(row.from_page_id), to_page_id: Number(row.to_page_id), link_type: row.link_type }));
}

export async function mergeTwinInto(tx: BrainEngine, input: { sourceId: string; incarnation: string; survivor: TwinMergePage; twin: TwinMergePage }): Promise<TwinMergeResult> {
  const { sourceId, survivor, twin } = input;
  const params = [twin.page_id, survivor.page_id];
  const conflicts = await twinMergeConflicts(tx, survivor.page_id, twin.page_id);
  if (conflicts.length) {
    throw opError('revision_conflict', 'The duplicate page holds evidence its survivor does not, so the merge was refused.',
      `Merging ${twin.slug} into ${survivor.slug} in source ${sourceId} would discard ${conflicts.map(c => `${c.detail} (${c.table === 'raw_data' ? `raw_data of page ${c.id}` : `${c.table} ${c.id}`})`).join('; ')}. Nothing changed; the group needs a person (gbrain repair origin-twins --source ${sourceId}).`,
      { reason: 'twin_evidence_conflicts' });
  }
  await tx.createVersion(twin.slug, { sourceId });
  await tx.detachPageOrigin(twin.page_id, ORIGIN_TWIN_REASON);
  const before = [...await relationshipKeys(tx, 'links', [twin.page_id]), ...await relationshipKeys(tx, 'link_transitions', [twin.page_id])];
  const linkLosersSql = twinLinkLosersStatement(twin.page_id, survivor.page_id);
  const transitionLosersSql = twinTransitionLosersStatement(twin.page_id, survivor.page_id);
  const linkLosers = (await tx.executeRaw<{ id: number }>(linkLosersSql.text, linkLosersSql.params)).map(row => Number(row.id));
  const transitionLosers = (await tx.executeRaw<{ id: number }>(transitionLosersSql.text, transitionLosersSql.params)).map(row => Number(row.id));
  if (linkLosers.length) await tx.executeRaw('DELETE FROM links WHERE id=ANY($1::int[])', [linkLosers]);
  if (transitionLosers.length) await tx.executeRaw('DELETE FROM link_transitions WHERE id=ANY($1::bigint[])', [transitionLosers]);
  const moveLinksSql = twinMoveRowsStatement('links', twin.page_id, survivor.page_id);
  const movedLinks = (await tx.executeRaw<{ id: number }>(moveLinksSql.text, moveLinksSql.params)).map(row => Number(row.id));
  const moveTransitionsSql = twinMoveRowsStatement('link_transitions', twin.page_id, survivor.page_id);
  const movedTransitions = await tx.executeRaw(moveTransitionsSql.text, moveTransitionsSql.params);
  const statements: Array<[string, unknown[]]> = [
    [`DELETE FROM timeline_entries s WHERE s.page_id=$1 AND EXISTS (SELECT 1 FROM timeline_entries o WHERE o.page_id=$2 AND o.date=s.date
        AND md5(o.summary)=md5(s.summary) AND o.source=s.source)`, params],
    ['UPDATE timeline_entries SET page_id=$2 WHERE page_id=$1', params],
    ['DELETE FROM timeline_entries s WHERE s.event_page_id=$1 AND EXISTS (SELECT 1 FROM timeline_entries o WHERE o.event_page_id=$2 AND o.date=s.date)', params],
    ['UPDATE timeline_entries SET event_page_id=$2 WHERE event_page_id=$1', params],
    ['UPDATE raw_data r SET page_id=$2 WHERE r.page_id=$1 AND NOT EXISTS (SELECT 1 FROM raw_data o WHERE o.page_id=$2 AND o.source=r.source)', params],
    [`UPDATE tags o SET tag_source='added' WHERE o.page_id=$2 AND o.tag_source='frontmatter'
        AND EXISTS (SELECT 1 FROM tags s WHERE s.page_id=$1 AND s.tag=o.tag AND s.tag_source='added')`, params],
    ['UPDATE files SET page_id=$2, page_slug=$3 WHERE page_id=$1', [...params, survivor.slug]],
    [`UPDATE page_aliases a SET slug=$3 WHERE a.source_id=$1 AND a.slug=$2
        AND NOT EXISTS (SELECT 1 FROM page_aliases o WHERE o.source_id=$1 AND o.slug=$3 AND o.alias_norm=a.alias_norm AND o.origin=a.origin)`, [sourceId, twin.slug, survivor.slug]],
  ];
  for (const [sql, values] of statements) await tx.executeRaw(sql, values);
  const tagsMoved = (await tx.executeRaw<{ tag: string }>(`UPDATE tags s SET page_id=$2 WHERE s.page_id=$1 AND s.tag_source IS DISTINCT FROM 'frontmatter'
    AND NOT EXISTS (SELECT 1 FROM tags o WHERE o.page_id=$2 AND o.tag=s.tag) RETURNING tag`, params)).map(row => row.tag);
  await dropRekeyDuplicates(tx, sourceId, { where: 'f.entity_slug = $2 AND f.source_markdown_slug IS DISTINCT FROM $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: [twin.slug, survivor.slug] });
  const factIds = (await tx.executeRaw<{ id: number }>(`UPDATE facts SET entity_slug=$3 WHERE source_id=$1 AND entity_slug=$2
    AND source_markdown_slug IS DISTINCT FROM $2 RETURNING id`, [sourceId, twin.slug, survivor.slug])).map(row => Number(row.id));
  await recordRenameAlias(tx, sourceId, twin.slug, survivor.slug);
  const after = [...await relationshipKeys(tx, 'links', [survivor.page_id]), ...await relationshipKeys(tx, 'link_transitions', [survivor.page_id])];
  await refreshRelationships(tx, [...before, ...after]);
  noteBelief({ kind: 'transferred', fromSlug: twin.slug, table: 'links', ids: movedLinks });
  noteBelief({ kind: 'transferred', fromSlug: twin.slug, table: 'facts', ids: factIds });
  await tx.softDeletePage(twin.slug, { sourceId });
  // The twin's import record goes with the twin: the checkpoint member deletes the row when given no keys, on this tx.
  await tx.writeOpCheckpointRecord(SYNC_IMPORT_PROVENANCE_OP, `${sourceId}:${input.incarnation}:${twin.page_id}`, null);
  return { links_moved: movedLinks, facts_moved: factIds, transitions_moved: movedTransitions.length, tags_moved: tagsMoved, deduplicated: linkLosers.length + transitionLosers.length };
}
