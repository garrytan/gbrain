/**
 * Child-process preload for test/large-brain-ceilings.test.ts: fixes the order of a sync's first committed page and
 * its hard deadline, so each branch of the sync watchdog's deadline message runs on demand.
 * `$GBRAIN_TEST_SYNC_WATCHDOG_ORDER` picks the order; without it the preload does nothing.
 *
 *   commit-first    the watchdog worker starts at the first committed page, so that commit is noted before its
 *                   deadline ("still progressing")
 *   deadline-first  committed-page notes reach the worker 3 s after its deadline ("before the run committed anything")
 *
 * Only the worker labelled `sync-watchdog` is touched. Its source, deadline, grace and progress window are passed
 * through unchanged. Loaded with `BUN_OPTIONS=--preload <this file>`.
 */
export {};

type SyncWatchdogWorkerOptions = { workerData?: { label?: string; deadlineMs?: number } };
type RealWorker = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
  unref(): void;
};

const order = process.env.GBRAIN_TEST_SYNC_WATCHDOG_ORDER;
const DELIVER_PAST_DEADLINE_MS = 3000;

if (order) {
  if (order !== 'commit-first' && order !== 'deadline-first') throw new Error(`GBRAIN_TEST_SYNC_WATCHDOG_ORDER is not commit-first or deadline-first: ${order}`);
  // A named `import { Worker }` binds when its module loads; the CommonJS export object is what it reads from.
  const workerThreads = require('node:worker_threads') as { Worker: new (src: string, opts: SyncWatchdogWorkerOptions) => RealWorker };
  const Real = workerThreads.Worker;

  class StartsAtFirstCommit {
    #real: RealWorker | null = null;
    #listeners: Array<[string, (...args: unknown[]) => void]> = [];
    #unref = false;
    #terminated = false;
    constructor(private readonly src: string, private readonly opts: SyncWatchdogWorkerOptions) {}
    on(event: string, listener: (...args: unknown[]) => void) {
      this.#listeners.push([event, listener]);
      this.#real?.on(event, listener);
      return this;
    }
    unref() {
      this.#unref = true;
      this.#real?.unref();
    }
    postMessage(message: unknown) {
      if (this.#terminated) return;
      if (!this.#real) {
        this.#real = new Real(this.src, this.opts);
        for (const [event, listener] of this.#listeners) this.#real.on(event, listener);
        if (this.#unref) this.#real.unref();
      }
      this.#real.postMessage(message);
    }
    terminate() {
      this.#terminated = true;
      return this.#real?.terminate() ?? Promise.resolve(0);
    }
  }

  workerThreads.Worker = function OrderedWorker(src: string, opts: SyncWatchdogWorkerOptions) {
    if (opts?.workerData?.label !== 'sync-watchdog') return new Real(src, opts);
    if (order === 'commit-first') return new StartsAtFirstCommit(src, opts);
    const real = new Real(src, opts);
    const deliverAt = Date.now() + (opts.workerData.deadlineMs ?? 0) + DELIVER_PAST_DEADLINE_MS;
    const post = real.postMessage.bind(real);
    real.postMessage = (message: unknown) => {
      const wait = deliverAt - Date.now();
      if (wait <= 0) return post(message);
      const timer = setTimeout(() => { try { post(message); } catch { /* worker gone */ } }, wait);
      (timer as unknown as { unref?: () => void }).unref?.();
    };
    return real;
  } as unknown as typeof Real;
}
