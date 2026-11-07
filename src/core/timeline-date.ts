import { opError } from './ops/contract.ts';

/** Refuse before a timeline DATE cast; never normalize or silently drop a claimed day. */
export function assertTimelineDate(date: string): void {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [year, month, day] = date.split('-').map(Number);
    // setUTCFullYear preserves years 1–99; Date.UTC maps them to 1901–1999.
    const parsed = new Date(new Date(0).setUTCFullYear(year, month - 1, day));
    if (year > 0 && parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day) return;
  }
  throw opError('invalid_params', 'Timeline date must be a valid calendar date (YYYY-MM-DD).',
    'Correct the timeline date in the selected page or entry, then preview or submit it again. Nothing from this page was published.');
}
