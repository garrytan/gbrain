/**
 * GBRA-156: foreground requests a serve answers outside its MCP stdin (the warm CLI socket). The serve's idle
 * maintenance sweep treats a window with one as active, as it treats stdin data, so a sweep never starts while warm
 * CLI searches are flowing and competing with them for the event loop and the pool.
 */
let inFlight = 0;
let lastAt = 0;

/** Marks one foreground request started; the returned function marks it finished (idempotent). */
export function beginForegroundRequest(now: () => number = Date.now): () => void {
  inFlight++;
  lastAt = now();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inFlight--;
    lastAt = now();
  };
}

/** A window check: each call says whether a foreground request is running now or ran since the previous call (or since the window opened). */
export function foregroundWindow(now: () => number = Date.now): () => boolean {
  let since = now();
  return () => {
    const active = inFlight > 0 || lastAt >= since;
    since = now();
    return active;
  };
}

/** Test seam. */
export function _resetForegroundActivityForTests(): void {
  inFlight = 0;
  lastAt = 0;
}
