/**
 * BrainBench push precision/recall — pure over TurnRow[], micro-averaged.
 *
 * push_precision = Σ|injected ∩ (gold ∪ acceptable)| / Σ|injected|
 *   over turns with non-empty injection. Acceptable slugs count for precision
 *   (injecting them isn't noise) but not for recall (they're not required).
 *
 * push_recall = Σ|injected ∩ gold| / Σ|gold|
 *   over should_retrieve turns.
 *
 * Micro-averaging (sum-based, not per-turn means) per the plan's formulas —
 * a 3-slug turn weighs three times a 1-slug turn, which is what a token
 * budget actually experiences.
 */

import type { TurnRow } from '../types.ts';

export interface PushScore {
  gold_total: number;
  gold_failed: number;
  metrics: Record<string, number>;
  failed_items: string[];
}

export function scorePush(rows: TurnRow[]): PushScore {
  let injectedTotal = 0;
  let injectedRelevant = 0;
  let goldTotal = 0;
  let goldHit = 0;
  const failed: string[] = [];

  for (const row of rows) {
    if (!row.gold) continue;
    const gold = new Set(row.gold.gold_slugs ?? []);
    const acceptable = new Set([...gold, ...(row.gold.acceptable_slugs ?? [])]);

    if (row.injected_slugs.length > 0) {
      injectedTotal += row.injected_slugs.length;
      injectedRelevant += row.injected_slugs.filter((s) => acceptable.has(s)).length;
    }
    if (row.gold.should_retrieve && gold.size > 0) {
      goldTotal += gold.size;
      const injected = new Set(row.injected_slugs);
      for (const slug of gold) {
        if (injected.has(slug)) {
          goldHit++;
        } else {
          failed.push(`${row.fixture_id}#${row.turn_id} (gold slug not pushed: ${slug})`);
        }
      }
    }
  }

  return {
    gold_total: goldTotal,
    gold_failed: goldTotal - goldHit,
    metrics: {
      push_precision: injectedTotal > 0 ? injectedRelevant / injectedTotal : 1,
      push_recall: goldTotal > 0 ? goldHit / goldTotal : 1,
    },
    failed_items: failed,
  };
}
