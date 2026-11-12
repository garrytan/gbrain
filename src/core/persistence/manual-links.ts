import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { opError } from '../ops/contract.ts';
import { wholeBodySnapshot } from './segmented-apply.ts';
import { pageIdentityError } from './page-identity.ts';
import { preparePageMutation } from './page-prepare.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { LINKS_FENCE_ORIGIN_FIELD, LinksFenceRewriteRefusal, MANAGED_LINK_SOURCES, linksFenceSection, readPageLinksFence, removeLinksFenceRows,
  renderLinksFence, replaceOrInsertLinksFence, upsertLinksFenceRow, type LinksFenceRow } from '../links-fence.ts';
import { linksFenceProjectionRows, projectLinksFence } from '../links-fence-projection.ts';
import { removeManualTransitions } from '../link-temporal-apply.ts';
import { refreshRelationships, type RelationshipKey } from '../link-relationships.ts';
import { executeRawJsonb } from '../sql-query.ts';
import { authorizePageVisibility, pageNotVisibleError } from './page-visibility.ts';

const optional = (value: unknown) => typeof value === 'string' && value ? value : undefined;

/** Edges from $1 to the page $3 of source $2, optionally of one type ($5) and provenance ($6). */
const RELATIONSHIP = `l.from_page_id=$1 AND l.to_page_id=t.id AND t.source_id=$2 AND t.slug=$3
  AND ($5::text IS NULL OR l.link_type=$5) AND ($6::text IS NULL OR l.link_source=$6)`;
/** A database-only edge: not projected from a links fence, and of a provenance no reconciliation producer owns ($4). */
const DATABASE_ONLY = `l.origin_field IS DISTINCT FROM '${LINKS_FENCE_ORIGIN_FIELD}' AND l.link_source <> ALL($4::text[])`;
const FENCED = `l.origin_field='${LINKS_FENCE_ORIGIN_FIELD}' AND l.origin_page_id=$1`;

type FencedEdge = { to_page_id: number; to: string; type: string; source: string; context: string | null };
type Statement = { to_page_id: number; type: string; source: string | null; kind: string; on: string };
const relationship = (row: { to_page_id: number; type: string }) => `${Number(row.to_page_id)}\u0000${row.type}`;

/** The edges page `pageId`'s links fence projected that are still stored, and the page's manual dated statements. */
async function storedFenceState(engine: BrainEngine, pageId: number): Promise<{ edges: FencedEdge[]; statements: Statement[] }> {
  const [edges, statements] = await Promise.all([
    engine.executeRaw<FencedEdge>(
      `SELECT l.to_page_id, t.slug AS to, l.link_type AS type, l.link_source AS source, l.context FROM links l JOIN pages t ON t.id=l.to_page_id
        WHERE l.from_page_id=$1 AND l.origin_page_id=$1 AND l.origin_field=$2 ORDER BY t.slug, l.link_type, l.link_source`, [pageId, LINKS_FENCE_ORIGIN_FIELD]),
    engine.executeRaw<Statement>(
      `SELECT to_page_id, link_type AS type, link_source AS source, kind, occurred_on::text AS on FROM link_transitions
        WHERE origin_page_id=$1 AND from_page_id=$1 AND producer='manual'`, [pageId]),
  ]);
  return { edges, statements };
}

/** A relationship whose dated statements predate per-row sources and cannot be given to its kept rows exactly. */
function linkDatesUnattributed(edge: FencedEdge, rows: number, operation: string, reason: 'several_rows' | 'dates_do_not_fit') {
  const link = `${edge.to} (${edge.type || 'untyped'})`;
  const why = reason === 'several_rows'
    ? `The link to ${link} has ${rows} rows on this page and dated statements stored before each row kept its own dates, so gbrain cannot tell which row each date belongs to.`
    : `The link to ${link} has dated statements stored before each row kept its own dates, and they do not fit its one row (more than one start or end, or an end before the start).`;
  const fix = `Add the page's ## Links section with edit_page, one row per source of ${edge.to} with that row's own valid_from and valid_until, then submit ${operation} again.`;
  return opError('link_dates_unattributed', `${why} Nothing was changed. ${fix}`, fix, { reason });
}

