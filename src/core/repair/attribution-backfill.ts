/**
 * `gbrain repair attribution-backfill` (Foundations 1, F1b): fill write
 * attribution that the journal proves exactly, for rows written before the
 * attribution columns existed. No inference: a row is filled only when
 * exactly one committed request proves it wrote that row, and only while its
 * attribution is still NULL. Everything else stays NULL and reads as
 * `unrecorded`.
 *
 * - pages.revision_* and page_versions.write_*: the committed page mutation
 *   (or fenced `remember`) whose `outcome.revision` is the row's
 *   `knowledge_revision`. Requests that only observed a revision (skipped,
 *   duplicate or unfenced writes) prove nothing and are ignored.
 * - facts.write_*: the committed `remember` whose `outcome.id` names the fact
 *   with status `inserted` or `superseded`.
 *
 * Items are batches of up to 1,000 rows in (table, id) order; each batch
 * commits on its own under the page key locks of the pages it touches, so it
 * serializes with publication, and the shared repair cursor resumes after
 * the last committed batch. An attribution-only update changes no content
 * column, so it needs no coordinator and bumps no revision.
 */
import type { BrainEngine } from '../engine.ts';
import { validateSlug } from '../utils.ts';
import type { RepairHandler, RepairItem, RepairScope } from './core.ts';

const BATCH = 1000;

const FACT_ID = "CASE WHEN r.outcome->>'id' ~ '^[0-9]{1,18}$' THEN (r.outcome->>'id')::bigint END";

/** A committed request that changed the page to the revision it reports. */
const MUTATED_PAGE = `(r.operation IN ('put_page','capture','edit_page','delete_page','restore_page','rename_page','revert_version')
    AND r.outcome->>'status' IN ('created_or_updated','restored','renamed','reverted','soft_deleted')
    AND COALESCE(r.outcome->>'noop', 'false') <> 'true'
  OR r.operation = 'remember' AND r.outcome->>'status' IN ('inserted','superseded') AND EXISTS (
    SELECT 1 FROM facts f WHERE f.id = ${FACT_ID} AND f.source_id = r.source_id
       AND f.row_num IS NOT NULL AND f.source_markdown_slug = r.slug))`;

interface Phase { table: 'pages' | 'page_versions' | 'facts'; columns: [string, string, string]; proof: string; unfilled: string }

const PHASES: Phase[] = [
  {
    table: 'pages', columns: ['revision_write_request_id', 'revision_principal_kind', 'revision_principal_id'],
    proof: `SELECT t.id AS target_id, t.source_id, t.slug, r.id::text AS request_id, r.principal_kind, r.principal_id
      FROM pages t JOIN persistence_requests r ON r.state = 'committed' AND r.source_id = t.source_id
       AND r.outcome->>'revision' = t.knowledge_revision::text
     WHERE t.source_id = ANY($1::text[]) AND t.revision_write_request_id IS NULL AND t.revision_principal_kind IS NULL AND ${MUTATED_PAGE}`,
    unfilled: `SELECT count(*)::int AS n FROM pages t
     WHERE t.source_id = ANY($1::text[]) AND t.revision_write_request_id IS NULL AND t.revision_principal_kind IS NULL`,
  },
  {
    table: 'page_versions', columns: ['write_request_id', 'write_principal_kind', 'write_principal_id'],
    proof: `SELECT t.id AS target_id, p.source_id, p.slug, r.id::text AS request_id, r.principal_kind, r.principal_id
      FROM page_versions t JOIN pages p ON p.id = t.page_id
      JOIN persistence_requests r ON r.state = 'committed' AND r.source_id = p.source_id
       AND r.outcome->>'revision' = t.knowledge_revision::text
     WHERE p.source_id = ANY($1::text[]) AND t.write_request_id IS NULL AND t.write_principal_kind IS NULL AND ${MUTATED_PAGE}`,
    unfilled: `SELECT count(*)::int AS n FROM page_versions t JOIN pages p ON p.id = t.page_id
     WHERE p.source_id = ANY($1::text[]) AND t.write_request_id IS NULL AND t.write_principal_kind IS NULL`,
  },
  {
    table: 'facts', columns: ['write_request_id', 'write_principal_kind', 'write_principal_id'],
    proof: `SELECT t.id AS target_id, r.source_id, r.slug, r.id::text AS request_id, r.principal_kind, r.principal_id
      FROM persistence_requests r JOIN facts t ON t.id = ${FACT_ID} AND t.source_id = r.source_id
     WHERE r.state = 'committed' AND r.operation = 'remember' AND r.outcome->>'status' IN ('inserted','superseded')
       AND t.source_id = ANY($1::text[]) AND t.write_request_id IS NULL AND t.write_principal_kind IS NULL`,
    unfilled: `SELECT count(*)::int AS n FROM facts t
     WHERE t.source_id = ANY($1::text[]) AND t.write_request_id IS NULL AND t.write_principal_kind IS NULL`,
  },
];

