import { defaultTimeoutMsFor } from '../core/minions/handler-timeouts.ts';

// #2781: the full-cycle floor used to be a literal `1_800_000` that merely
// HAPPENED to match the 'autopilot-cycle' / 'autopilot-global-maintenance'
// handler anchors (`HANDLER_DEFAULT_TIMEOUT_MS`, #1737) instead of being
// derived from them. A duplicated literal can silently drift from the
// handler default it's supposed to track — which is exactly the bug class
// #2781 reported (an explicit `timeout_ms` stamp permanently overrides the
// handler default per `queue.ts`'s `opts?.timeout_ms ?? defaultTimeoutMsFor`,
// so a stale/lower literal here would starve a phase the handler default
// was sized for). Deriving the floor from `defaultTimeoutMsFor` for both
// full-cycle job names keeps the stamp coupled to its anchor by construction.
// Fail fast (not `?? 0`) if either handler ever loses its entry in
// HANDLER_DEFAULT_TIMEOUT_MS — silently falling back to "no floor" would
// reintroduce #2781 rather than surface the drift.
function requireHandlerAnchorMs(jobName: string): number {
  const ms = defaultTimeoutMsFor(jobName);
  if (ms === null) {
    throw new Error(
      `resolveAutopilotDispatchTimeoutMs: '${jobName}' has no entry in HANDLER_DEFAULT_TIMEOUT_MS ` +
      '(handler-timeouts.ts) — the full-cycle timeout floor can no longer be derived from it. ' +
      'See #2781: a missing/removed anchor here silently reintroduces the interval-derived stamp ' +
      'permanently overriding the handler default.',
    );
  }
  return ms;
}

const FULL_CYCLE_TIMEOUT_FLOOR_MS = Math.max(
  requireHandlerAnchorMs('autopilot-cycle'),
  requireHandlerAnchorMs('autopilot-global-maintenance'),
);

export function resolveAutopilotDispatchTimeoutMs(
  baseIntervalSeconds: number,
  fullCycle: boolean,
): number {
  const intervalDerivedTimeoutMs = Math.max(baseIntervalSeconds * 2 * 1000, 300_000);
  return fullCycle
    ? Math.max(intervalDerivedTimeoutMs, FULL_CYCLE_TIMEOUT_FLOOR_MS)
    : intervalDerivedTimeoutMs;
}
