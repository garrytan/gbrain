/**
 * Large pages (Wave A): paging for the row reads that used to return
 * everything, get_chunks (every chunk of a page), get_versions (every
 * snapshot with its body) and list_jobs (any limit a caller named, so one call
 * could load and describe the whole job table on a serve). All keep a bare array result, because
 * deployed thin clients and agents parse an array; the paging facts travel
 * the way list_pages carries them:
 *
 * - `_meta.pagination` (structured, docs/protocol/MCP_META_CHANNELS.md);
 * - the model-visible `listing_truncated` notice for remote callers when more
 *   rows remain, whose fix is the exact next call;
 * - one stderr line for the trusted local CLI when the caller named no limit
 *   and the default cut the result;
 * - get_chunks and list_jobs: the last row of a cut list carries
 *   `truncated: true` and `next_from_index` (get_chunks) or `next_cursor`
 *   (list_jobs), so a client that reads only the array (and ignores
 *   `_meta` and notices) still sees the list is incomplete. Additive fields on
 *   one element keep the array shape older clients parse.
 */
import type { Notice } from '../agent-output.ts';
import type { OperationContext } from './contract.ts';
import { invalidParam } from './op-fix.ts';

export const GET_CHUNKS_DEFAULT_LIMIT = 50;
export const GET_CHUNKS_REMOTE_MAX_LIMIT = 500;
export const GET_VERSIONS_DEFAULT_LIMIT = 20;
export const GET_VERSIONS_REMOTE_MAX_LIMIT = 100;
/** list_jobs: a serve never loads and describes an unbounded job table for one request; page with next_cursor. */
export const LIST_JOBS_DEFAULT_LIMIT = 50;
export const LIST_JOBS_REMOTE_MAX_LIMIT = 500;

/**
 * The effective limit: the default when unset, an explicit value as given
 * for the trusted local CLI, capped for every other caller. A value that is
 * not a positive safe integer is invalid_params (never echoed).
 */
export function pagingLimit(ctx: OperationContext, op: string, raw: unknown, dflt: number, remoteMax: number): { limit: number; clampedFrom?: number } {
  if (raw === undefined || raw === null) return { limit: dflt };
  if (!(typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1)) {
    throw invalidParam(ctx, op, 'limit', `${op}: limit must be a positive integer.`, { example: 5 });
  }
  if (ctx.remote === false || raw <= remoteMax) return { limit: raw };
  return { limit: remoteMax, clampedFrom: raw };
}

function emitTruncated(ctx: OperationContext, why: string, fix: Notice['fix']): void {
  if (ctx.remote === false) return;
  ctx.emitNotice?.({ code: 'listing_truncated', kind: 'info', why, ...(fix ? { fix } : {}) });
}

/** get_chunks: meta, notice and local stderr for one page of chunks; returns next_from_index when more chunks remain. */
export function reportChunkPage(ctx: OperationContext, p: Record<string, unknown>, page: {
  fromIndex: number; limit: number; clampedFrom?: number; returned: number; totalChunks: number; maxChunkIndex: number | null;
}): number | undefined {
  const more = page.maxChunkIndex !== null && page.maxChunkIndex >= page.fromIndex + page.limit;
  const next = more ? page.fromIndex + page.limit : undefined;
  ctx.emitResponseMeta?.('pagination', {
    from_index: page.fromIndex, limit: page.limit, returned: page.returned, total_chunks: page.totalChunks,
    ...(page.clampedFrom !== undefined ? { clamped_from: page.clampedFrom } : {}),
    ...(next !== undefined ? { next_from_index: next } : {}),
  });
  if (next === undefined) return undefined;
  if (ctx.remote === false) {
    if (p.limit === undefined || p.limit === null) {
      console.error(`[get_chunks] output truncated at ${page.limit} chunks (default ${GET_CHUNKS_DEFAULT_LIMIT}) of ${page.totalChunks}. Pass --limit <n>, or continue with --from-index ${next}.`);
    }
    return next;
  }
  const clamp = page.clampedFrom !== undefined ? ` (limit ${page.clampedFrom} was capped at ${page.limit})` : '';
  emitTruncated(ctx, `The page has ${page.totalChunks} chunks; chunks from chunk_index ${page.fromIndex} below ${next} were returned${clamp}, so this list is not complete.`, {
    mcp: { tool: 'get_chunks', arguments: { slug: p.slug, ...(p.min_trust !== undefined ? { min_trust: p.min_trust } : {}), from_index: next, limit: page.limit } },
    consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Fetches the next chunks; every other parameter stays the same. Keep paging until no listing_truncated notice comes back.',
  });
  return next;
}