/** Rows exactly one committed request proves, optionally within an id range. */
function provenSql(phase: Phase, ranged: boolean): string {
  return `SELECT target_id, (array_agg(source_id))[1] AS source_id, (array_agg(slug))[1] AS slug,
      (array_agg(request_id))[1] AS request_id, (array_agg(principal_kind))[1] AS principal_kind,
      (array_agg(principal_id))[1] AS principal_id
    FROM (${phase.proof}${ranged ? ' AND t.id BETWEEN $2 AND $3' : ''}) proof
   GROUP BY target_id HAVING count(*) = 1`;
}

interface BatchRange { phase: number; first: number; last: number; source_ids: string[] }

async function fillBatch(engine: BrainEngine, range: BatchRange): Promise<number> {
  const phase = PHASES[range.phase];
  const params = [range.source_ids, range.first, range.last];
  return engine.transaction(async tx => {
    const rows = await tx.executeRaw<{ source_id: string; slug: string }>(provenSql(phase, true), params);
    if (!rows.length) return 0;
    const keys = rows.flatMap(row => { try { validateSlug(row.slug); return [{ sourceId: row.source_id, slug: row.slug }]; } catch { return []; } });
    await tx.lockPageKeys(keys);
    const [requestCol, kindCol, idCol] = phase.columns;
    const updated = await tx.executeRaw<{ id: number }>(
      `UPDATE ${phase.table} t SET ${requestCol} = c.request_id::uuid, ${kindCol} = c.principal_kind, ${idCol} = c.principal_id
         FROM (${provenSql(phase, true)}) c
        WHERE t.id = c.target_id AND t.${requestCol} IS NULL AND t.${kindCol} IS NULL
       RETURNING t.id`, params);
    return updated.length;
  });
}

export const attributionBackfillRepair: RepairHandler = {
  kind: 'attribution-backfill',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope: RepairScope, after) {
    const items: RepairItem[] = [];
    const residuals: Record<string, number> = {};
    for (const [index, phase] of PHASES.entries()) {
      const ids = (await engine.executeRaw<{ target_id: number | string }>(`${provenSql(phase, false)} ORDER BY target_id`, [scope.source_ids]))
        .map(row => Number(row.target_id));
      const [{ n: unfilled }] = await engine.executeRaw<{ n: number }>(phase.unfilled, [scope.source_ids]);
      if (Number(unfilled) > ids.length) residuals[`unrecorded_${phase.table}`] = Number(unfilled) - ids.length;
      const pending = ids.filter(id => !after || index > after.phase || (index === after.phase && id > after.id));
      for (let start = 0; start < pending.length; start += BATCH) {
        const batch = pending.slice(start, start + BATCH);
        const range: BatchRange = { phase: index, first: batch[0], last: batch[batch.length - 1], source_ids: scope.source_ids };
        items.push({ cursor: { phase: index, id: range.last }, source_id: scope.source_ids.length === 1 ? scope.source_ids[0] : '*',
          slug: `${phase.table}#${range.first}-${range.last}`, chars: 0, action: `fill_${phase.table}_attribution`,
          change: { from: JSON.stringify(range), to: `${batch.length} row(s)` } });
      }
    }
    return { items, residuals };
  },
  async apply(ctx, item) {
    const filled = await fillBatch(ctx.engine, JSON.parse(item.change!.from!) as BatchRange);
    return filled > 0 ? { applied: true, outcome: 'filled', reason: `${filled} row(s)` } : { applied: false, outcome: 'already_filled' };
  },
};
