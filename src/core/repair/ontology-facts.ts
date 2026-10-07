/**
 * `gbrain repair ontology-facts` (#6264): give the ontology back the
 * observations the `extract_facts` fence step took from it.
 *
 * From v0.60.53.0 the fence step (`facts/unfenced-facts.ts`) fenced every
 * `row_num IS NULL` fact row onto its entity page, ontology observations
 * included: it gave the row a fence row number and rewrote its
 * `source_markdown_slug` (the observation's provenance, which
 * `mergeOntologyFact` writes equal to `source`) to the page slug. The next
 * write of that page that did not list the row retired it (expired, and
 * usually detached). The fix stopped new fencing; this kind restores the rows.
 *
 * Candidates: ontology rows (`dimension IS NOT NULL`) of the scoped sources
 * that carry the fence step's signature, a fence row number or a
 * `source_markdown_slug` that differs from `source`. Ontology writes never
 * produce either. Each is classified:
 *   - excluded (listed, never restored): its claim was withdrawn
 *     (`fact_withdrawals`, so `forget` won); it was consolidated into another
 *     row; or restoring its provenance would duplicate an existing
 *     observation (same entity, dimension, value, provenance and valid_from).
 *   - restorable: everything else, active (still fenced) or retired.
 * Rows retired after their fence row left the page, whose provenance already
 * equalled the page slug, carry no signature and are not found.
 *
 * The apply sets `row_num` NULL, `source_markdown_slug` back to `source` and
 * clears `expired_at`; validity dates and supersession links are kept. On a
 * managed brain each row commits as one coordinated database-only write on
 * the entity's and the page's keys (the `ontology_propose` path); on an
 * unmanaged brain as one maintenance transaction. Each row is rechecked in
 * the same statement and restored only when its row number, page and expiry
 * are unchanged since the preview (`changed_since_preview` otherwise). Page
 * text is never rewritten: a row still fenced keeps its line in the page's
 * `## Facts` table, which the next reconcile indexes as an ordinary page fact.
 *
 * Explicit-only and preview-bound: the preview lists every candidate with its
 * class, prints a hash and saves the restorable set; `--apply --expect <hash>`
 * restores exactly that set.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { coordinatedDatabaseWrite } from '../persistence/database-write.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

/** The expiry instant as UTC text with microseconds; a bound timestamp parameter can lose them. */
const EXPIRY_TEXT = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** An observation with the same dedup key as `f` once its provenance is restored (the ontology unique index). */
const DUPLICATE_SQL = (f: string) => `EXISTS (SELECT 1 FROM facts d WHERE d.source_id=${f}.source_id AND d.entity_slug=${f}.entity_slug
  AND d.dimension=${f}.dimension AND d.value_hash=${f}.value_hash AND d.source_markdown_slug=${f}.source
  AND d.valid_from=${f}.valid_from AND d.id<>${f}.id)`;

export interface OntologyFactCandidate {
  id: number;
  source_id: string;
  entity_slug: string;
  dimension: string;
  /** The observation's own provenance. */
  source: string;
  /** The page the fence step moved it to (its current `source_markdown_slug`). */
  page: string | null;
  row_num: number | null;
  /** UTC, microseconds; null while the row is still active. */
  expired_at: string | null;
  class: 'restorable' | 'excluded';
  reason: string;
}

interface CandidateRow {
  id: number | string; source_id: string; entity_slug: string; dimension: string; source: string; page: string | null;
  row_num: number | string | null; expired_at: string | null; withdrawn: boolean; consolidated: boolean; duplicate: boolean;
}

/** Every candidate of these sources, classified, in id order. Read-only; also the doctor check's count. */
export async function classifyOntologyFacts(db: BrainEngine, sourceIds: string[]): Promise<OntologyFactCandidate[]> {
  const rows = await db.executeRaw<CandidateRow>(`
    SELECT f.id, f.source_id, f.entity_slug, f.dimension, f.source, f.source_markdown_slug AS page, f.row_num,
           ${EXPIRY_TEXT('f.expired_at')} AS expired_at,
           EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
             AND (w.subject='*' OR w.subject=f.entity_slug)
             AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact))) AS withdrawn,
           f.consolidated_into IS NOT NULL AS consolidated,
           ${DUPLICATE_SQL('f')} AS duplicate
      FROM facts f
     WHERE f.source_id=ANY($1::text[]) AND f.dimension IS NOT NULL AND f.entity_slug IS NOT NULL AND f.source IS NOT NULL
       AND (f.row_num IS NOT NULL OR f.source_markdown_slug IS DISTINCT FROM f.source)
     ORDER BY f.id`, [sourceIds]);
  return rows.map(row => {
    const [klass, reason] = row.withdrawn ? ['excluded', 'withdrawn'] as const
      : row.consolidated ? ['excluded', 'consolidated'] as const
      : row.duplicate ? ['excluded', 'duplicate'] as const
      : ['restorable', row.expired_at ? 'retired' : 'fenced'] as const;
    return { id: Number(row.id), source_id: row.source_id, entity_slug: row.entity_slug, dimension: row.dimension, source: row.source,
      page: row.page, row_num: row.row_num == null ? null : Number(row.row_num), expired_at: row.expired_at, class: klass, reason };
  });
}

