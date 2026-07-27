/**
 * v0.41.25.0 (#1570) — db-disconnect call audit.
 *
 * Records every call to `db.disconnect()` and `PostgresEngine.disconnect()`
 * so we can identify the offending code path that nulls the module
 * singleton mid-cycle. The reported #1570 symptom — `gbrain dream` losing
 * ~150 rows per cycle with `'No database connection'` errors — happens
 * because some caller disconnects the shared singleton while other code
 * paths are still using it. The retry-layer reconnect callback (v0.41.25
 * symptom fix) covers the loss, but only this audit tells us WHO is
 * actually calling disconnect mid-process.
 *
 * Per codex outside-voice finding 4 from the v0.41.25 plan review:
 * "instrument first, fix later." v0.41.26 patches the specific ownership
 * boundary once production data tells us the caller.
 *
 * Per codex finding 11: built on the existing `audit-writer.ts` cathedral
 * — no parallel subsystem. Same file rotation, same best-effort write
 * semantics, same readRecent walk. Doctor extends `batch_retry_health`
 * to surface 24h count.
 *
 * Schema is intentionally narrow:
 *
 *   - `ts`               ISO-8601 timestamp
 *   - `engine_kind`      'postgres' | 'pglite' (PGLite paths still log
 *                        for completeness; they're a no-op for the
 *                        singleton bug but useful as background data)
 *   - `connection_style` 'module' | 'instance' — module-mode calls are
 *                        the load-bearing ones (they touch the singleton)
 *   - `caller_stack`     `new Error().stack` truncated to 20 frames so
 *                        operators can identify the offending caller
 *                        without inflating the JSONL forever
 *   - `command`          argv[2] when known, else 'unknown'. Helps map
 *                        an offending disconnect to a specific CLI cmd
 *   - `pid`              process.pid for cross-process correlation
 *
 * Privacy: stack frames contain file paths but no SQL content, no row
 * data, no user-supplied strings. Matches the shell-audit.ts posture
 * from v0.20+. Audit file lives at
 * `~/.gbrain/audit/db-disconnect-YYYY-Www.jsonl` (honors
 * `GBRAIN_AUDIT_DIR` via the shared `resolveAuditDir()` helper).
 */

import { createAuditWriter } from './audit-writer.ts';

export interface DbDisconnectAuditEvent {
  ts: string;
  engine_kind: 'postgres' | 'pglite' | 'unknown';
  connection_style: 'module' | 'instance' | 'unknown';
  caller_stack: string;
  command: string;
  pid: number;
}

const FEATURE_NAME = 'db-disconnect';

const writer = createAuditWriter<DbDisconnectAuditEvent>({
  featureName: FEATURE_NAME,
  errorLabel: 'db-disconnect-audit',
  errorTrailer: '; continuing',
});

/**
 * Capture the current call stack, normalized + truncated. We strip the
 * first two frames (this function + the caller's audit-log helper line)
 * so the resulting trace starts with the actual offending caller — the
 * frame an operator wants to see. Cap at 20 frames to bound the JSONL
 * line size on long stacks; production calls rarely need more than 8.
 *
 * Exported for unit tests to pin the stack-truncation contract.
 */
export function captureCallerStack(skipFrames = 2, maxFrames = 20): string {
  const raw = new Error().stack ?? '';
  // Bun's stack format: first line is "Error", then "    at fn (file:line:col)"
  // for each frame. Split, drop the "Error" line + `skipFrames` of our own
  // helper frames, keep up to `maxFrames` after that.
  const lines = raw.split('\n');
  // Find the first frame line (starts with whitespace + "at "). The
  // "Error" header is line 0; helper frames start at line 1.
  const frameStart = lines.findIndex((l) => /^\s+at\s/.test(l));
  if (frameStart < 0) return raw.slice(0, 4000); // fallback: hard byte cap
  const callerFrames = lines.slice(frameStart + skipFrames, frameStart + skipFrames + maxFrames);
  return callerFrames.join('\n');
}

/**
 * Log one db-disconnect call. Best-effort: stderr-warns on write failure
 * but never throws. The caller's disconnect path continues regardless.
 */
export function logDbDisconnect(
  engineKind: DbDisconnectAuditEvent['engine_kind'],
  connectionStyle: DbDisconnectAuditEvent['connection_style'],
): void {
  // argv[2] is typically the gbrain subcommand (e.g. 'dream', 'capture').
  // argv[0] is bun, argv[1] is the script path; the meaningful identity
  // is argv[2]. Defensive fallback to 'unknown' for embedded callers.
  const command = process.argv[2] ?? 'unknown';
  writer.log({
    engine_kind: engineKind,
    connection_style: connectionStyle,
    caller_stack: captureCallerStack(),
    command,
    pid: process.pid,
  });
}

/**
 * Read recent disconnect audit events. Consumed by
 * `doctor.ts:checkBatchRetryHealth` to surface the 24h count + most-
 * recent caller in the existing check (no new check needed per codex
 * finding 11).
 *
 * `hours` defaults to 24 (the "is the bug firing right now" window),
 * not the audit-writer default of 7 days. Doctor displays the 24h
 * count; operators chasing a stale incident can pass a larger window.
 */
export interface ReadDbDisconnectResult {
  events: DbDisconnectAuditEvent[];
  /** Convenience: count of mid-process events in window. */
  count: number;
  /** Convenience: most recent caller frame (for doctor display). */
  most_recent_caller: string | null;
  /** Most recent timestamp (for doctor display). */
  most_recent_ts: string | null;
}

export function readRecentDbDisconnects(
  hours = 24,
  now: Date = new Date(),
): ReadDbDisconnectResult {
  // The shared writer uses `days`; convert hours → fractional days.
  const days = hours / 24;
  // readRecent walks current + previous ISO week, then filters by
  // cutoff. Pass our hour-precision cutoff through the days-API.
  const events = writer.readRecent(days, now);
  // Defensive cutoff filter — the writer's day-precision cutoff can
  // include events outside the actual hour-precision window when days<1.
  const cutoff = now.getTime() - hours * 3_600_000;
  const filtered = events.filter((ev) => {
    const t = Date.parse(ev.ts);
    return Number.isFinite(t) && t >= cutoff;
  });
  // Sort newest-first so the "most recent" pick is honest regardless of
  // how readRecent ordered files internally.
  filtered.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const mostRecent = filtered[0];
  return {
    events: filtered,
    count: filtered.length,
    most_recent_caller: mostRecent?.caller_stack ?? null,
    most_recent_ts: mostRecent?.ts ?? null,
  };
}

/** @internal — test seam to pin the schema-version and file location. */
export function _dbDisconnectAuditFeatureName(): string {
  return FEATURE_NAME;
}
