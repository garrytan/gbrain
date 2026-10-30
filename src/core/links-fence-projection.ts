/**
 * Projects a page's links fence (links-fence.ts) into `links` and
 * `link_transitions`, inside the caller's publication or maintenance
 * transaction. Only rows this page's fence owns are touched: edges with
 * origin_page_id = the page and origin_field = `links_fence`, and manual
 * transitions with origin_page_id = the page. Database-only manual edges
 * (origin_field NULL) and every derived producer are left alone. A row whose
 * target is not a live page in the source, or whose type the active schema
 * pack does not declare, yields no edge and stays in the file.
 */
import type { BrainEngine } from './engine.ts';
import { executeRawJsonb } from './sql-query.ts';
import { sanitizeForJsonb } from './batch-rows.ts';
import { refreshRelationships, type RelationshipKey } from './link-relationships.ts';
import { loadActivePackForLocalEngine } from './schema-pack/best-effort.ts';
import { LINKS_FENCE_ORIGIN_FIELD, readPageLinksFence, type LinksFenceRow } from './links-fence.ts';

type Tx = Pick<BrainEngine, 'executeRaw'>;

/**
 * The rows a page's fence projects, or null when the page has no readable fence (absent or malformed: nothing is
 * reconciled). Rows typed with a link type the active pack does not declare are dropped here.
 */
export async function linksFenceProjectionRows(engine: Pick<BrainEngine, 'getConfig'>, sourceId: string,
  page: { compiled_truth: string; timeline?: string | null }): Promise<LinksFenceRow[] | null> {
  const fence = readPageLinksFence(page);
  if (fence.state !== 'parsed') return null;
  if (!fence.rows.some(row => row.type)) return fence.rows;
  const pack = await loadActivePackForLocalEngine(engine, { sourceId });
  return pack ? fence.rows.filter(row => !row.type || pack.manifest.link_types.some(type => type.name === row.type)) : fence.rows;
}

export async function projectLinksFence(tx: Tx, page: { id: number | string; source_id?: string | null },
  rows: readonly LinksFenceRow[]): Promise<{ created: number; removed: number }> {
  const pageId = Number(page.id);
  const sourceId = page.source_id ?? 'default';
  const targets = rows.length ? await tx.executeRaw<{ id: number; slug: string }>(
    'SELECT id, slug FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL', [sourceId, [...new Set(rows.map(row => row.to))]]) : [];
  const ids = new Map(targets.map(target => [target.slug, Number(target.id)]));
  const desired = rows.flatMap(row => ids.has(row.to) ? [{ to_page_id: ids.get(row.to)!, link_type: row.type, link_source: row.source,
    context: sanitizeForJsonb(row.context), validFrom: row.validFrom, validUntil: row.validUntil }] : []);
  const [existing, existingTransitions] = await Promise.all([
    tx.executeRaw<{ id: number; to_page_id: number; link_type: string; link_source: string; context: string }>(
      'SELECT id, to_page_id, link_type, link_source, context FROM links WHERE origin_page_id=$1 AND from_page_id=$1 AND origin_field=$2',
      [pageId, LINKS_FENCE_ORIGIN_FIELD]),
    tx.executeRaw<{ id: number; to_page_id: number; link_type: string; kind: string; occurred_on: string }>(
      `SELECT id, to_page_id, link_type, kind, occurred_on::text AS occurred_on FROM link_transitions
        WHERE origin_page_id=$1 AND from_page_id=$1 AND producer='manual'`, [pageId]),
  ]);
  const edgeKey = (row: { to_page_id: number; link_type: string; link_source: string }) => `${Number(row.to_page_id)}\u0000${row.link_type}\u0000${row.link_source}`;
  const wanted = new Map(desired.map(row => [edgeKey(row), row]));
  const have = new Map(existing.map(row => [edgeKey(row), row]));
  const obsolete = existing.filter(row => !wanted.has(edgeKey(row)));
  const additions = desired.filter(row => !have.has(edgeKey(row)));
  const updates = desired.flatMap(row => {
    const prior = have.get(edgeKey(row));
    return prior && prior.context !== row.context ? [{ id: Number(prior.id), context: row.context }] : [];
  });
  const transitions = new Map(desired.flatMap(row => [
    ...(row.validFrom ? [{ to_page_id: row.to_page_id, link_type: row.link_type, kind: 'start', occurred_on: row.validFrom }] : []),
    ...(row.validUntil ? [{ to_page_id: row.to_page_id, link_type: row.link_type, kind: 'end', occurred_on: row.validUntil }] : []),
  ]).map(row => [`${row.to_page_id}\u0000${row.link_type}\u0000${row.kind}\u0000${row.occurred_on}`, row]));
  const transitionKey = (row: { to_page_id: number; link_type: string; kind: string; occurred_on: string }) =>
    `${Number(row.to_page_id)}\u0000${row.link_type}\u0000${row.kind}\u0000${row.occurred_on}`;
  const haveTransitions = new Set(existingTransitions.map(transitionKey));
  const staleTransitions = existingTransitions.filter(row => !transitions.has(transitionKey(row)));
  const newTransitions = [...transitions.entries()].filter(([key]) => !haveTransitions.has(key)).map(([, row]) => row);
  if (obsolete.length) await tx.executeRaw('DELETE FROM links WHERE id=ANY($1::bigint[])', [obsolete.map(row => Number(row.id))]);
  if (updates.length) await executeRawJsonb(tx, `UPDATE links l SET context=v.context
      FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(id bigint, context text) WHERE l.id=v.id`, [], [{ rows: updates }]);
  if (additions.length) await executeRawJsonb(tx, `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
      SELECT $1, v.to_page_id, v.link_type, v.context, v.link_source, $1, $2
        FROM jsonb_to_recordset(($3::jsonb)->'rows') AS v(to_page_id integer, link_type text, context text, link_source text)
      ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO UPDATE SET context=EXCLUDED.context, origin_field=EXCLUDED.origin_field`,
    [pageId, LINKS_FENCE_ORIGIN_FIELD], [{ rows: additions.map(({ to_page_id, link_type, context, link_source }) => ({ to_page_id, link_type, context, link_source })) }]);
  if (staleTransitions.length) await tx.executeRaw('DELETE FROM link_transitions WHERE id=ANY($1::bigint[])', [staleTransitions.map(row => Number(row.id))]);
  if (newTransitions.length) await executeRawJsonb(tx, `INSERT INTO link_transitions (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer, origin_page_id)
      SELECT $1, $2, v.to_page_id, v.link_type, v.kind, v.occurred_on::date, 'manual', $2
        FROM jsonb_to_recordset(($3::jsonb)->'rows') AS v(to_page_id integer, link_type text, kind text, occurred_on text)
      ON CONFLICT DO NOTHING`, [sourceId, pageId], [{ rows: newTransitions }]);
  const keys: RelationshipKey[] = [...obsolete, ...additions, ...staleTransitions, ...newTransitions]
    .map(row => ({ from_page_id: pageId, to_page_id: Number(row.to_page_id), link_type: row.link_type }));
  if (keys.length) await refreshRelationships(tx, keys);
  return { created: additions.length, removed: obsolete.length };
}
