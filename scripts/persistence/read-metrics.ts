/** Measure the union of in-flight public mutations, including idle gaps. */
export function overlapPercent(start: number, end: number, intervals: [number, number][]): number {
  if (end <= start) return 0;
  const spans = intervals.map(([a, b]) => [Math.max(start, a), Math.min(end, b)] as const)
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let covered = 0; let cursor = start;
  for (const [a, b] of spans) { covered += Math.max(0, b - Math.max(cursor, a)); cursor = Math.max(cursor, b); }
  return Math.min(100, 100 * covered / (end - start));
}

/** Three independent runs are mandatory; invalid work cannot pass a latency gate. */
export function summarizeReadRuns(runs: Record<string, any>[], thresholdPct = 50) {
  const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  const valid = runs.length === 3 && runs.every(run => run.ok && run.overlap_pct >= 90 &&
    run.phase_b?.writes_completed > 0 && run.phase_b?.writes_committed_during_reads > 0 && run.phase_b?.writes_failed === 0 && run.phase_a?.queries_run > 0 &&
    run.phase_a.queries_run === run.phase_b.queries_run &&
    run.admission?.count === run.phase_b.writes_completed && run.commit?.count === run.phase_b.writes_completed &&
    ['phase_a', 'phase_b', 'admission', 'commit'].every(phase =>
      ['p50_ms', 'p95_ms', 'p99_ms'].every(key => Number.isFinite(run[phase][key]) && run[phase][key] > 0)));
  const phase = (name: string) => Object.fromEntries(['p50_ms', 'p95_ms', 'p99_ms'].map(key =>
    [key, median(runs.map(run => run[name]?.[key] ?? NaN))]));
  const a = phase('phase_a'); const b = phase('phase_b'); const delta = 100 * (b.p99_ms / a.p99_ms - 1);
  return { ok: valid, phase_a: a, phase_b: { ...b, writes_completed: runs.reduce((sum, run) => sum + (run.phase_b?.writes_completed ?? 0), 0) },
    overlap_pct: Math.min(...runs.map(run => run.overlap_pct)), delta_p99_pct: delta, threshold_pct: thresholdPct,
    verdict: valid && Number.isFinite(delta) && delta <= thresholdPct ? 'pass' : 'fail',
    comparison: 'median of three loaded p99 values versus median of three idle p99 values on the same runner', runs };
}
