/**
 * The MinionWorker claim loop's idle poll wait, which `wake()` ends early (GBRA-133 2a.4 sync-queue wake,
 * src/core/minions/sync-queue-wake.ts). A wake while the loop is claiming makes the next idle wait a no-op, so a job
 * inserted between an empty claim and the wait is never left for the full poll interval.
 */

/** One idle poll wait and how it ended (`waiting` while in progress). */
export interface IdleWait { ms: number; ended: 'waiting' | 'timer' | 'wake' | 'skipped' | 'stop'; reason?: string }

export class IdleWaiter {
  private waiting: { entry: IdleWait; timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;
  private pending = false;
  /** The newest idle waits and how each ended (bounded): the recorded decisions the sync-queue wake tests read. */
  readonly history: IdleWait[] = [];

  /** True while the claim loop waits out an idle poll (nothing claimed, nothing in flight). */
  get idle(): boolean { return this.waiting !== null; }

  /** A claim is starting: it covers every wake that arrived before it. */
  claimStarted(): void { this.pending = false; }

  wake(reason = 'wake'): void {
    const waiting = this.waiting;
    if (!waiting) { if (reason !== 'stop') this.pending = true; return; }
    this.waiting = null;
    clearTimeout(waiting.timer);
    waiting.entry.ended = reason === 'stop' ? 'stop' : 'wake';
    waiting.entry.reason = reason;
    waiting.resolve();
  }

  wait(ms: number): Promise<void> {
    if (this.history.length >= 100) this.history.shift();
    if (this.pending) {
      this.pending = false;
      this.history.push({ ms, ended: 'skipped' });
      return Promise.resolve();
    }
    const entry: IdleWait = { ms, ended: 'waiting' };
    this.history.push(entry);
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.waiting = null; entry.ended = 'timer'; resolve(); }, ms);
      this.waiting = { entry, timer, resolve };
    });
  }
}
