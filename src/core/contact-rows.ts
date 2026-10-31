/**
 * #8109: duplicated contact rows. A page's frontmatter `contacts:` list of
 * `{type, value, last_used, ...}` rows collapses to one row per (type, value):
 * a writer that appends a row on every touch instead of updating the existing
 * one leaves the same value many times. Pure; no I/O.
 *
 * Never drops a distinct value: rows group by (type trimmed and lower-cased,
 * value trimmed), so two spellings of a value stay two rows; a merged row keeps
 * its first row's spelling. A group merges into its first row only when every field other than an activity date agrees
 * or is absent on some rows; activity dates (`last_*`, `*_last_used`,
 * `updated`) keep the newest valid date. A group with any other conflicting
 * field only loses rows that are exact copies of an earlier one. Rows that are
 * not `{type, value}` objects are left as they are.
 */
import { digest } from './persistence/digest.ts';

export const CONTACT_ROWS_KEY = 'contacts';
export const ACTIVITY_DATE_KEY = /^(?:updated|updated_at|modified|last_modified|last_[a-z0-9_]+|[a-z0-9_]+_last_used)$/;

export interface ContactRowsDedupe { rows: unknown[]; removed: number; kept_conflicting: number }

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
const keyOf = (row: unknown): string | null => {
  if (!isRow(row) || typeof row.type !== 'string' || (typeof row.value !== 'string' && typeof row.value !== 'number')) return null;
  const type = row.type.trim().toLowerCase(), value = String(row.value).trim();
  return type && value ? JSON.stringify([type, value]) : null;
};
const instant = (value: unknown): number => {
  const text = value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null;
  return text === null ? NaN : Date.parse(text);
};

/** One row for the group, or null when a non-activity field conflicts or an activity date is not a date. */
function merge(group: Row[]): Row | null {
  const merged: Row = {};
  for (const row of group) {
    for (const [field, value] of Object.entries(row)) {
      if (!Object.hasOwn(merged, field)) { merged[field] = value; continue; }
      if (field === 'type' || field === 'value' || digest(merged[field]) === digest(value)) continue;
      if (!ACTIVITY_DATE_KEY.test(field)) return null;
      const kept = instant(merged[field]), next = instant(value);
      if (!Number.isFinite(kept) || !Number.isFinite(next)) return null;
      if (next > kept) merged[field] = value;
    }
  }
  return merged;
}

/** The deduplicated list, or null when `list` is not an array or nothing would change. */
export function dedupeContactRows(list: unknown): ContactRowsDedupe | null {
  if (!Array.isArray(list)) return null;
  const groups = new Map<string, Row[]>();
  for (const row of list) {
    const key = keyOf(row);
    if (key) groups.set(key, [...(groups.get(key) ?? []), row as Row]);
  }
  if (![...groups.values()].some(group => group.length > 1)) return null;
  const merged = new Map<string, Row | null>([...groups].map(([key, group]) => [key, group.length > 1 ? merge(group) : group[0]]));
  const rows: unknown[] = [];
  const emitted = new Set<string>();
  const seenExact = new Set<string>();
  let kept_conflicting = 0;
  for (const row of list) {
    const key = keyOf(row);
    if (!key) { rows.push(row); continue; }
    const one = merged.get(key);
    if (one) { if (!emitted.has(key)) { emitted.add(key); rows.push(one); } continue; }
    const exact = digest(row);
    if (seenExact.has(exact)) continue;
    seenExact.add(exact);
    if (emitted.has(key)) kept_conflicting++;
    emitted.add(key);
    rows.push(row);
  }
  const removed = list.length - rows.length;
  return removed > 0 ? { rows, removed, kept_conflicting } : null;
}

/** `frontmatter` with its contact rows deduplicated, or null when nothing changes. */
export function dedupeFrontmatterContacts(frontmatter: Record<string, unknown> | null | undefined): { frontmatter: Record<string, unknown>; dedupe: ContactRowsDedupe } | null {
  const dedupe = frontmatter && Object.hasOwn(frontmatter, CONTACT_ROWS_KEY) ? dedupeContactRows(frontmatter[CONTACT_ROWS_KEY]) : null;
  return dedupe ? { frontmatter: { ...frontmatter, [CONTACT_ROWS_KEY]: dedupe.rows }, dedupe } : null;
}
