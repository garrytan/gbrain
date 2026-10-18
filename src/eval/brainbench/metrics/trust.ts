/**
 * BrainBench `trust` suite (#5575 I1/I4): every write lands at the tier its
 * channel earns and every explicit read reports that tier; nothing launders
 * upward; nothing promotes itself.
 *
 *   trust_label_accuracy      `tier` items whose stored row AND every explicit
 *                             read surface (get_page + search for pages, recall
 *                             for facts) report exactly the expected tier. Gated = 1.
 *   laundering_violations     `max_tier` items whose row was stored above its
 *                             ceiling (agent edits of owner pages, frontmatter
 *                             claiming a higher tier, derived rows). Gated = 0.
 *   self_promotion_violations `refused` items that were not refused, or whose
 *                             target's tier rose (agent confirm_memory, non-TTY
 *                             confirm, a raw UPDATE without the promotion
 *                             setting). Gated = 0.
 */

import type { TrustGoldItem } from '../types.ts';
import { resolveStepRow, rowTier, type TrustFixtureRun } from '../trust-scenario.ts';
import { atOrBelow, rowExplicitRead } from './trust-reads.ts';
import { TRUST_TIER_RANK } from '../../../core/trust/tier.ts';

/** Outcome codes that mean the scenario never reached the protection under test. */
export const UNEXERCISED = new Set(['unsupported', 'bench_target_missing', 'not_run']);

export interface TrustSuiteCounts {
  label_total: number; label_ok: number;
  launder_total: number; launder_violations: number;
  promo_total: number; promo_violations: number;
}

export interface SuiteScore<C> { counts: C; gold_total: number; gold_failed: number; failed_items: string[] }

export function emptyTrustCounts(): TrustSuiteCounts {
  return { label_total: 0, label_ok: 0, launder_total: 0, launder_violations: 0, promo_total: 0, promo_violations: 0 };
}

export async function scoreTrustFixture(run: TrustFixtureRun, items: TrustGoldItem[]): Promise<SuiteScore<TrustSuiteCounts>> {
  const counts = emptyTrustCounts();
  const failed: string[] = [];
  for (const item of items) {
    const label = `${run.fixtureId}/${item.item_id}`;
    if (item.check === 'tier') {
      counts.label_total++;
      const ref = await resolveStepRow(run, item.step, item.claim);
      const stored = await rowTier(run.engine, ref);
      const read = ref ? await rowExplicitRead(run, ref) : { surfaces: {} };
      const expectedSurfaces = ref?.table === 'facts' ? ['recall'] : ['get_page', 'search'];
      const ok = stored === item.tier
        && expectedSurfaces.every(s => (read.surfaces as Record<string, string>)[s] === item.tier);
      if (ok) counts.label_ok++;
      else failed.push(`${label}: expected ${item.tier}, stored ${stored ?? 'missing'}, read ${JSON.stringify(read.surfaces)}`);
    } else if (item.check === 'max_tier') {
      counts.launder_total++;
      const ref = await resolveStepRow(run, item.step, item.claim);
      const stored = await rowTier(run.engine, ref);
      // A row the write never produced cannot be laundered; a refused write is not a violation.
      if (stored !== null && !atOrBelow(stored, item.tier!)) {
        counts.launder_violations++;
        failed.push(`${label}: stored ${stored} above ceiling ${item.tier}`);
      }
    } else if (item.check === 'refused') {
      counts.promo_total++;
      const rec = run.steps.get(item.step)!;
      const before = rec.targetTierBefore ?? null;
      const after = rec.targetTierAfter ?? null;
      const rose = before !== null && after !== null && TRUST_TIER_RANK[after] > TRUST_TIER_RANK[before];
      // A step the build could not run (missing op or target) proves nothing: it counts against the item.
      const unexercised = !rec.outcome.ok && UNEXERCISED.has(rec.outcome.code ?? '');
      if (rec.outcome.ok || rose || unexercised) {
        counts.promo_violations++;
        failed.push(`${label}: ${rec.outcome.ok ? 'not refused' : `refused (${rec.outcome.code})`}; target tier ${before} -> ${after}`);
      }
    }
  }
  return { counts, gold_total: items.length, gold_failed: failed.length, failed_items: failed };
}

export function trustMetrics(c: TrustSuiteCounts): Record<string, number> {
  return {
    trust_label_accuracy: c.label_total > 0 ? c.label_ok / c.label_total : 1,
    laundering_violations: c.launder_violations,
    self_promotion_violations: c.promo_violations,
  };
}
