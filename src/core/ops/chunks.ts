/**
 * Resolution & Chunks operation cluster — pure move from operations.ts
 * (v0.46.x tranche 2). Op consts stay module-private; `chunksOperations`
 * below lists them in EXACTLY the order they appear in the canonical
 * `operations` array in ../operations.ts. Never import from
 * '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { readPolicyOpts } from './context.ts';
import { federatedSearchScope, parseSourceIdParam } from './context.ts';

// --- Resolution & Chunks ---

const resolve_slugs: Operation = {
  name: 'resolve_slugs',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Fuzzy-match a partial name or slug to existing page slugs. Use when a slug is uncertain before get_page, links or tags. Needs read scope. On no matches: search for the name instead.',
  params: {
    partial: { type: 'string', required: true, description: "Partial slug or title text to match, e.g. 'alice-ex' or 'meeting notes'. This is the search text param — there is no `text` param." },
    source_id: {
      type: 'string',
      description:
        "Scope resolution to a single source. Defaults to OperationContext.sourceId; when unset, an unqualified resolve spans every federated source (matching search/get_page). Pass '__all__' to span every source for trusted local callers; for remote callers '__all__' spans only your granted sources.",
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
  description: 'Return a page\'s indexed content chunks (the units search ranks). Use when debugging why search did or did not match a page. Needs read scope. On page_not_found: resolve the slug with resolve_slugs.',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose content chunks to return.' },
  },
  handler: async (ctx, p) => {
    // #2555: route through the canonical scope ladder (federated array >
    // scalar floor > nothing) instead of the pre-#2200 scalar-only pattern —
    // a federated grant could read the page via get_page but got [] here.
    const scope = await readPolicyOpts(ctx);
    // #4352 remediation: a `visibility: private` page's chunks read exactly
    // like a missing page's ([]) for untrusted callers — no existence oracle.
    return ctx.engine.getChunks(p.slug as string, scope);
  },
  scope: 'read',
};


// Ops in EXACTLY the canonical `operations` array order.
export const chunksOperations: Operation[] = [resolve_slugs, get_chunks];
