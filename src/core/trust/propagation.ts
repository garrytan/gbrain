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
 * `needs_rederive` (reason `input_lowered`) instead. Each hop is one typed
 * member per table (lowerDerivedDependents, engine-sql/derivation-trust.ts),
 * so the propagation runs on every engine.
 */
import type { BrainEngine } from '../engine.ts';
import { derivedRowsFrom, type DerivationRef } from '../facts/derivation-inputs.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { appendRetierEvents, retierInputCauses } from '../belief/retier.ts';
import { compareTrust, storedTrustTier, type TrustTier } from './tier.ts';

const TIERED = ['facts', 'takes', 'pages', 'timeline_entries'] as const;
type Tiered = typeof TIERED[number];
export interface LoweredRow { table: Tiered; id: number; from: TrustTier; to: TrustTier }

/** Of `before` (fact ids and their tiers before a write), the facts the write lowered, propagated. */
export async function propagateFactLowering(tx: BrainEngine, before: ReadonlyArray<{ id: number; tier: TrustTier }>): Promise<LoweredRow[]> {
  const prior = new Map(before.map(f => [f.id, f.tier]));
  const now = await tx.readRowTrustRows({ table: 'facts', ids: [...prior.keys()] });
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
  for (const depth of [...new Set(rows.map(r => r.depth))].sort((a, b) => a - b)) {
    for (const table of TIERED) {
      const ids = rows.filter(r => r.depth === depth && r.table === table).map(r => r.id);
      if (!ids.length) continue;
      const written = await tx.lowerDerivedDependents(table, ids, managed);
      lowered.push(...written.map(c => ({ table, id: Number(c.id), from: storedTrustTier(c.from_tier), to: storedTrustTier(c.to_tier) })));
    }
  }
  const { queueTierProjection } = await import('./page-write.ts');
  for (const row of lowered) if (row.table !== 'timeline_entries') await queueTierProjection(tx, row.table, row.id);
  // W1 #6783 §6.3: each lowered dependent gets its own trust.retiered, citing the inputs' events as its cause.
  if (lowered.length) await appendRetierEvents(tx, lowered, { op: 'trust.propagation', inputs: await retierInputCauses(tx, inputs.map(i => ({ table: i.table, id: Number(i.id) }))) });
  return lowered;
}
