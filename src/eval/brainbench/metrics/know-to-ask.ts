/**
 * BrainBench know-to-ask scoring — pure over TurnRow[].
 *
 * know_to_ask_failure_rate (lower better): of turns where gold says the
 * memory layer SHOULD have surfaced something, the fraction where the
 * injection hit neither gold nor acceptable slugs. This grades the
 * deterministic injection decision — the mechanism gbrain ships at the seam
 * (decision 3); agent-LLM-in-the-loop replay is the pre-registered --live
 * extension.
 *
 * false_fire_rate (lower better, anti-gaming companion): of turns where gold
 * says STAY SILENT, the fraction where anything was injected. Without it,
 * "always inject" games the failure rate.
 */

import type { TurnRow } from '../types.ts';

export interface KnowToAskScore {
  gold_total: number;
  gold_failed: number;
  metrics: Record<string, number>;
  /** `${fixture_id}#${turn_id}` of each failed gold item (breach reporting). */
  failed_items: string[];
}

export function scoreKnowToAsk(rows: TurnRow[]): KnowToAskScore {
  let shouldRetrieve = 0;
  let missed = 0;
  let quiet = 0;
  let falseFires = 0;
  const failed: string[] = [];

  for (const row of rows) {
    if (!row.gold) continue;
    const key = `${row.fixture_id}#${row.turn_id}`;
    if (row.gold.should_retrieve) {
      shouldRetrieve++;
      const ok = new Set([...(row.gold.gold_slugs ?? []), ...(row.gold.acceptable_slugs ?? [])]);
      const hit = row.injected_slugs.some((s) => ok.has(s));
      if (!hit) {
        missed++;
        failed.push(`${key} (missed retrieve)`);
      }
    } else {
      quiet++;
      if (row.injected_slugs.length > 0) {
        falseFires++;
        failed.push(`${key} (false fire: ${row.injected_slugs.join(',')})`);
      }
    }
  }

  return {
    gold_total: shouldRetrieve + quiet,
    gold_failed: missed + falseFires,
    metrics: {
      know_to_ask_failure_rate: shouldRetrieve > 0 ? missed / shouldRetrieve : 0,
      false_fire_rate: quiet > 0 ? falseFires / quiet : 0,
    },
    failed_items: failed,
  };
}
