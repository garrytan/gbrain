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

const optional = (value: unknown) => typeof value === 'string' && value ? value : undefined;

/** Edges from $1 to the page $3 of source $2, optionally of one type ($5) and provenance ($6). */
const RELATIONSHIP = `l.from_page_id=$1 AND l.to_page_id=t.id AND t.source_id=$2 AND t.slug=$3
  AND ($5::text IS NULL OR l.link_type=$5) AND ($6::text IS NULL OR l.link_source=$6)`;
/** A database-only edge: not projected from a links fence, and of a provenance no reconciliation producer owns ($4). */
const DATABASE_ONLY = `l.origin_field IS DISTINCT FROM '${LINKS_FENCE_ORIGIN_FIELD}' AND l.link_source <> ALL($4::text[])`;
const FENCED = `l.origin_field='${LINKS_FENCE_ORIGIN_FIELD}' AND l.origin_page_id=$1`;

/**
 * The edges a links fence of page `pageId` projected that are still stored, as fence rows carrying their manual dates. A
 * rewrite that drops the page's links section leaves exactly these (an absent fence retires nothing); a link the user
 * withdrew (remove_link, an empty section, a row deleted from the section) has no edge any more and is not among them.
 * A manual dated statement belongs to the relationship (to, type), not to one fence row, so the rows that share a
 * relationship share its statements: each start is paired with an end on or after it, and the pairs go to those rows in
 * source order. Every statement is rendered back, so the new section projects the same dates, and no row ends before it
 * starts, which would refuse the write. A relationship with more pairs than kept rows (a row removed while the section
 * was gone leaves its statements) refuses `invalid_params` instead of choosing which statements to drop.
 */
async function keptLinksFenceRows(engine: BrainEngine, pageId: number): Promise<LinksFenceRow[]> {
  const [edges, statements] = await Promise.all([
    engine.executeRaw<{ to_page_id: number; to: string; type: string; source: string; context: string | null }>(
      `SELECT l.to_page_id, t.slug AS to, l.link_type AS type, l.link_source AS source, l.context FROM links l JOIN pages t ON t.id=l.to_page_id
        WHERE l.from_page_id=$1 AND l.origin_page_id=$1 AND l.origin_field=$2 ORDER BY t.slug, l.link_type, l.link_source`, [pageId, LINKS_FENCE_ORIGIN_FIELD]),
    engine.executeRaw<{ to_page_id: number; type: string; kind: string; on: string }>(
      `SELECT DISTINCT to_page_id, link_type AS type, kind, occurred_on::text AS on FROM link_transitions
        WHERE origin_page_id=$1 AND from_page_id=$1 AND producer='manual' ORDER BY 4`, [pageId]),
  ]);
  type Dates = { validFrom?: string; validUntil?: string };
  const key = (toPageId: number, type: string) => `${Number(toPageId)}\u0000${type}`;
  const dates = new Map<string, Dates[]>();
  for (const relationship of new Set(edges.map(edge => key(edge.to_page_id, edge.type)))) {
    const starts = statements.filter(s => key(s.to_page_id, s.type) === relationship && s.kind === 'start').map(s => s.on);
    const pairs: Dates[] = [];
    for (const end of statements.filter(s => key(s.to_page_id, s.type) === relationship && s.kind === 'end').map(s => s.on)) {
      const at = starts.findLastIndex(start => start <= end);
      pairs.push({ ...(at === -1 ? {} : { validFrom: starts.splice(at, 1)[0] }), validUntil: end });
    }
    const stated = [...pairs, ...starts.map((validFrom): Dates => ({ validFrom }))];
    const rows = edges.filter(edge => key(edge.to_page_id, edge.type) === relationship);
    if (stated.length > rows.length) {
      const fix = `Add the page's ## Links section with edit_page, one row per source of ${rows[0]!.to} with that row's own valid_from and valid_until, then submit add_link again.`;
      throw opError('invalid_params', `The link to ${rows[0]!.to} (${rows[0]!.type || 'untyped'}) has ${stated.length} dated statements but only ${rows.length} kept row${rows.length === 1 ? '' : 's'} on this page, so the links section was not re-created. ${fix}`, fix);
    }
    dates.set(relationship, stated.sort((a, b) => (a.validFrom ?? a.validUntil!).localeCompare(b.validFrom ?? b.validUntil!)));
  }
  return edges.map(edge => ({ to: edge.to, type: edge.type, source: edge.source, context: edge.context ?? '',
    ...(dates.get(key(edge.to_page_id, edge.type))!.shift() ?? {}) }));
}

/**
 * `add_link` / `remove_link` on a managed brain (G5): the authored edge lives in the from page's links fence
 * (links-fence.ts), written through the page-mutation door like add_timeline_entry. The preparer upserts or
 * removes the fence row at the snapshot's revision (a segmented page is read back whole) and publishes the page.
 * The publication projects the fence (canonical-projections.ts) and the apply projects it once more, so a fence
 * the write left unchanged (an idempotent add) still has its edges. `add_link` drops the database-only twin of
 * the edge it fences (same endpoints, type and provenance, no origin); on a page with no links fence, the section it
 * creates lists the edges a dropped section left first (`keptLinksFenceRows`). `remove_link` also deletes the matching
 * database-only edges written before the fence existed, with their manual dated statements, so a removal only
 * moves the database toward git; edges a reconciliation producer derives from the page text stay, and the result
 * names them (`derived_from_text`, with `derived_message` saying to edit the page text instead).
 */
export async function prepareManualLinkMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const stored = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!stored || stored.page.id !== row.page_id) throw pageIdentityError(stored != null, 'The accepted page was replaced by another page.');
  const p = row.intent!;
  const snapshot = (await wholeBodySnapshot(engine, stored, row.operation))!;
  const section = linksFenceSection(snapshot.page);
  const to = String(p.to).toLowerCase();
  const linkType = optional(p.link_type), linkSource = optional(p.link_source);
  const validFrom = optional(p.valid_from), validUntil = optional(p.valid_until);
  const kept = row.operation === 'add_link' && readPageLinksFence(snapshot.page).state === 'absent' ? await keptLinksFenceRows(engine, Number(stored.page.id)) : [];
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
  const pageId = Number(stored.page.id);
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
    const dropped = await tx.executeRaw(`DELETE FROM links l USING pages t WHERE ${RELATIONSHIP}
      AND ((${DATABASE_ONLY}) OR ($7::boolean AND ${FENCED})) RETURNING l.id`, [...params, fence === null]);
    if (dropped.length && (!linkSource || linkSource === 'manual')) await removeManualTransitions(tx, { from: row.slug, to, linkType, sourceId: row.source_id });
    const outcome = await prepared.apply(tx);
    if (fence) await projectLinksFence(tx, origin, fence);
    const derived = await tx.executeRaw<{ link_type: string; link_source: string }>(`SELECT DISTINCT l.link_type, l.link_source FROM links l, pages t
      WHERE ${RELATIONSHIP} AND l.link_source = ANY($4::text[]) ORDER BY l.link_type, l.link_source`, params);
    return { ...outcome, status: 'ok', removed: before - await count(), ...(derived.length ? { derived_from_text: derived,
      derived_message: `${derived.length === 1 ? 'An edge' : `${derived.length} edges`} from ${row.slug} to ${to} ${derived.length === 1 ? 'comes' : 'come'} from the page text (links, wikilinks or frontmatter), so remove_link kept ${derived.length === 1 ? 'it' : 'them'}. Edit the text of ${row.slug} (edit_page) to remove ${derived.length === 1 ? 'it' : 'them'}.` } : {}) };
  } };
}
