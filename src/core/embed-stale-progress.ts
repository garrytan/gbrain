/**
 * Exact progress accounting for `embed --stale` (#5968, wave 15 P2.6 [R28]).
 *
 * The unit is stale chunks, the thing the census counts. `total` starts at
 * the census and only grows: to the rows actually listed when a writer adds
 * stale rows behind the keyset cursor, to the rows a paced re-entry announces,
 * and by the heal delta when one oversized stored chunk splits into several.
 * `done` counts the listed rows of every key that finished (failed, filtered
 * and quarantined rows included) plus that same heal delta, and the page's
 * delta lands in `total` in the same step, so `done <= total` holds at every
 * callback and a finished run reads exactly 100%.
 */
export class StaleChunkProgress {
  private floor: number;
  private loaded = 0;
  private healExtra = 0;
  private done = 0;

  constructor(census: number) {
    this.floor = census;
  }

  /** A listing batch arrived: the total can never be below the rows listed. */
  listed(rows: number): void {
    this.loaded += rows;
  }

  /** A paced re-entry found `remaining` stale rows behind the cursor; the rescan will list at least those. */
  reentered(remaining: number): void {
    this.floor = Math.max(this.floor, this.loaded + remaining);
  }

  /**
   * One page key finished. `census` is the rows the listing carried for it;
   * `handled` is its chunk inventory after healing and the stored-text
   * filter (0 when nothing was left to embed, or the key was skipped).
   */
  pageDone(census: number, handled: number): { done: number; total: number } {
    if (handled > census) this.healExtra += handled - census;
    this.done += Math.max(census, handled);
    return this.snapshot();
  }

  snapshot(): { done: number; total: number } {
    return { done: this.done, total: Math.max(this.floor, this.loaded) + this.healExtra };
  }
}
