/**
 * Resolve the canonical positive-polarity pull flag while preserving queued
 * jobs that still carry the legacy inverse `noPull` key. Shared by the built-in
 * `sync` and `autopilot-cycle` Minion job handlers.
 */
export function resolveJobPull(data: Record<string, unknown>): boolean {
  if (typeof data.pull === 'boolean') return data.pull;
  if (typeof data.noPull === 'boolean') return !data.noPull;
  return true;
}
