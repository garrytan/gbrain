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
 * per label in `overlapped_ms` and never added to a stage. A branch (`branch()`)
 * runs whole stages alongside the critical path (the vector side next to the
 * lexical arms): until the request `join`s it, its stage time is reported in
 * `overlapped_ms` under the stage's name; from the join on, the wait is booked
 * to whichever stage the branch is in. `total_ms` is its
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
  /** Sequential parts of a stage (`part`), integer ms; the rest of the stage is in no part. */
  parts_ms?: Partial<Record<SearchStage, Record<string, number>>>;
}

export interface StageTimer {
  stage<T>(stage: SearchStage, work: () => Promise<T>): Promise<T>;
  overlap<T>(label: string, work: Promise<T>): Promise<T>;
  /** A timer for stages that run alongside the critical path until `join` waits on them. */
  branch(): StageTimer;
  /** Wait on work timed by `branch`: the wait is booked to the branch's current stage. */
  join<T>(branch: StageTimer, work: Promise<T>): Promise<T>;
}

/** The timer for calls nobody measures (bare hybrid callers, internal searches). */
export const UNTIMED: StageTimer = {
  stage: (_stage, work) => work(),
  overlap: (_label, work) => work,
  branch: () => UNTIMED,
  join: (_branch, work) => work,
};

export class SearchTimings implements StageTimer {
  private readonly startedAt: number;
  private current: SearchStage | null = null;
  private since: number;
  private readonly spent = new Map<SearchStage, number>();
  private readonly overlapped = new Map<string, number>();
  private readonly parts = new Map<SearchStage, Map<string, number>>();
  private currentPart: { stage: SearchStage; part: string; since: number } | null = null;

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

  /**
   * Book one sequential part of the current stage (`parts_ms[stage][part]`), for a stage whose
   * steps run one after another (`response`). Like stages, a nested part takes the clock and
   * hands it back, so parts never overlap and sum to at most the stage. The stage's own
   * booking is unchanged.
   */
  async part<T>(stage: SearchStage, part: string, work: () => Promise<T>): Promise<T> {
    const previous = this.switchPart({ stage, part, since: 0 });
    try {
      return await work();
    } finally {
      this.switchPart(previous);
    }
  }

  private switchPart(next: { stage: SearchStage; part: string; since: number } | null): { stage: SearchStage; part: string; since: number } | null {
    const at = this.now();
    const previous = this.currentPart;
    if (previous) this.bookPart(previous.stage, previous.part, at - previous.since);
    if (next) {
      next.since = at;
      if (!this.parts.get(next.stage)?.has(next.part)) this.bookPart(next.stage, next.part, 0);
    }
    this.currentPart = next;
    return previous;
  }

  private bookPart(stage: SearchStage, part: string, ms: number): void {
    let byPart = this.parts.get(stage);
    if (!byPart) this.parts.set(stage, byPart = new Map());
    byPart.set(part, (byPart.get(part) ?? 0) + ms);
  }

  overlap<T>(label: string, work: Promise<T>): Promise<T> {
    const started = this.now();
    const settle = () => { this.overlapped.set(label, (this.overlapped.get(label) ?? 0) + this.now() - started); };
    work.then(settle, settle);
    return work;
  }

  branch(): StageTimer {
    return new BranchTimer(this, this.now);
  }

  async join<T>(branch: StageTimer, work: Promise<T>): Promise<T> {
    if (!(branch instanceof BranchTimer) || branch.parent !== this) return work;
    const base = this.current;
    this.switchTo(branch.attach(base) ?? base);
    try {
      return await work;
    } finally {
      branch.detach();
      this.switchTo(base);
    }
  }

  /** @internal BranchTimer bookkeeping. */
  declare(stage: SearchStage): void {
    if (!this.spent.has(stage)) this.spent.set(stage, 0);
  }

  /** @internal BranchTimer bookkeeping. */
  follow(stage: SearchStage | null): void {
    this.switchTo(stage);
  }

