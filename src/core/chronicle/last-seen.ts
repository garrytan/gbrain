// v0.42.x — Life Chronicle (#2390). Shared last-seen finalizer so both engines
// compute `days_ago` identically (engine parity is on the result, not the SQL).
import type { LastSeenResult } from '../types.ts';

/**
 * Build a LastSeenResult from a resolved last-seen date. `lastDate` is a bare
 * 'YYYY-MM-DD' (or null when the entity was never seen). `asof` (also
 * 'YYYY-MM-DD') pins the reference day for deterministic tests; defaults to now.
 * Both are interpreted at UTC midnight so the day-difference is timezone-stable.
 */
export function finalizeLastSeen(
  entitySlug: string,
  lastDate: string | null,
  lastEventSlug: string | null,
  asof?: string,
): LastSeenResult {
  let days_ago: number | null = null;
  if (lastDate) {
    const base = asof ? new Date(`${asof}T00:00:00Z`) : new Date();
    const then = new Date(`${lastDate}T00:00:00Z`);
    days_ago = Math.max(0, Math.floor((base.getTime() - then.getTime()) / 86_400_000));
  }
  return {
    entity_slug: entitySlug,
    last_date: lastDate,
    last_event_slug: lastEventSlug,
    days_ago,
  };
}
