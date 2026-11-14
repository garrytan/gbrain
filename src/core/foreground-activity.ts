/**
 * GBRA-156: foreground requests a serve answers outside its MCP stdin (the warm CLI socket, and the HTTP serve's /mcp
 * requests). The serve's idle maintenance sweep and idle upkeep treat a window with one as active, as they treat stdin
 * data, so neither starts while requests are flowing and competing with them for the event loop and the pool; a request
 * that starts during idle upkeep aborts it (GBRA-438).
 */
let inFlight = 0;
let lastAt = 0;
const startListeners = new Set<() => void>();

/** Calls `listener` when a foreground request starts (idle upkeep aborts on it); returns the unsubscribe. */
export function onForegroundRequest(listener: () => void): () => void {
  startListeners.add(listener);
  return () => { startListeners.delete(listener); };
}

/** Marks one foreground request started; the returned function marks it finished (idempotent). */
export function beginForegroundRequest(now: () => number = Date.now): () => void {
  inFlight++;
  lastAt = now();
  for (const listener of startListeners) listener();
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
  startListeners.clear();
}

/**
 * GBRA-438: the HTTP serve's /mcp middleware. A POST is foreground activity, so idle upkeep waits for a quiet window
 * and a request aborts a run in flight; GET /mcp (a long-lived event stream) does not count.
 */
export function mcpForegroundMiddleware(req: { method: string }, res: { once(event: 'finish' | 'close', fn: () => void): unknown }, next: () => void): void {
  if (req.method === 'POST') {
    const done = beginForegroundRequest();
    res.once('finish', done);
    res.once('close', done);
  }
  next();
}