  /** @internal BranchTimer bookkeeping. */
  bookOverlapped(label: string, ms: number): void {
    this.overlapped.set(label, (this.overlapped.get(label) ?? 0) + ms);
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
    const partSpent = new Map([...this.parts].map(([stage, byPart]) => [stage, new Map(byPart)]));
    if (this.currentPart) {
      const { stage, part, since } = this.currentPart;
      partSpent.get(stage)!.set(part, partSpent.get(stage)!.get(part)! + at - since);
    }
    const partsMs = Object.fromEntries([...partSpent].map(([stage, byPart]) => [stage, Object.fromEntries([...byPart].map(([part, ms]) => [part, Math.round(ms)]))]));
    return {
      total_ms: Math.round(total),
      stages_ms: Object.fromEntries(parts.map(([stage], i) => [stage, ints[i]])),
      other_ms: ints[ints.length - 1],
      ...(this.overlapped.size > 0 ? { overlapped_ms: overlappedMs } : {}),
      ...(partSpent.size > 0 ? { parts_ms: partsMs } : {}),
    };
  }
}

/** Stages run off the critical path: overlapped until joined, then booked to the parent's stages. */
class BranchTimer implements StageTimer {
  private current: SearchStage | null = null;
  private since: number;
  private joinedBase: SearchStage | null | undefined;

  constructor(readonly parent: SearchTimings, private readonly now: () => number) {
    this.since = now();
  }

  private enter(stage: SearchStage | null): SearchStage | null {
    const at = this.now();
    if (this.joinedBase === undefined && this.current) this.parent.bookOverlapped(this.current, at - this.since);
    this.since = at;
    const previous = this.current;
    this.current = stage;
    if (this.joinedBase !== undefined) this.parent.follow(stage ?? this.joinedBase);
    return previous;
  }

  async stage<T>(stage: SearchStage, work: () => Promise<T>): Promise<T> {
    this.parent.declare(stage);
    const previous = this.enter(stage);
    try {
      return await work();
    } finally {
      this.enter(previous);
    }
  }

  overlap<T>(label: string, work: Promise<T>): Promise<T> {
    return this.parent.overlap(label, work);
  }

  /** A branch's own branches are untimed. */
  branch(): StageTimer {
    return UNTIMED;
  }

  join<T>(_branch: StageTimer, work: Promise<T>): Promise<T> {
    return work;
  }

  /** The parent starts waiting: book the overlapped part so far and hand the clock the current stage. */
  attach(base: SearchStage | null): SearchStage | null {
    const at = this.now();
    if (this.current) this.parent.bookOverlapped(this.current, at - this.since);
    this.since = at;
    this.joinedBase = base;
    return this.current;
  }

  detach(): void {
    this.joinedBase = undefined;
    this.since = this.now();
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

/** One `--explain` header line: `timings: 142ms total — lexical 12, embed 30, …, other 5 (overlapped: keyword_arm 10) (parts: response.meta 3)`. */
export function formatTimingsSummary(timings: SearchTimingsMeta | undefined): string | null {
  if (!timings || typeof timings.total_ms !== 'number') return null;
  const stages = Object.entries(timings.stages_ms ?? {}).map(([stage, ms]) => `${stage} ${ms}`);
  const overlapped = Object.entries(timings.overlapped_ms ?? {}).map(([label, ms]) => `${label} ${ms}`);
  const parts = Object.entries(timings.parts_ms ?? {}).flatMap(([stage, byPart]) => Object.entries(byPart ?? {}).map(([part, ms]) => `${stage}.${part} ${ms}`));
  return `timings: ${timings.total_ms}ms total — ${[...stages, `other ${timings.other_ms}`].join(', ')}`
    + (overlapped.length > 0 ? ` (overlapped: ${overlapped.join(', ')})` : '')
    + (parts.length > 0 ? ` (parts: ${parts.join(', ')})` : '');
}