interface ApprovedFact extends OntologyFactCandidate { selection: string[] }
interface FactItem extends RepairItem { fact: OntologyFactCandidate; hash: string; last: boolean }

function previewCommand(scope: RepairScope): string {
  return `gbrain repair ontology-facts${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;
}

function item(fact: OntologyFactCandidate, hash: string, last: boolean): FactItem {
  return { cursor: { phase: 1, id: fact.id }, source_id: fact.source_id, slug: fact.entity_slug, chars: 0,
    action: `restore:${fact.reason}`, fact, hash, last };
}

function label(fact: OntologyFactCandidate): string {
  return fact.class === 'excluded' ? `excluded_${fact.reason}` : fact.reason;
}

function detail(fact: OntologyFactCandidate): string {
  const where = `${fact.page ?? 'no page'}${fact.row_num != null ? ` row #${fact.row_num}` : ''}`;
  const state = fact.class === 'excluded' ? `kept as is (${fact.reason})`
    : fact.expired_at ? `retired ${fact.expired_at}; restores to source ${fact.source}`
    : `still fenced; restores to source ${fact.source} (the page's Facts table keeps its line as page text)`;
  return `fact #${fact.id} ${fact.dimension} moved to ${where}: ${state}`;
}

export const ontologyFactsRepair: RepairHandler = {
  kind: 'ontology-facts',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope);
    if (!opts?.apply) {
      const facts = await classifyOntologyFacts(engine, scope.source_ids);
      const restorable = facts.filter(f => f.class === 'restorable');
      const sources = await engine.executeRaw<{ id: string; incarnation: string }>(
        'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
      const hash = previewHash({ kind: 'ontology-facts-v1', brain_id: scope.brain_id, sources, selection: { source_ids: scope.source_ids }, facts });
      if (restorable.length) await saveApprovedSet<ApprovedFact>(engine, { command: 'ontology-facts', hash }, restorable.map(f => ({ ...f, selection: scope.source_ids })));
      const residuals: Record<string, number> = {};
      for (const f of facts) residuals[label(f)] = (residuals[label(f)] ?? 0) + 1;
      return { items: restorable.map((f, index) => item(f, hash, index === restorable.length - 1)), preview_hash: hash, residuals,
        listing: facts.map(f => ({ item: `${f.source_id}:${f.entity_slug}#${f.dimension}`, class: label(f), detail: detail(f) })) };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair ontology-facts --apply restores only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        'docs/guides/repair.md#explicit-only-repair-kinds');
    }
    const approved = await loadApprovedSet<ApprovedFact>(engine, { command: 'ontology-facts', hash: opts.expect, previewCommand: command });
    if (approved.items.some(f => JSON.stringify(f.selection) !== JSON.stringify(scope.source_ids))) throw previewChangedError(opts.expect, command);
    const items = approved.items.map(({ selection: _selection, ...f }, index) => item(f, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { fact, hash, last } = entry as FactItem;
    const restore = (tx: BrainEngine) => tx.executeRaw<{ id: number | string; expired: boolean }>(
      `UPDATE facts f SET row_num=NULL, source_markdown_slug=f.source, expired_at=NULL
        WHERE f.id=$1 AND f.source_id=$2 AND f.dimension IS NOT NULL
          AND f.row_num IS NOT DISTINCT FROM $3::integer AND f.source_markdown_slug IS NOT DISTINCT FROM $4::text
          AND ${EXPIRY_TEXT('f.expired_at')} IS NOT DISTINCT FROM $5::text AND NOT ${DUPLICATE_SQL('f')}
        RETURNING f.id, f.expired_at IS NOT NULL AS expired`,
      [fact.id, fact.source_id, fact.row_num, fact.page, fact.expired_at]);
    const keys = [...new Set([fact.entity_slug, ...(fact.page ? [fact.page] : [])])];
    const managed = await coordinatedDatabaseWrite(ctx, 'ontology_propose', fact.entity_slug, keys, restore);
    const [row] = managed ? managed.value : await maintenanceTransaction(ctx.engine, restore);
    if (last) await clearApprovedSet(ctx.engine, { command: 'ontology-facts', hash });
    if (!row) return { applied: false, outcome: 'changed_since_preview', reason: 'the row moved, was edited or now duplicates another observation' };
    // The withdrawal trigger re-expires a claim forgotten after the preview.
    if (row.expired) return { applied: false, outcome: 'withdrawn', reason: 'the claim was withdrawn after the preview' };
    return { applied: true, outcome: 'restored' };
  },
};