/**
 * The edges a links fence of page `pageId` projected that are still stored, as fence rows carrying their own dates. A
 * rewrite that drops the page's links section leaves exactly these (an absent fence retires nothing); a link the user
 * withdrew (remove_link, an empty section, a row deleted from the section) has no edge any more and is not among them.
 * Each row gets the statements stored with its source. Statements stored before rows had sources (link_source NULL)
 * belong to the row when it is the relationship's only row and they fit it; otherwise the write refuses
 * `link_dates_unattributed` instead of guessing. Statements of a source with no kept row belonged to a removed row and
 * are not rendered.
 */
async function keptLinksFenceRows(engine: BrainEngine, pageId: number): Promise<LinksFenceRow[]> {
  const { edges, statements } = await storedFenceState(engine, pageId);
  return edges.map(edge => {
    const siblings = edges.filter(other => relationship(other) === relationship(edge)).length;
    const related = statements.filter(statement => relationship(statement) === relationship(edge));
    if (siblings > 1 && related.some(statement => statement.source === null)) throw linkDatesUnattributed(edge, siblings, 'add_link', 'several_rows');
    const own = related.filter(statement => statement.source === edge.source || statement.source === null);
    const starts = own.filter(statement => statement.kind === 'start'), ends = own.filter(statement => statement.kind === 'end');
    if (starts.length > 1 || ends.length > 1 || (starts[0] && ends[0] && ends[0].on < starts[0].on)) throw linkDatesUnattributed(edge, 1, 'add_link', 'dates_do_not_fit');
    return { to: edge.to, type: edge.type, source: edge.source, context: edge.context ?? '',
      ...(starts[0] ? { validFrom: starts[0].on } : {}), ...(ends[0] ? { validUntil: ends[0].on } : {}) };
  });
}

/**
 * remove_link on a page whose links section is gone removes rows by (to, type, source). When the relationship keeps
 * other rows and has statements stored before rows had sources, those statements cannot be split between the removed
 * row and the kept ones, so the removal refuses `link_dates_unattributed`.
 */
async function assertRemovalAttributable(engine: BrainEngine, pageId: number, removal: { to: string; linkType?: string; linkSource?: string }) {
  const { edges, statements } = await storedFenceState(engine, pageId);
  const removed = (edge: FencedEdge) => edge.to === removal.to && (!removal.linkType || edge.type === removal.linkType) && (!removal.linkSource || edge.source === removal.linkSource);
  for (const edge of edges.filter(removed)) {
    const siblings = edges.filter(other => relationship(other) === relationship(edge));
    if (siblings.some(other => !removed(other)) && statements.some(statement => statement.source === null && relationship(statement) === relationship(edge))) {
      throw linkDatesUnattributed(edge, siblings.length, 'remove_link', 'several_rows');
    }
  }
}

/**
 * `add_link` / `remove_link` on a managed brain (G5): the authored edge lives in the from page's links fence
 * (links-fence.ts), written through the page-mutation door like add_timeline_entry. The preparer upserts or
 * removes the fence row at the snapshot's revision (a segmented page is read back whole) and publishes the page.
 * The publication projects the fence (canonical-projections.ts) and the apply projects it once more, so a fence
 * the write left unchanged (an idempotent add) still has its edges. `add_link` drops the database-only twin of
 * the edge it fences (same endpoints, type and provenance, no origin); on a page with no links fence, the section it
 * creates lists the edges a dropped section left first, each with its own dates (`keptLinksFenceRows`). Before any of
 * that is read, a remote writer is checked against every target those edges name: one it cannot read, or a deleted
 * one, refuses with the same slug-free page_not_found as for a missing page. `remove_link`
 * deletes the removed rows' own dated statements, whatever their source, and also the matching database-only edges
 * written before the fence existed, with their manual dated statements, so a removal only moves the database toward
 * git; edges a reconciliation producer derives from the page text stay, and the result names them
 * (`derived_from_text`, with `derived_message` saying to edit the page text instead).
 */
