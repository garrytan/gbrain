/**
 * #6023: typed claims of one consolidation cluster that state the same metric,
 * unit and period for the same effective instant. Neither confidence nor row id
 * says which one corrects the other (or whether they are the same statement
 * twice), so the chronological writeback would pick a winner and close the
 * other at its own instant. Consolidation holds such a cluster unchanged; the
 * phase checks before submitting and the managed preparer checks an intent an
 * older release admitted.
 */
export interface ClaimInstant { id: number; at: number; metric: string | null; unit: string | null; period: string | null }

export interface SameInstantTie { ids: number[]; metric: string; unit: string | null; period: string | null; at: number }

/** Each group of two or more typed members sharing (metric, unit, period, instant), in first-member order; empty when there is none. */
export function sameInstantTies(members: readonly ClaimInstant[]): SameInstantTie[] {
  const groups = new Map<string, SameInstantTie>();
  for (const m of members) {
    if (m.metric === null) continue;
    const key = JSON.stringify([m.metric, m.unit, m.period, m.at]);
    const group = groups.get(key);
    if (group) group.ids.push(m.id);
    else groups.set(key, { ids: [m.id], metric: m.metric, unit: m.unit, period: m.period, at: m.at });
  }
  return [...groups.values()].filter(g => g.ids.length > 1);
}
