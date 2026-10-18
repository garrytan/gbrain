/**
 * BrainBench `state-resolution` suite (#5575 I3): after a sequence of
 * updates, recall answers with the current fact, never a stale one, keeps the
 * history, and a lower-tier writer cannot replace or expire a higher-tier fact.
 *
 *   current_fact_accuracy            `current` items active and returned by recall. Gated = 1.
 *   stale_surfaced_as_current        `stale` items recall still returns as current. Gated = 0.
 *   history_preserved                `history` items whose row survives (expired or
 *                                    superseded, never deleted). Gated = 1.
 *   lower_tier_supersede_violations  `guarded` items a lower-tier write expired or
 *                                    superseded. Gated = 0.
 */

import type { TrustGoldItem } from '../types.ts';
import { resolveStepRow, type TrustFixtureRun } from '../trust-scenario.ts';
import { currentFactIds } from './trust-reads.ts';
import type { SuiteScore } from './trust.ts';

export interface StateSuiteCounts {
  current_total: number; current_ok: number;
  stale_total: number; stale_surfaced: number;
  history_total: number; history_ok: number;
  guard_total: number; guard_violations: number;
}

export function emptyStateCounts(): StateSuiteCounts {
  return { current_total: 0, current_ok: 0, stale_total: 0, stale_surfaced: 0, history_total: 0, history_ok: 0, guard_total: 0, guard_violations: 0 };
}

interface FactState { id: number; entity: string | null; expired: boolean; superseded: boolean }

async function factState(run: TrustFixtureRun, stepId: string, claim?: string): Promise<FactState | null> {
  const ref = await resolveStepRow(run, stepId, claim);
  if (ref?.table !== 'facts') return null;
  const [row] = await run.engine.executeRaw<{ entity_slug: string | null; expired_at: unknown; superseded_by: unknown }>(
    'SELECT entity_slug, expired_at, superseded_by FROM facts WHERE id = $1', [ref.id]);
  if (!row) return { id: ref.id, entity: null, expired: true, superseded: true };
  return { id: ref.id, entity: row.entity_slug, expired: row.expired_at != null, superseded: row.superseded_by != null };
}

export async function scoreStateFixture(run: TrustFixtureRun, items: TrustGoldItem[]): Promise<SuiteScore<StateSuiteCounts>> {
  const counts = emptyStateCounts();
  const failed: string[] = [];
  const recallCache = new Map<string, Set<number>>();
  const current = async (entity: string) => {
    if (!recallCache.has(entity)) recallCache.set(entity, await currentFactIds(run, entity));
    return recallCache.get(entity)!;
  };
  for (const item of items) {
    const label = `${run.fixtureId}/${item.item_id}`;
    const st = await factState(run, item.step, item.claim);
    if (item.check === 'current') {
      counts.current_total++;
      const ok = !!st && !st.expired && !st.superseded && !!st.entity && (await current(st.entity)).has(st.id);
      if (ok) counts.current_ok++;
      else failed.push(`${label}: expected current, got ${st ? JSON.stringify(st) : 'no fact row'}`);
    } else if (item.check === 'stale') {
      counts.stale_total++;
      if (st?.entity && (await current(st.entity)).has(st.id)) {
        counts.stale_surfaced++;
        failed.push(`${label}: stale fact ${st.id} returned as current`);
      } else if (!st) {
        // The stale row never existed: the fixture did not exercise the update.
        counts.stale_surfaced++;
        failed.push(`${label}: stale fact never written`);
      }
    } else if (item.check === 'history') {
      counts.history_total++;
      const [row] = st ? await run.engine.executeRaw('SELECT 1 FROM facts WHERE id = $1', [st.id]) : [];
      if (row && st && (st.expired || st.superseded)) counts.history_ok++;
      else failed.push(`${label}: history row ${st ? (row ? 'still active' : 'deleted') : 'never written'}`);
    } else if (item.check === 'guarded') {
      counts.guard_total++;
      if (!st || st.expired || st.superseded) {
        counts.guard_violations++;
        failed.push(`${label}: higher-tier fact ${st ? (st.superseded ? 'superseded' : 'expired') : 'missing'} by a lower-tier write`);
      }
    }
  }
  return { counts, gold_total: items.length, gold_failed: failed.length, failed_items: failed };
}

export function stateMetrics(c: StateSuiteCounts): Record<string, number> {
  return {
    current_fact_accuracy: c.current_total > 0 ? c.current_ok / c.current_total : 1,
    stale_surfaced_as_current: c.stale_surfaced,
    history_preserved: c.history_total > 0 ? c.history_ok / c.history_total : 1,
    lower_tier_supersede_violations: c.guard_violations,
  };
}