export async function prepareManualLinkMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const stored = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!stored || stored.page.id !== row.page_id) throw pageIdentityError(stored != null, 'The accepted page was replaced by another page.');
  const p = row.intent!;
  const snapshot = (await wholeBodySnapshot(engine, stored, row.operation))!;
  const section = linksFenceSection(snapshot.page);
  const to = String(p.to).toLowerCase();
  // GST-1158 OV3: a proposed link publishes only while its target exists and the person it was proposed for may read it,
  // so a page deleted or turned private after the owner's yes never lands in a shared Links fence.
  if (row.operation === 'add_link' && row.authority?.attestedOp === 'memory_propose'
    && !await (await import('./memory-proposals.ts')).linkTargetReadable(engine, row.authority, row.source_id, to)) {
    throw opError('page_not_found', `The link target ${to} was removed or is no longer readable by the person this link was proposed for.`,
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} changed nothing; a new proposal is needed if the link is still wanted.`);
  }
  // A proposed link carries the revision the owner approved against; a page that moved since then is a conflict, never a silent upsert.
  if (row.authority?.attestedOp === 'memory_propose' && typeof p.expected_revision === 'string' && stored.revision !== p.expected_revision) {
    throw opError('revision_conflict', `${row.slug} changed after the proposal was approved, so the proposed link was not written.`,
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} changed nothing; a new proposal is needed if the link is still wanted.`);
  }
  const linkType = optional(p.link_type), linkSource = optional(p.link_source);
  const validFrom = optional(p.valid_from), validUntil = optional(p.valid_until);
  const pageId = Number(stored.page.id);
  const absent = readPageLinksFence(snapshot.page).state === 'absent';
  if (row.operation === 'add_link' && absent && row.authority.remote) {
    const targets = await engine.executeRaw<{ slug: string; deleted: boolean }>(`SELECT DISTINCT t.slug, t.deleted_at IS NOT NULL AS deleted
      FROM links l JOIN pages t ON t.id=l.to_page_id WHERE l.from_page_id=$1 AND l.origin_page_id=$1 AND l.origin_field=$2`, [pageId, LINKS_FENCE_ORIGIN_FIELD]);
    for (const target of targets) {
      if (target.deleted) throw pageNotVisibleError();
      await authorizePageVisibility(engine, row.authority, target.slug);
    }
  }
  const kept = row.operation === 'add_link' && absent ? await keptLinksFenceRows(engine, pageId) : [];
  if (row.operation === 'remove_link' && absent) await assertRemovalAttributable(engine, pageId, { to, linkType, linkSource });
  const current = kept.length ? replaceOrInsertLinksFence(snapshot.page[section] ?? '', renderLinksFence(kept)) : snapshot.page[section] ?? '';
  let body: string;
  try {
    body = row.operation === 'add_link'
      ? upsertLinksFenceRow(current, { to, type: linkType ?? '', source: linkSource ?? 'manual', context: String(p.context ?? ''),
        ...(validFrom ? { validFrom } : {}), ...(validUntil ? { validUntil } : {}) }).body
      : removeLinksFenceRows(snapshot.page[section] ?? '', { to, type: linkType, source: linkSource }).body;
  } catch (error) {
    if (!(error instanceof LinksFenceRewriteRefusal)) throw error;
    throw opError('invalid_params', error.message,
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} changed nothing. Fix the page's ## Links table with edit_page (one row per to, type and source; dates YYYY-MM-DD), then submit ${row.operation} again.`);
  }
  const page = { ...snapshot.page, [section]: body };
  const fence = await linksFenceProjectionRows(engine, row.source_id, page);
  const prepared = await preparePageMutation(engine, row, config, {
    expectedRevision: snapshot.revision, content: serializePageToMarkdown(page, snapshot.tags),
  }, undefined, { boundedChunkWrites: true });
  const origin = { id: stored.page.id, source_id: row.source_id };
  if (row.operation === 'add_link') {
    return { ...prepared, apply: async tx => {
      const outcome = await prepared.apply(tx);
      await tx.executeRaw(`DELETE FROM links l USING pages t WHERE ${RELATIONSHIP} AND ${DATABASE_ONLY} AND l.origin_page_id IS NULL`,
        [pageId, row.source_id, to, MANAGED_LINK_SOURCES, linkType ?? '', linkSource ?? 'manual']);
      if (fence) await projectLinksFence(tx, origin, fence);
      return { ...outcome, status: 'ok' };
    } };
  }
  const params = [pageId, row.source_id, to, MANAGED_LINK_SOURCES, linkType ?? null, linkSource ?? null];
  return { ...prepared, apply: async tx => {
    const count = async () => Number((await tx.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM links l, pages t WHERE ${RELATIONSHIP} AND ((${DATABASE_ONLY}) OR (${FENCED}))`, params))[0]?.n ?? 0);
    const before = await count();
    // A page whose body dropped its whole fence keeps the fence's edges (an absent fence retires nothing), so
    // removing the relationship removes those orphans too: no row in git backs them.
    const dropped = await tx.executeRaw<{ to_page_id: number; link_type: string; link_source: string; fenced: boolean }>(`DELETE FROM links l USING pages t
      WHERE ${RELATIONSHIP} AND ((${DATABASE_ONLY}) OR ($7::boolean AND ${FENCED}))
      RETURNING l.to_page_id, l.link_type, l.link_source, l.origin_field IS NOT DISTINCT FROM '${LINKS_FENCE_ORIGIN_FIELD}' AS fenced`, [...params, fence === null]);
    if (dropped.some(edge => !edge.fenced) && (!linkSource || linkSource === 'manual')) {
      await removeManualTransitions(tx, { from: row.slug, to, linkType, sourceId: row.source_id, databaseOnly: true });
    }
    const removedRows = dropped.filter(edge => edge.fenced);
    // A dropped fence's removed rows take their own statements; statements stored before rows had sources go only
    // when no row of their relationship is left (assertRemovalAttributable refused the ambiguous case).
    const keys = removedRows.length ? await executeRawJsonb<RelationshipKey>(tx, `DELETE FROM link_transitions lt
        USING jsonb_to_recordset(($3::jsonb)->'rows') AS v(to_page_id integer, link_type text, link_source text)
      WHERE lt.from_page_id=$1 AND lt.origin_page_id=$1 AND lt.producer='manual' AND lt.to_page_id=v.to_page_id AND lt.link_type=v.link_type
        AND (lt.link_source=v.link_source OR (lt.link_source IS NULL AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id=$1
          AND l.origin_page_id=$1 AND l.origin_field=$2 AND l.to_page_id=v.to_page_id AND l.link_type=v.link_type)))
      RETURNING lt.from_page_id, lt.to_page_id, lt.link_type`, [pageId, LINKS_FENCE_ORIGIN_FIELD],
      [{ rows: removedRows.map(({ to_page_id, link_type, link_source }) => ({ to_page_id, link_type, link_source })) }]) : [];
    if (keys.length) await refreshRelationships(tx, keys);
    const outcome = await prepared.apply(tx);
    if (fence) await projectLinksFence(tx, origin, fence);
    const derived = await tx.executeRaw<{ link_type: string; link_source: string }>(`SELECT DISTINCT l.link_type, l.link_source FROM links l, pages t
      WHERE ${RELATIONSHIP} AND l.link_source = ANY($4::text[]) ORDER BY l.link_type, l.link_source`, params);
    return { ...outcome, status: 'ok', removed: before - await count(), ...(derived.length ? { derived_from_text: derived,
      derived_message: `${derived.length === 1 ? 'An edge' : `${derived.length} edges`} from ${row.slug} to ${to} ${derived.length === 1 ? 'comes' : 'come'} from the page text (links, wikilinks or frontmatter), so remove_link kept ${derived.length === 1 ? 'it' : 'them'}. Edit the text of ${row.slug} (edit_page) to remove ${derived.length === 1 ? 'it' : 'them'}.` } : {}) };
  } };
}
