/**
 * Derived-tier propagation (W1 #6783 §12 (b)). A derived row is stamped at
 * derivation time with the least trusted of its inputs, capped
 * (trust/taint.ts derivedWriteTrust). When an input is later lowered, each
 * row derived from it, transitively through `derivation_inputs`, is lowered to
 * the least trusted of its current inputs when that is below its own tier.
 * A raise never propagates: promoting a derivative needs its own
 * recomputation under the owner-promotion policy. Recorded tiers stay as they
 * were (page_versions snapshots, trust proposals); the lowered row's
 * `write_origin.input_lowered` names the tier it had.
 *
 * The walk has purge's bound (derivedRowsFrom: 1,000 rows, eight hops). On a
 * managed brain the lowering writes only rows of sources the enclosing
 * coordinated write holds; a dependent in another source is marked
 * `needs_rederive` (reason `input_lowered`) instead.
 */
import type { BrainEngine } from '../engine.ts';
import { derivedRowsFrom, type DerivationRef } from '../facts/derivation-inputs.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { appendRetierEvents, retierInputCauses } from '../belief/retier.ts';
import { compareTrust, storedTrustTier, trustRankSql, trustTierFromRankSql, type TrustTier } from './tier.ts';

const TIERED = ['facts', 'takes', 'pages', 'timeline_entries'] as const;
type Tiered = typeof TIERED[number];
export interface LoweredRow { table: Tiered; id: number; from: TrustTier; to: TrustTier }

const numericId = (column: string) => `(CASE WHEN ${column} ~ '^[0-9]+$' THEN ${column}::bigint END)`;
const sourceOf = (table: Tiered) => table === 'facts' || table === 'pages' ? 'x.source_id' : '(SELECT p.source_id FROM pages p WHERE p.id = x.page_id)';
const WRITABLE = (source: string) => `(NOT $3::boolean OR COALESCE(NULLIF(current_setting('gbrain.write_sources', true), ''), '[]')::jsonb ? ${source})`;
const INPUT_TIER = 'COALESCE(f.trust_tier, k.trust_tier, p.trust_tier, t.trust_tier)';

/** Each derived row of `table` among `ids` whose current inputs are less trusted than it: the tier it lowers to. */
async function lowerable(tx: BrainEngine, table: Tiered, ids: readonly string[], managed: boolean) {
  return tx.executeRaw<{ id: number; source_id: string | null; from_tier: string; to_tier: string; writable: boolean }>(`WITH low AS (
      SELECT di.derived_id, min(${trustRankSql(INPUT_TIER)}) AS r FROM derivation_inputs di
        LEFT JOIN facts f ON di.input_table = 'facts' AND f.id = ${numericId('di.input_id')}
        LEFT JOIN takes k ON di.input_table = 'takes' AND k.id = ${numericId('di.input_id')}
        LEFT JOIN pages p ON di.input_table = 'pages' AND p.id = ${numericId('di.input_id')}
        LEFT JOIN timeline_entries t ON di.input_table = 'timeline_entries' AND t.id = ${numericId('di.input_id')}
      WHERE di.derived_table = $1 AND di.derived_id = ANY($2::text[]) AND ${INPUT_TIER} IS NOT NULL
      GROUP BY di.derived_id)
    SELECT x.id, ${sourceOf(table)} AS source_id, x.trust_tier AS from_tier, ${trustTierFromRankSql('low.r')} AS to_tier, ${WRITABLE(sourceOf(table))} AS writable
      FROM low JOIN ${table} x ON x.id = ${numericId('low.derived_id')} WHERE low.r < ${trustRankSql('x.trust_tier')}
      ORDER BY x.id FOR UPDATE OF x`, [table, [...ids], managed]);
}

/** Of `before` (fact ids and their tiers before a write), the facts the write lowered, propagated. */
export async function propagateFactLowering(tx: BrainEngine, before: ReadonlyArray<{ id: number; tier: TrustTier }>): Promise<LoweredRow[]> {
  const prior = new Map(before.map(f => [f.id, f.tier]));
  const now = await tx.executeRaw<{ id: number; trust_tier: string }>('SELECT id, trust_tier FROM facts WHERE id = ANY($1::bigint[])', [[...prior.keys()]]);
  const lowered = now.filter(f => compareTrust(storedTrustTier(f.trust_tier), prior.get(Number(f.id)) ?? 'unknown') < 0);
  return propagateTierLowering(tx, lowered.map(f => ({ table: 'facts', id: Number(f.id) })));
}

/** Lowers every row derived from `inputs` (already lowered) that is now more trusted than its least trusted input. */
export async function propagateTierLowering(tx: BrainEngine, inputs: readonly DerivationRef[]): Promise<LoweredRow[]> {
  if (!inputs.length) return [];
  const { rows } = await derivedRowsFrom(tx, inputs);
  if (!rows.length) return [];
  const managed = await readManagedMode(tx, { refusal: { subject: 'Trust tier propagation' } });
  const lowered: LoweredRow[] = [];
  const deferred: Array<{ table: string; id: string; source_id: string | null }> = [];
  for (const depth of [...new Set(rows.map(r => r.depth))].sort((a, b) => a - b)) {
    for (const table of TIERED) {
      const ids = rows.filter(r => r.depth === depth && r.table === table).map(r => r.id);
      if (!ids.length) continue;
      const candidates = await lowerable(tx, table, ids, managed);
      const writable = candidates.filter(c => c.writable);
      deferred.push(...candidates.filter(c => !c.writable).map(c => ({ table, id: String(c.id), source_id: c.source_id })));
      if (!writable.length) continue;
      await tx.executeRaw(`UPDATE ${table} x SET trust_tier = c.to_tier,
          write_origin = COALESCE(x.write_origin, '{}'::jsonb) || jsonb_build_object('input_lowered', jsonb_build_object('from', c.from_tier, 'at', now()::text))
        FROM jsonb_to_recordset($1::text::jsonb) AS c(id bigint, from_tier text, to_tier text) WHERE x.id = c.id`,
      [JSON.stringify(writable.map(c => ({ id: Number(c.id), from_tier: c.from_tier, to_tier: c.to_tier })))]);
      lowered.push(...writable.map(c => ({ table, id: Number(c.id), from: storedTrustTier(c.from_tier), to: storedTrustTier(c.to_tier) })));
    }
  }
  if (deferred.length) {
    await tx.executeRaw(`INSERT INTO needs_rederive(derived_table, derived_id, source_id, reason)
      SELECT d.derived_table, d.derived_id, d.source_id, 'input_lowered' FROM jsonb_to_recordset($1::text::jsonb) AS d(derived_table text, derived_id text, source_id text)
      ON CONFLICT (derived_table, derived_id) DO UPDATE SET reason = EXCLUDED.reason, marked_at = now()`,
    [JSON.stringify(deferred.map(d => ({ derived_table: d.table, derived_id: d.id, source_id: d.source_id })))]);
  }
  const { queueTierProjection } = await import('./page-write.ts');
  for (const row of lowered) if (row.table !== 'timeline_entries') await queueTierProjection(tx, row.table, row.id);
  // W1 #6783 §6.3: each lowered dependent gets its own trust.retiered, citing the inputs' events as its cause.
  if (lowered.length) await appendRetierEvents(tx, lowered, { op: 'trust.propagation', inputs: await retierInputCauses(tx, inputs.map(i => ({ table: i.table, id: Number(i.id) }))) });
  return lowered;
}
