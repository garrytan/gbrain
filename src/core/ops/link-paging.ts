/**
 * get_links / get_backlinks row paging (#6876). Both ops used to return every
 * edge of a page. Each call now returns at most `limit` rows (default
 * LINK_READ_DEFAULT_LIMIT, max LINK_READ_MAX_LIMIT) in `links.id` order and
 * continues with an opaque `cursor`.
 *
 * Every read (each source of a local federated read and each identity
 * member) is a keyset page `links.id > cursor` with link_type and the
 * temporal policy applied in SQL, probing `limit + 1` rows. The streams merge
 * by link id and the cap is applied once, after the merge and the identity
 * union. A stream that hit its probe row is only complete through its last
 * row, so the page never reaches past the lowest such id: nothing between two
 * pages is skipped even when the identity union de-duplicates rows.
 *
 * The result stays a bare array (what deployed clients parse), as get_chunks
 * does: the last row of a cut page carries `truncated: true` and
 * `next_cursor`, `_meta.pagination` carries the same facts, remote callers
 * get a `listing_truncated` notice whose fix is the next call, and the local
 * CLI gets one stderr line. A cursor is bound to the op (direction), slug,
 * source scope and filters; any other cursor is `link_cursor_invalid`.
 */
import { createHash } from 'node:crypto';
import type { Action } from '../agent-output.ts';
import type { Link, PageReadPolicy } from '../types.ts';
import { LINK_READ_DEFAULT_LIMIT, LINK_READ_MAX_LIMIT } from '../engine-constants.ts';
import { opError, type OperationContext } from './contract.ts';
import { invalidParam } from './op-fix.ts';

type LinkOp = 'get_links' | 'get_backlinks';
type PagedLink = Link & { link_id?: number | string };

const CURSOR_PREFIX = 'lk1.';
/** Params that select the listing: a cursor is bound to them, and a continuation carries them. */
const LISTING_PARAMS = ['slug', 'link_type', 'status', 'as_of', 'during', 'source_id', 'all_sources', 'type'] as const;

export interface LinkListing {
  limit: number;
  afterId?: number;
  all: boolean;
  binding: string;
}

const commandOf = (opName: LinkOp) => (opName === 'get_links' ? 'links' : 'backlinks');

export const linkId = (l: Link): number => Number((l as PagedLink).link_id);

function listingArgs(p: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(LISTING_PARAMS.filter(k => p[k] !== undefined).map(k => [k, p[k]]));
}

function cliArgs(args: Record<string, unknown>): string[] {
  const out = [String(args.slug)];
  for (const [k, v] of Object.entries(args)) {
    if (k === 'slug') continue;
    out.push(`--${k.replace(/_/g, '-')}`, ...(v === true ? [] : [String(v)]));
  }
  return out;
}

function restartFix(opName: LinkOp, p: Record<string, unknown>): Action {
  const args = { ...listingArgs(p), ...(p.limit !== undefined ? { limit: p.limit } : {}) };
  return {
    argv: ['gbrain', commandOf(opName), ...cliArgs(args)],
    mcp: { tool: opName, arguments: args },
    consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Restarts the listing from its first page with the same filters and no cursor; pass each next_cursor it returns unchanged.',
    verify: { mcp: { tool: opName, arguments: { ...listingArgs(p), limit: 1 } } },
  };
}

function bindingOf(opName: LinkOp, p: Record<string, unknown>, policy: PageReadPolicy): string {
  const scope = [policy.sourceId ?? null, policy.sourceIds ?? null, policy.excludePrivate === true];
  return createHash('sha256').update(JSON.stringify([opName, ...LISTING_PARAMS.map(k => p[k] ?? null), ...scope])).digest('hex').slice(0, 16);
}

