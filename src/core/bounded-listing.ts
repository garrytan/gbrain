/**
 * Bounded whole-brain listings (#7246): one page of rows at a time, with the
 * totals first and an opaque keyset cursor for the next page.
 *
 * Contract every listing that uses this helper shares:
 * - CLI flags `--limit <n>` (default LISTING_DEFAULT_LIMIT), `--cursor <token>`
 *   and `--all` (every row; trusted local CLI only, never with --limit or --cursor).
 * - MCP params `limit` (default LISTING_DEFAULT_LIMIT, at most LISTING_MAX_LIMIT)
 *   and `cursor`; a remote caller is never unbounded.
 * - Output fields, after the listing's own counts: `returned`, `limit` (null
 *   under --all), `complete` (true when no row was left out) and `next_cursor`
 *   (null when complete); the CLI adds `next_command`, the argv of the next page.
 *   The rows come last so a reader can stop after the summary.
 * - The cursor is base64url JSON `{"v":1,"k":<listing kind>,"a":[...sort key]}`:
 *   the sort key of the last row returned. The next page starts strictly after
 *   it, so rows added or removed between pages never shift a page. A cursor
 *   from another listing (different kind, which includes its filters) is refused.
 */
import { opError } from './ops/contract.ts';

export const LISTING_DEFAULT_LIMIT = 100;
export const LISTING_MAX_LIMIT = 1000;

export interface ListingRequest {
  /** Rows per page; null means every row (CLI --all). */
  limit: number | null;
  cursor?: string;
}

export interface ListingPage<T> {
  rows: T[];
  returned: number;
  limit: number | null;
  complete: boolean;
  next_cursor: string | null;
}

function listingRefusal(message: string, suggestion: string) {
  return opError('invalid_params', message, suggestion);
}

export function encodeListingCursor(kind: string, after: readonly string[]): string {
  return Buffer.from(JSON.stringify({ v: 1, k: kind, a: after }), 'utf8').toString('base64url');
}

export function decodeListingCursor(kind: string, token: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  const value = parsed as { v?: unknown; k?: unknown; a?: unknown } | null;
  if (!value || value.v !== 1 || !Array.isArray(value.a) || !value.a.every(part => typeof part === 'string')) {
    throw listingRefusal('The cursor is not a listing cursor.', 'Pass the next_cursor value from the previous page unchanged, or drop the cursor to start from the first page.');
  }
  if (value.k !== kind) {
    throw listingRefusal('The cursor belongs to a different listing or filter set.', 'Rerun with the same filters as the page that returned it, or drop the cursor to start from the first page.');
  }
  return value.a as string[];
}

function compareKeys(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/** Sorts rows by `key` (code-unit order) and returns the page after the cursor. */
export function pageSortedRows<T>(rows: readonly T[], key: (row: T) => string[], request: ListingRequest, kind: string): ListingPage<T> {
  const keyed = rows.map(row => ({ row, key: key(row) })).sort((x, y) => compareKeys(x.key, y.key));
  const after = request.cursor === undefined ? null : decodeListingCursor(kind, request.cursor);
  const start = after === null ? 0 : keyed.findIndex(entry => compareKeys(entry.key, after) > 0);
  const remaining = start < 0 ? [] : keyed.slice(start);
  const page = request.limit === null ? remaining : remaining.slice(0, request.limit);
  const complete = page.length === remaining.length;
  return {
    rows: page.map(entry => entry.row),
    returned: page.length,
    limit: request.limit,
    complete,
    next_cursor: complete ? null : encodeListingCursor(kind, page[page.length - 1]!.key),
  };
}

/** Counts rows per key, keeping the `top` largest keys; `other` counts the rows under every other key. */
export function topCounts<T>(rows: readonly T[], key: (row: T) => string, top = 20): { counts: Record<string, number>; other: number } {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const name = key(row);
    totals.set(name, (totals.get(name) ?? 0) + 1);
  }
  const ranked = [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const counts: Record<string, number> = {};
  for (const [name, count] of ranked.slice(0, top)) counts[name] = count;
  return { counts, other: ranked.slice(top).reduce((n, [, count]) => n + count, 0) };
}

/** Caps one list field of a row at `limit` entries (null keeps every entry); a capped row gets `<field>_complete: false`. */
export function capRowList<T extends object>(row: T, field: keyof T & string, limit: number | null): T {
  const list = row[field];
  if (limit === null || !Array.isArray(list) || list.length <= limit) return row;
  return { ...row, [field]: list.slice(0, limit), [`${field}_complete`]: false };
}
