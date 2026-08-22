/**
 * Resolution & Chunks operation cluster — pure move from operations.ts
 * (v0.46.x tranche 2). Op consts stay module-private; `chunksOperations`
 * below lists them in EXACTLY the order they appear in the canonical
 * `operations` array in ../operations.ts. Never import from
 * '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { federatedSearchScope, sourceScopeOpts } from './context.ts';
import {
  findPrivateOnlySlugs,
  resolveExcludePrivatePages,
  slugHiddenFromCaller,
} from '../search/private-visibility.ts';

// --- Resolution & Chunks ---

const resolve_slugs: Operation = {
  name: 'resolve_slugs',
  description: 'Fuzzy-resolve a partial slug to matching page slugs',
  params: {
    partial: { type: 'string', required: true, description: "Partial slug or title text to match, e.g. 'alice-ex' or 'meeting notes'. This is the search text param — there is no `text` param." },
  },
  handler: async (ctx, p) => {
    // #3242: was fully UNSCOPED — the one read that leaked every source's
    // slugs to any caller (the reporter's "resolve_slugs sees them but
    // get_page doesn't" matrix). Route through the same visibility set as
    // get_page/search: grant > federated set > scalar source.
    const scope = federatedSearchScope(ctx);
    const candidates = await ctx.engine.resolveSlugs(p.partial as string, scope);
    // #4352 remediation: fuzzy resolution must not enumerate private slugs to
    // an untrusted caller — same gate as get_page's candidate filter (trusted
    // local + the operator opt-outs resolve to false and skip the probe).
    if (candidates.length === 0 || !(await resolveExcludePrivatePages(ctx.engine, ctx.remote))) {
      return candidates;
    }
    const hidden = await findPrivateOnlySlugs(ctx.engine, candidates, scope);
    return candidates.filter(c => !hidden.has(c));
  },
  scope: 'read',
};

const get_chunks: Operation = {
  name: 'get_chunks',
  description: 'Get content chunks for a page',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose content chunks to return.' },
  },
  handler: async (ctx, p) => {
    // #2555: route through the canonical scope ladder (federated array >
    // scalar floor > nothing) instead of the pre-#2200 scalar-only pattern —
    // a federated grant could read the page via get_page but got [] here.
    const scope = sourceScopeOpts(ctx);
    // #4352 remediation: a `visibility: private` page's chunks read exactly
    // like a missing page's ([]) for untrusted callers — no existence oracle.
    if (await slugHiddenFromCaller(ctx.engine, ctx.remote, p.slug as string, scope)) return [];
    return ctx.engine.getChunks(p.slug as string, scope);
  },
  scope: 'read',
};


// Ops in EXACTLY the canonical `operations` array order.
export const chunksOperations: Operation[] = [resolve_slugs, get_chunks];
