/**
 * Large pages (Wave A): paging for the two by-slug row reads that used to
 * return everything, get_chunks (every chunk of a page) and get_versions
 * (every snapshot with its body). Both keep a bare array result, because
 * deployed thin clients and agents parse an array; the paging facts travel
 * the way list_pages carries them:
 *
 * - `_meta.pagination` (structured, docs/protocol/MCP_META_CHANNELS.md);
 * - the model-visible `listing_truncated` notice for remote callers when more
 *   rows remain, whose fix is the exact next call;
 * - one stderr line for the trusted local CLI when the caller named no limit
 *   and the default cut the result;
 * - get_chunks only: the last chunk of a cut list carries `truncated: true`
 *   and `next_from_index`, so a client that reads only the array (and ignores
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