/** get_versions: meta, notice and local stderr when the limit cut the history. */
export function reportVersionPage(ctx: OperationContext, p: Record<string, unknown>, page: { limit: number; clampedFrom?: number; truncated: boolean }): void {
  ctx.emitResponseMeta?.('pagination', {
    limit: page.limit, truncated: page.truncated, ...(page.clampedFrom !== undefined ? { clamped_from: page.clampedFrom } : {}),
  });
  if (!page.truncated) return;
  if (ctx.remote === false) {
    if (p.limit === undefined || p.limit === null) {
      console.error(`[get_versions] showing the newest ${page.limit} versions (default ${GET_VERSIONS_DEFAULT_LIMIT}); older versions exist. Pass --limit <n> for more.`);
    }
    return;
  }
  const clamp = page.clampedFrom !== undefined ? ` (limit ${page.clampedFrom} was capped at ${page.limit})` : '';
  const canWiden = page.limit < GET_VERSIONS_REMOTE_MAX_LIMIT;
  emitTruncated(ctx, `Older versions exist than the newest ${page.limit} returned${clamp}.${canWiden ? '' : ` ${GET_VERSIONS_REMOTE_MAX_LIMIT} is the most one MCP call returns.`}`, canWiden ? {
    mcp: { tool: 'get_versions', arguments: { slug: p.slug, ...(p.include_body === true ? { include_body: true } : {}), limit: GET_VERSIONS_REMOTE_MAX_LIMIT } },
    consent: [], actor: 'agent', requires_exclusive: false,
    why: `Returns up to the newest ${GET_VERSIONS_REMOTE_MAX_LIMIT} versions.`,
  } : undefined);
}

/** list_jobs: meta, notice and local stderr when more jobs match than the page returned. */
export function reportJobPage(ctx: OperationContext, p: Record<string, unknown>, page: { limit: number; clampedFrom?: number; returned: number; nextCursor?: string }): void {
  ctx.emitResponseMeta?.('pagination', {
    limit: page.limit, returned: page.returned,
    ...(page.clampedFrom !== undefined ? { clamped_from: page.clampedFrom } : {}),
    ...(page.nextCursor !== undefined ? { next_cursor: page.nextCursor } : {}),
  });
  if (page.nextCursor === undefined) return;
  if (ctx.remote === false) {
    if (p.limit === undefined || p.limit === null) {
      console.error(`[list_jobs] showing the newest ${page.limit} jobs (default ${LIST_JOBS_DEFAULT_LIMIT}); older jobs match. Pass a larger limit, or cursor ${page.nextCursor} for the next page.`);
    }
    return;
  }
  const clamp = page.clampedFrom !== undefined ? ` (limit ${page.clampedFrom} was capped at ${page.limit})` : '';
  const keep = Object.fromEntries(['status', 'queue', 'name', 'fields'].filter(k => p[k] !== undefined && p[k] !== null).map(k => [k, p[k]]));
  emitTruncated(ctx, `Older jobs match than the newest ${page.returned} returned${clamp}, so this list is not complete.`, {
    mcp: { tool: 'list_jobs', arguments: { ...keep, cursor: page.nextCursor, limit: page.limit } },
    consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Fetches the next older jobs; every other parameter stays the same. Keep paging until no listing_truncated notice comes back.',
  });
}
