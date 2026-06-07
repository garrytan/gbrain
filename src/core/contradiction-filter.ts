/**
 * Shared contradiction-finding load + slug filter.
 *
 * Both `find_contradictions` and `idea_lineage` need to (a) read the latest
 * cached suspected-contradiction run and flatten its per-query findings, and
 * (b) keep only the findings touching a given slug. Extracted here so the two
 * ops can't drift (the embed-skip.ts shared-helper precedent). No probe is
 * triggered — this only reads `eval_contradictions_runs.report_json`.
 */

import type { BrainEngine } from './engine.ts';

export interface ContradictionSide {
  slug: string;
  chunk_id: number | null;
  take_id: number | null;
}

export interface ContradictionFinding {
  kind: string;
  severity: 'low' | 'medium' | 'high';
  axis: string;
  confidence: number;
  a: ContradictionSide;
  b: ContradictionSide;
  resolution_kind: string;
  resolution_command: string;
}

export interface LatestContradictions {
  run_id: string;
  ran_at: string;
  findings: ContradictionFinding[];
}

/**
 * Read the latest cached contradiction run (last 30 days) and flatten its
 * per-query findings. Returns null when no run exists on disk — callers
 * surface their own "run the probe first" note.
 */
export async function loadLatestContradictionFindings(
  engine: BrainEngine,
): Promise<LatestContradictions | null> {
  const rows = await engine.loadContradictionsTrend(30);
  if (rows.length === 0) return null;
  const latest = rows[0];
  const report = latest.report_json as Record<string, unknown> | null;
  const perQuery =
    (report?.per_query as Array<{ contradictions: ContradictionFinding[] }> | undefined) ?? [];
  const findings = perQuery.flatMap((q) => q.contradictions);
  return { run_id: latest.run_id, ran_at: latest.ran_at, findings };
}

/**
 * Keep findings where either side's slug contains any of the given substrings
 * (case-insensitive). An empty needle list means "no slug filter" — return all.
 */
export function filterContradictionsBySlugs(
  findings: ContradictionFinding[],
  slugSubstrings: string[],
): ContradictionFinding[] {
  const needles = slugSubstrings.map((s) => s.toLowerCase()).filter((s) => s.length > 0);
  if (needles.length === 0) return findings;
  return findings.filter((f) => {
    const a = f.a.slug.toLowerCase();
    const b = f.b.slug.toLowerCase();
    return needles.some((n) => a.includes(n) || b.includes(n));
  });
}

/** Filter by an optional single severity, then by optional slug substrings. */
export function filterContradictions(
  findings: ContradictionFinding[],
  opts: { severity?: 'low' | 'medium' | 'high' | null; slugSubstrings?: string[] } = {},
): ContradictionFinding[] {
  const sev = opts.severity ?? null;
  const bySeverity = sev ? findings.filter((f) => f.severity === sev) : findings;
  return filterContradictionsBySlugs(bySeverity, opts.slugSubstrings ?? []);
}
