/**
 * list_pages `pagination` response meta (docs/protocol/MCP_META_CHANNELS.md).
 *
 * The handler probes limit+1 rows, so it knows whether rows remain, but its
 * truncation notice reaches local CLI stderr only and its remote clamp
 * warning reaches the server log only. This carries both facts to MCP
 * callers: `truncated` (more rows match), the effective `limit`,
 * `clamped_from` when a remote caller's limit was capped, and `next` — the
 * params that fetch the following page, every other param unchanged. Under
 * sort=updated_asc `next` is the lossless (updated_at, slug) keyset; any
 * other sort continues by offset.
 */
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
