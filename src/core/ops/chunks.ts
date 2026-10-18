/**
 * Resolution & Chunks operation cluster — pure move from operations.ts
 * (v0.46.x tranche 2). Op consts stay module-private; `chunksOperations`
 * below lists them in EXACTLY the order they appear in the canonical
 * `operations` array in ../operations.ts. Never import from
 * '../operations.ts' here (cycle).
 */

import { MIN_TRUST_PARAM, resolveReadEligibility } from '../eligibility/policy.ts';
import { stampPageTrust } from '../eligibility/stamp.ts';
import type { Operation } from './contract.ts';
import { readPolicyOpts } from './context.ts';
import { federatedSearchScope, parseSourceIdParam } from './context.ts';
import { invalidParam } from './op-fix.ts';
import { GET_CHUNKS_DEFAULT_LIMIT, GET_CHUNKS_REMOTE_MAX_LIMIT, pagingLimit, reportChunkPage } from './read-paging.ts';

// --- Resolution & Chunks ---

const resolve_slugs: Operation = {
  name: 'resolve_slugs',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Fuzzy-match a partial slug or title to page slugs. Use when a slug is uncertain. Needs read scope.',
  params: {
    partial: { type: 'string', required: true, description: 'Partial slug or title.' },
    source_id: {
      type: 'string',
      description: "One source, or '__all__'.",
    },
  },
  handler: async (ctx, p) => {
    // #3242: was fully UNSCOPED — the one read that leaked every source's
    // slugs to any caller (the reporter's "resolve_slugs sees them but
    // get_page doesn't" matrix). Route through the same visibility set as
    // get_page/search: grant > federated set > scalar source. An explicit
    // per-call source_id narrows through resolveRequestedScope.
    const sourceIdParam = parseSourceIdParam(p.source_id, 'resolve_slugs', { allowAll: true });
    const scope = federatedSearchScope(ctx, sourceIdParam);
    return ctx.engine.resolveSlugs(p.partial as string, await readPolicyOpts(ctx, scope));
  },
  scope: 'read',
};

const get_chunks: Operation = {
  name: 'get_chunks',
  mutating: false,
  idempotent: true,
  outputRedaction: { exempt: 'explicit chunk read by slug, the page-read twin of get_page (CEO-17 raw-read exception)' },
  description: `Return a page's indexed content chunks (the units search ranks), in chunk_index order, ${GET_CHUNKS_DEFAULT_LIMIT} at a time by default. Use when debugging why search did or did not match a page. A large page has more chunks than one call returns: the last chunk of a cut list carries truncated: true and next_from_index, _meta.pagination carries total_chunks and next_from_index, and a listing_truncated notice names the next call (from_index). Needs read scope. On page_not_found: resolve the slug with resolve_slugs.`,
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose content chunks to return.' },
    min_trust: MIN_TRUST_PARAM,
    from_index: { type: 'number', description: 'Return chunks from this chunk_index on (a non-negative integer). Default 0.' },
    limit: { type: 'number', description: `How many chunk_index positions to return (a positive integer). Default ${GET_CHUNKS_DEFAULT_LIMIT}; MCP callers are capped at ${GET_CHUNKS_REMOTE_MAX_LIMIT}.` },
  },
  handler: async (ctx, p) => {
    const fromIndex = p.from_index === undefined || p.from_index === null ? 0 : p.from_index;
    if (!(typeof fromIndex === 'number' && Number.isSafeInteger(fromIndex) && fromIndex >= 0)) {
      throw invalidParam(ctx, 'get_chunks', 'from_index', 'get_chunks: from_index must be a non-negative integer.', { example: 50 });
    }
    const { limit, clampedFrom } = pagingLimit(ctx, 'get_chunks', p.limit, GET_CHUNKS_DEFAULT_LIMIT, GET_CHUNKS_REMOTE_MAX_LIMIT);
    // #2555: route through the canonical scope ladder (federated array >
    // scalar floor > nothing) instead of the pre-#2200 scalar-only pattern —
    // a federated grant could read the page via get_page but got [] here.
    const scope = await readPolicyOpts(ctx);
    // #4352 remediation: a `visibility: private` page's chunks read exactly
    // like a missing page's ([]) for untrusted callers — no existence oracle.
    // Large pages: one range of chunk_index per call, never every chunk.
    const page = await ctx.engine.getChunkPage(p.slug as string, { ...scope, fromIndex, limit });
    // #5575: a chunk's tier is its page's (lowered by a fence trust marker); rows below the floor read as missing.
    const { floor } = await resolveReadEligibility(ctx, { minTrust: p.min_trust });
    const chunks = (await stampPageTrust(ctx.engine, page.chunks.map(c => ({ ...c, slug: p.slug as string })), floor))
      .map(({ slug: _slug, ...chunk }) => chunk);
    const next = reportChunkPage(ctx, p, { fromIndex, limit, clampedFrom, returned: chunks.length, totalChunks: page.total_chunks, maxChunkIndex: page.max_chunk_index });
    if (next === undefined || chunks.length === 0) return chunks;
    return [...chunks.slice(0, -1), { ...chunks[chunks.length - 1], truncated: true, next_from_index: next }];
  },
  scope: 'read',
};


// Ops in EXACTLY the canonical `operations` array order.
export const chunksOperations: Operation[] = [resolve_slugs, get_chunks];