function decodeCursor(raw: unknown, binding: string): number | null {
  if (typeof raw !== 'string' || !raw.startsWith(CURSOR_PREFIX)) return null;
  try {
    const c = JSON.parse(Buffer.from(raw.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')) as { i?: unknown; b?: unknown };
    return c.b === binding && typeof c.i === 'number' && Number.isSafeInteger(c.i) && c.i >= 0 ? c.i : null;
  } catch {
    return null;
  }
}

const encodeCursor = (id: number, binding: string) => CURSOR_PREFIX + Buffer.from(JSON.stringify({ i: id, b: binding })).toString('base64url');

/** Validate limit / cursor / all for one link listing. */
export function parseLinkListing(ctx: OperationContext, opName: LinkOp, p: Record<string, unknown>, policy: PageReadPolicy): LinkListing {
  let limit = LINK_READ_DEFAULT_LIMIT;
  if (p.limit !== undefined && p.limit !== null) {
    const n = typeof p.limit === 'string' ? Number(p.limit) : p.limit;
    if (!(typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= LINK_READ_MAX_LIMIT)) {
      throw invalidParam(ctx, opName, 'limit', `${opName}: limit must be an integer from 1 to ${LINK_READ_MAX_LIMIT}.`, { example: LINK_READ_DEFAULT_LIMIT });
    }
    limit = n;
  }
  if (p.all === true && ctx.remote !== false) {
    throw invalidParam(ctx, opName, 'all', `${opName}: all is for the local CLI; page with cursor instead.`,
      { example: true, fix: restartFix(opName, p) });
  }
  const binding = bindingOf(opName, p, policy);
  if (p.cursor === undefined || p.cursor === null) return { limit, all: p.all === true, binding };
  const afterId = decodeCursor(p.cursor, binding);
  if (afterId === null) {
    throw opError('link_cursor_invalid',
      `${opName}: cursor is not one this listing returned (another slug, direction, source scope or filter, or not a cursor).`,
      'Restart the listing with the same filters and no cursor, then pass each next_cursor unchanged.',
      { legacy_error: 'invalid_params', fix: restartFix(opName, p) });
  }
  return { limit, afterId, all: p.all === true, binding };
}

/**
 * One page from the merged streams (sorted by link id, de-duplicated). A
 * stream that returned its probe row bounds the page at its last id.
 */
export function cutLinkPage(streams: Link[][], merged: Link[], limit: number): { rows: Link[]; nextId?: number } {
  let bound = Infinity;
  for (const s of streams) if (s.length > limit) bound = Math.min(bound, linkId(s[s.length - 1]));
  const within = merged.filter(l => linkId(l) <= bound);
  const rows = within.slice(0, limit);
  if (within.length > limit) return { rows, nextId: linkId(rows[rows.length - 1]) };
  return bound === Infinity ? { rows } : { rows, nextId: bound };
}

/** Pagination meta, the remote notice or the local stderr line; returns the next cursor when the listing continues. */
export function reportLinkPage(ctx: OperationContext, opName: LinkOp, p: Record<string, unknown>, listing: LinkListing, page: { returned: number; nextId?: number }): string | undefined {
  const next = page.nextId === undefined ? undefined : encodeCursor(page.nextId, listing.binding);
  ctx.emitResponseMeta?.('pagination', { limit: listing.limit, returned: page.returned, truncated: next !== undefined, ...(next ? { next_cursor: next } : {}) });
  if (!next) return undefined;
  const args = { ...listingArgs(p), ...(p.limit !== undefined ? { limit: p.limit } : {}), cursor: next };
  if (ctx.remote === false) {
    ctx.logger.warn(`[gbrain] ${commandOf(opName)}: showing ${page.returned} link rows (limit ${listing.limit}); more exist. ` +
      `Continue with --cursor ${next}, or pass --all for every row.`);
    return next;
  }
  ctx.emitNotice?.({
    code: 'listing_truncated', kind: 'info',
    why: `${page.returned} link rows were returned (limit ${listing.limit}) and more match, so this list is not complete; a missing edge here is not proof it does not exist.`,
    fix: { mcp: { tool: opName, arguments: args }, consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Fetches the next rows of the same listing; keep paging until a response has no next_cursor.' },
  });
  return next;
}

/** Drop the keyset column; the last row of a cut page carries truncated + next_cursor. */
export function finishLinkPage<T extends Link>(rows: T[], nextCursor: string | undefined): T[] {
  const out = rows.map(r => {
    const { link_id: _id, ...rest } = r as T & { link_id?: unknown };
    return rest as T;
  });
  if (!nextCursor || out.length === 0) return out;
  return [...out.slice(0, -1), { ...out[out.length - 1], truncated: true, next_cursor: nextCursor }];
}
