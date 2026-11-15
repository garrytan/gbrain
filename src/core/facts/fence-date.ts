/** Render an already-frozen fact instant without changing its precision. */
import { formatFenceDate } from '../facts-fence.ts';

/** Keep legacy date/whole-second cells stable; retain fractional instants supplied by the fact payload. */
export function formatRetainedFactDate(date: Date): string {
  return date.getUTCMilliseconds() === 0 ? formatFenceDate(date) : date.toISOString();
}
