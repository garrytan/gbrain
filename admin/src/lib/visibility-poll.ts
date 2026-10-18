/**
 * #5061: a poll that runs only while the page is visible.
 *
 * The Dashboard refreshes `getStats` / `getHealth` every 30 s; on Postgres both
 * are full aggregates over `pages` + `content_chunks`, so a dashboard tab left
 * open in the background kept a mid-sized brain's database busy for nothing.
 * `startVisibilityPoll` stops the interval while `document.hidden` is true and,
 * when the tab comes back, runs `tick` once (the numbers on screen are stale)
 * and restarts it. Document and timers are parameters so the behaviour is
 * testable without a DOM.
 */

export interface PollDocument {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface PollTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Starts the poll and returns the function that stops it and detaches the listener. */
export function startVisibilityPoll(tick: () => void, intervalMs: number, doc: PollDocument, timers: PollTimers = globalThis): () => void {
  let handle: unknown = null;
  const stop = () => {
    if (handle === null) return;
    timers.clearInterval(handle);
    handle = null;
  };
  const start = () => {
    if (handle === null) handle = timers.setInterval(tick, intervalMs);
  };
  const onVisibilityChange = () => {
    if (doc.hidden) {
      stop();
      return;
    }
    tick();
    start();
  };
  doc.addEventListener('visibilitychange', onVisibilityChange);
  if (!doc.hidden) start();
  return () => {
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    stop();
  };
}
