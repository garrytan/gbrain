/**
 * #6712 PR 4b (design v3 "Bounded memory": CPU loops yield): the cooperative yield of a large level's synchronous loops.
 * A 600k-path round classifies, maps and sorts for seconds; without a turn of the event loop between stretches the
 * persistence consumer's idle probe, lease renewals and every timer starve for that long. A loop asks `due()` once per
 * entry (a counter, then the clock every 64 entries: a probe's entry reads a file) and awaits `pause()` when its stretch has run
 * `LOOP_BUDGET_MS`: one timer turn (`setTimeout(0)`), so expired timers and I/O run before it continues (Bun can run
 * consecutive `setImmediate` turns without its timers phase: 61k full rounds held a 50 ms interval timer for 102-276 ms).
 */

/** A stretch of synchronous work longer than this yields (the ruling bounds a stretch at about 100 ms; the rest is room for the entry that crosses it and for work outside these loops). */
export const LOOP_BUDGET_MS = 30;
const CHECK_EVERY = 64;

export interface LoopYield {
  /** Whether the current stretch has run its budget; cheap enough to ask per entry (`entries`: how many this call stands for). */
  due(entries?: number): boolean;
  /** Whether the current stretch already ran its budget, asked before work that cannot stop part-way (a chunk, a fetch result). */
  over(): boolean;
  /** One timer turn; the next stretch starts after it. */
  pause(): Promise<void>;
}

export function loopYield(): LoopYield {
  let since = performance.now(), n = 0;
  return {
    due: (entries = 1) => { n += entries; if (n < CHECK_EVERY) return false; n = 0; return performance.now() - since >= LOOP_BUDGET_MS; },
    over: () => performance.now() - since >= LOOP_BUDGET_MS,
    pause: async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); since = performance.now(); },
  };
}

/**
 * #7355: `step` that also reports from its pauses, at most once per `everyMs`: a level read that screens a large source for
 * minutes before its first commit tells the drain's in-pass governor it is working, as a commit does. `assertActive` runs
 * at every pause, so a job deadline or a lost drain lease stops the read at its next pause instead of when it ends.
 */
export function progressYield(step: LoopYield, hooks: { onProgress?: () => void; assertActive?: () => void }, everyMs = 1_000): LoopYield {
  const { onProgress, assertActive } = hooks;
  if (!onProgress && !assertActive) return step;
  let last = performance.now();
  return { due: step.due, over: step.over, pause: async () => {
    await step.pause();
    assertActive?.();
    if (onProgress && performance.now() - last >= everyMs) { last = performance.now(); onProgress(); }
  } };
}

/** `work`, or the error `assertActive` throws once it does (checked every `everyMs`); the work itself is not stopped. */
export async function whileActive<T>(work: Promise<T>, assertActive: (() => void) | undefined, everyMs = 1_000): Promise<T> {
  if (!assertActive) return work;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopped = new Promise<never>((_, reject) => { timer = setInterval(() => { try { assertActive(); } catch (error) { reject(error); } }, everyMs); });
  try { return await Promise.race([work, stopped]); } finally { clearInterval(timer); }
}

/** How often the shared budget's clock notes that timers ran, and for how many ticks it keeps going once nothing asks. */
const TURN_TICK_MS = 4, TURN_QUIET_TICKS = 25;

/**
 * One budget for reads that overlap (a level's Git streams and its `I⋈P` cursor): its stretch starts when timers last ran,
 * not at its own last pause, so the turn one read spent (a Git chunk, a fetch result the driver decoded in one go) counts
 * against the other, and neither starts its work right after the other's in the same turn. A clock ticks while it is asked.
 */
export function turnYield(): LoopYield {
  let since = performance.now(), n = 0, quiet = 0, clock: ReturnType<typeof setInterval> | undefined;
  const over = () => {
    quiet = 0;
    if (!clock) {
      since = performance.now();
      clock = setInterval(() => { since = performance.now(); if (++quiet > TURN_QUIET_TICKS) { clearInterval(clock); clock = undefined; } }, TURN_TICK_MS);
      (clock as { unref?: () => void }).unref?.();
    }
    return performance.now() - since >= LOOP_BUDGET_MS;
  };
  return {
    due: (entries = 1) => { n += entries; if (n < CHECK_EVERY) return false; n = 0; return over(); },
    over,
    pause: async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); since = performance.now(); },
  };
}

/** `items.filter(keep)` with yields between stretches. */
export async function filterYielding<T>(items: readonly T[], keep: (item: T) => unknown, step: LoopYield = loopYield()): Promise<T[]> {
  const kept: T[] = [];
  for (const item of items) {
    if (step.due()) await step.pause();
    if (keep(item)) kept.push(item);
  }
  return kept;
}

/** `items.sort()` (code-unit order, as the default comparator) in runs merged with yields between stretches. */
export async function sortYielding(items: string[], step: LoopYield): Promise<string[]> {
  const RUN = 16_384;
  let runs: string[][] = [];
  for (let i = 0; i < items.length; i += RUN) {
    runs.push(items.slice(i, i + RUN).sort());
    if (step.due(RUN)) await step.pause();
  }
  while (runs.length > 1) {
    const next: string[][] = [];
    for (let r = 0; r < runs.length; r += 2) {
      const a = runs[r]!, b = runs[r + 1];
      if (!b) { next.push(a); continue; }
      const out = new Array<string>(a.length + b.length);
      let i = 0, j = 0, k = 0;
      while (i < a.length && j < b.length) {
        out[k++] = b[j]! < a[i]! ? b[j++]! : a[i++]!;
        if (step.due()) await step.pause();
      }
      while (i < a.length) out[k++] = a[i++]!;
      while (j < b.length) out[k++] = b[j++]!;
      next.push(out);
    }
    runs = next;
  }
  return runs[0] ?? [];
}
