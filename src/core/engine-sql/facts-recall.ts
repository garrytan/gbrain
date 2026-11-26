/**
 * Group 5 facts statements, recall's candidate-pool reads (docs/research/rust-cli-contract-map.md, "Facts queries, purge and
 * unlinked-fact checks"). Each function runs the statement `search/fact-relevance.ts` and `facts/question-recall.ts` ran through
 * `executeRaw`, on the engine's own `executeRaw`; only its home moved. They read under the pool's read policy
 * (`poolWhere` in facts-trust.ts), so a row the caller cannot see never shapes what a caller sees.
 *
 * Six are byte-identical to the statement the caller sent (the placeholders were each used once, in order, so the renderer
 * numbers them as the caller did). `listNearestFacts` is not: the caller hand-numbered the query vector, the model and the
 * dimensions and used each twice; the renderer binds each once per use, so those three values are sent twice and the
 * placeholders after the pool's own are numbered in the order they appear. The same rows come back (test/facts-rest-sites-sql-pin.test.ts
 * pins the new text; test/engine-parity/facts-rest-sites.test.ts pins the rows).
 */
import { CONVERSATION_SLOT_SQL } from '../chronicle/ontology.ts';
import type { SlotRow } from '../facts/slots.ts';
import type { FactCandidate } from '../search/fact-relevance.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { FACT_POOL_COLUMNS, poolWhere, type EngineRawRead, type FactPoolScope } from './facts-trust.ts';

// The vetted builder below is named in scripts/check-engine-sql-dynamic.ts: it wraps one constant fragment.
function conversationSlotSql(): string { return CONVERSATION_SLOT_SQL; }

export type SlotFactRow = SlotRow & Omit<FactCandidate, 'entity'>;

/**
 * GBRA-574 B2: every active conversation slot row (dim_status active; ontology observations never shape a window) of the given
 * (source, entity, dimension) slots under exactly the pool's read policy; ordered by valid_from, id. A row whose stored valid_until
 * has passed still ends the value before it; withdrawn and superseded rows never do.
 */
export async function listSlotRows(raw: EngineRawRead, scope: FactPoolScope,
  slots: ReadonlyArray<{ source_id: string; entity_slug: string; dimension: string }>): Promise<SlotFactRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(FACT_POOL_COLUMNS)} FROM facts f
     WHERE ${poolWhere(scope, { includeExpired: true })} AND f.expired_at IS NULL AND f.superseded_by IS NULL AND f.dimension IS NOT NULL AND f.value_hash IS NOT NULL AND COALESCE(f.dim_status, 'active') = 'active' AND ${trustedSql(conversationSlotSql())}
       AND (f.source_id, f.entity_slug, f.dimension) IN (SELECT * FROM unnest(${slots.map(s => s.source_id)}::text[], ${slots.map(s => s.entity_slug)}::text[], ${slots.map(s => s.dimension)}::text[]))
     ORDER BY f.valid_from, f.id`);
  return raw<SlotFactRow>(text, params);
}
