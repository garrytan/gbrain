/**
 * list_pages pagination for MCP callers (agent operator contract v1, F3b;
 * absorbs community PR #5954).
 *
 * The handler probes limit+1 rows, so it knows whether rows remain, but its
 * truncation notice reaches local CLI stderr only and its remote clamp
 * warning reaches the server log only. Two channels carry the facts to MCP
 * callers:
 *
 * - `_meta.pagination` (structured data, docs/protocol/MCP_META_CHANNELS.md):
 *   `truncated`, the effective `limit`, `clamped_from` when a remote caller's
 *   limit was capped, and `next` — the params that fetch the following page,
 *   every other param unchanged. Under sort=updated_asc `next` is the
 *   lossless (updated_at, slug) keyset; any other sort continues by offset.
 * - the model-visible `listing_truncated` notice (kind info, never deduped):
 *   `_meta` is not a channel the model sees, so a full page would otherwise
 *   read as a complete listing.
 */
import type { Action, Notice } from '../agent-output.ts';

export interface ListPagesPagination {
  truncated: boolean;
  limit: number;
  clamped_from?: number;
  next?: { sort: 'updated_asc'; updated_after: string; updated_after_slug: string } | { offset: number };
}

export function listPagesPagination(opts: {
  truncated: boolean;
  limit: number;
  requestedLimit: number | undefined;
  offset: number | undefined;
  sort: string | undefined;
  last: { slug: string; updated_at_iso?: string } | undefined;
}): ListPagesPagination {
  const { truncated, limit, requestedLimit, last } = opts;
  const clamped = requestedLimit !== undefined && Number.isFinite(requestedLimit) && requestedLimit > limit;
  let next: ListPagesPagination['next'];
  if (truncated && last) {
    next = opts.sort === 'updated_asc' && last.updated_at_iso
      ? { sort: 'updated_asc', updated_after: last.updated_at_iso, updated_after_slug: last.slug }
      : { offset: (opts.offset ?? 0) + limit };
  }
  return {
    truncated,
    limit,
    ...(clamped ? { clamped_from: requestedLimit } : {}),
    ...(next ? { next } : {}),
  };
}

/** Declared list_pages params a continuation call carries over unchanged. */
const CARRIED_PARAMS = ['type', 'tag', 'sort', 'include_deleted', 'source_id', 'updated_after', 'updated_before', 'slug_prefix'] as const;

/**
 * The `listing_truncated` notice for a truncated result; null when nothing
 * was dropped. The fix is the exact next call: the caller's declared filter
 * params plus the `next` continuation (never page titles or text).
 */
export function listingTruncatedNotice(pagination: ListPagesPagination, params: Record<string, unknown>): Notice | null {
  if (!pagination.truncated || !pagination.next) return null;
  const args: Record<string, unknown> = {};
  for (const key of CARRIED_PARAMS) if (params[key] !== undefined) args[key] = params[key];
  Object.assign(args, { limit: pagination.limit }, pagination.next);
  const clamp = pagination.clamped_from !== undefined ? ` (limit ${pagination.clamped_from} was capped at ${pagination.limit})` : '';
  const fix: Action = {
    mcp: { tool: 'list_pages', arguments: args },
    consent: [],
    actor: 'agent',
    why: 'Fetches the next page; every other parameter stays the same. Keep paging until no listing_truncated notice comes back.',
    requires_exclusive: false,
  };
  return {
    code: 'listing_truncated',
    kind: 'info',
    why: `More pages match than the ${pagination.limit} returned${clamp}; this listing is not complete.`,
    fix,
  };
}
