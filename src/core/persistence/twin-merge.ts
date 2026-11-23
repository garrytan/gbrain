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
import { refreshRelationships } from '../link-relationships.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from './sync-holds.ts';
import { ORIGIN_TWIN_REASON } from './origin-twins.ts';

/** Link provenances re-derived from page bodies and frontmatter: a survivor with the same body re-derives each one. */
export const DERIVED_LINK_SOURCES = ['markdown', 'frontmatter', 'mentions', 'wikilink-resolved'];
/** Transition producers re-derived from page bodies; `explicit` and `manual` are stated by a person. */
const DERIVED_TRANSITION_PRODUCERS = ['timeline', 'frontmatter', 'inline', 'dream'];

export interface TwinMergePage { page_id: number; slug: string }
export interface TwinMergeResult { links_moved: number[]; facts_moved: number[]; transitions_moved: number; tags_moved: string[]; deduplicated: number }
/** `id` is the row's id; a raw_data row (unique per page and source, the detail names the source) carries the twin's page id. */
export interface TwinMergeConflict { table: 'links' | 'link_transitions' | 'timeline_entries' | 'raw_data'; id: number; detail: string }

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

export async function mergeTwinInto(tx: BrainEngine, input: { sourceId: string; incarnation: string; survivor: TwinMergePage; twin: TwinMergePage }): Promise<TwinMergeResult> {
  const { sourceId, survivor, twin } = input;
  const conflicts = await twinMergeConflicts(tx, survivor.page_id, twin.page_id);
  if (conflicts.length) {
    throw opError('revision_conflict', 'The duplicate page holds evidence its survivor does not, so the merge was refused.',
      `Merging ${twin.slug} into ${survivor.slug} in source ${sourceId} would discard ${conflicts.map(c => `${c.detail} (${c.table === 'raw_data' ? `raw_data of page ${c.id}` : `${c.table} ${c.id}`})`).join('; ')}. Nothing changed; the group needs a person (gbrain repair origin-twins --source ${sourceId}).`,
      { reason: 'twin_evidence_conflicts' });
  }
  await tx.createVersion(twin.slug, { sourceId });
  await tx.detachPageOrigin(twin.page_id, ORIGIN_TWIN_REASON);
  const ids = { twinId: twin.page_id, survivorId: survivor.page_id };
  const relationships = await tx.moveTwinRelationships(ids);
  const tagsMoved = await tx.moveTwinPageChildren({ ...ids, sourceId, twinSlug: twin.slug, survivorSlug: survivor.slug });
  await dropRekeyDuplicates(tx, sourceId, { where: 'f.entity_slug = $2 AND f.source_markdown_slug IS DISTINCT FROM $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: [twin.slug, survivor.slug] });
  const factIds = await tx.moveTwinFacts(sourceId, twin.slug, survivor.slug);
  await recordRenameAlias(tx, sourceId, twin.slug, survivor.slug);
  await refreshRelationships(tx, [...relationships.before, ...relationships.after]);
  noteBelief({ kind: 'transferred', fromSlug: twin.slug, table: 'links', ids: relationships.linksMoved });
  noteBelief({ kind: 'transferred', fromSlug: twin.slug, table: 'facts', ids: factIds });
  await tx.softDeletePage(twin.slug, { sourceId });
  // The twin's import record goes with the twin: the checkpoint member deletes the row when given no keys, on this tx.
  await tx.writeOpCheckpointRecord(SYNC_IMPORT_PROVENANCE_OP, `${sourceId}:${input.incarnation}:${twin.page_id}`, null);
  return { links_moved: relationships.linksMoved, facts_moved: factIds, transitions_moved: relationships.transitionsMoved, tags_moved: tagsMoved,
    deduplicated: relationships.deduplicated };
}
