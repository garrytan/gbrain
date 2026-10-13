/**
 * Per-request search stage timings for `_meta.retrieval.timings` and
 * `--explain`. One `SearchTimings` collector per `search` / `query` call,
 * threaded into every hybrid call that request makes (`HybridSearchOpts._timings`).
 *
 * Stages are critical-path blocked wall-clock spans: the collector holds one
 * current stage, and every moment of the request is attributed to whichever
 * stage is current (or to `other` when none is). A nested stage takes over the
 * clock and hands it back when it ends, so a fan-out hybrid call inside
 * `alias_fanout` books its lexical time once, under `lexical`. Retries and
 * discarded escalations run through the same collector and accumulate. Work
 * that runs alongside the critical path (the parallel lexical arms) is reported
 * per label in `overlapped_ms` and never added to a stage. `total_ms` is its
 * own monotonic span from the collector's start to the snapshot, so
 * `sum(stages_ms) + other_ms === total_ms` and `other_ms >= 0`.
 *
 * Timing never changes execution: `stage` awaits exactly the work it is given
 * and `overlap` returns the promise it observes.
 */

export type SearchStage =
  | 'setup' | 'lexical' | 'relational' | 'expansion' | 'embed' | 'vector'
  | 'fuse' | 'post_fusion' | 'rerank' | 'alias_fanout' | 'anchoring' | 'facts_arm' | 'response';

export interface SearchTimingsMeta {
  total_ms: number;
  stages_ms: Partial<Record<SearchStage, number>>;
  other_ms: number;
  overlapped_ms?: Record<string, number>;
}

export interface StageTimer {
  stage<T>(stage: SearchStage, work: () => Promise<T>): Promise<T>;
  overlap<T>(label: string, work: Promise<T>): Promise<T>;
}

/** The timer for calls nobody measures (bare hybrid callers, internal searches). */
export const UNTIMED: StageTimer = {
  stage: (_stage, work) => work(),
  overlap: (_label, work) => work,
};

export class SearchTimings implements StageTimer {
  private readonly startedAt: number;
  private current: SearchStage | null = null;
  private since: number;
  private readonly spent = new Map<SearchStage, number>();
  private readonly overlapped = new Map<string, number>();

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = this.since = now();
  }

  private switchTo(stage: SearchStage | null): SearchStage | null {
    const at = this.now();
    if (this.current) this.spent.set(this.current, (this.spent.get(this.current) ?? 0) + at - this.since);
    this.since = at;
    const previous = this.current;
    this.current = stage;
    return previous;
  }

  async stage<T>(stage: SearchStage, work: () => Promise<T>): Promise<T> {
    const previous = this.switchTo(stage);
    if (!this.spent.has(stage)) this.spent.set(stage, 0);
    try {
      return await work();
    } finally {
      this.switchTo(previous);
    }
  }

  overlap<T>(label: string, work: Promise<T>): Promise<T> {
    const started = this.now();
    const settle = () => { this.overlapped.set(label, (this.overlapped.get(label) ?? 0) + this.now() - started); };
    work.then(settle, settle);
    return work;
  }

  /** Integer milliseconds; stages and `other` are apportioned so they sum to `total_ms` exactly. */
  snapshot(): SearchTimingsMeta {
    const at = this.now();
    const spent = new Map(this.spent);
    if (this.current) spent.set(this.current, (spent.get(this.current) ?? 0) + at - this.since);
    const total = at - this.startedAt;
    const parts = [...spent.entries()];
    const other = Math.max(0, total - parts.reduce((sum, [, ms]) => sum + ms, 0));
    const ints = apportion([...parts.map(([, ms]) => ms), other], Math.round(total));
    const overlappedMs = Object.fromEntries([...this.overlapped].map(([label, ms]) => [label, Math.round(ms)]));
    return {
      total_ms: Math.round(total),
      stages_ms: Object.fromEntries(parts.map(([stage], i) => [stage, ints[i]])),
      other_ms: ints[ints.length - 1],
      ...(this.overlapped.size > 0 ? { overlapped_ms: overlappedMs } : {}),
    };
  }
}

/** Largest-remainder rounding: non-negative integers within 1 of each value, summing to `total`. */
function apportion(values: number[], total: number): number[] {
  const floors = values.map(v => Math.floor(v));
  let left = total - floors.reduce((sum, v) => sum + v, 0);
  const byRemainder = values.map((v, i) => [v - floors[i], i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of byRemainder) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

/** One `--explain` header line: `timings: 142ms total — lexical 12, embed 30, …, other 5 (overlapped: keyword_arm 10)`. */
export function formatTimingsSummary(timings: SearchTimingsMeta | undefined): string | null {
  if (!timings || typeof timings.total_ms !== 'number') return null;
  const stages = Object.entries(timings.stages_ms ?? {}).map(([stage, ms]) => `${stage} ${ms}`);
  const overlapped = Object.entries(timings.overlapped_ms ?? {}).map(([label, ms]) => `${label} ${ms}`);
  return `timings: ${timings.total_ms}ms total — ${[...stages, `other ${timings.other_ms}`].join(', ')}`
    + (overlapped.length > 0 ? ` (overlapped: ${overlapped.join(', ')})` : '');
}
