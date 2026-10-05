/**
 * Resolution & Chunks operation cluster — pure move from operations.ts
 * (v0.46.x tranche 2). Op consts stay module-private; `chunksOperations`
 * below lists them in EXACTLY the order they appear in the canonical
 * `operations` array in ../operations.ts. Never import from
 * '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { readPolicyOpts } from './context.ts';
import { assertExplicitSourceLive, federatedSearchScope, parseSourceIdParam } from './context.ts';
import { ALL_SOURCES } from '../source-id.ts';

// --- Resolution & Chunks ---

const resolve_slugs: Operation = {
  name: 'resolve_slugs',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Fuzzy-match a partial slug or title to page slugs. Use when a slug is uncertain. Needs read scope.',
  params: {
    partial: { type: 'string', required: true, description: "Partial slug or title, e.g. 'alice-ex'." },
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
  description: 'Return a page\'s indexed content chunks (the units search ranks). Each chunk names its source_id and slug. Use when debugging why search did or did not match a page. Needs read scope. On page_not_found: resolve the slug with resolve_slugs.',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose content chunks to return.' },
    source_id: { type: 'string', description: "One source, or '__all__'. Unset: every source in scope that holds the slug." },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    // #2555: route through the canonical scope ladder (federated array >
    // scalar floor > nothing) instead of the pre-#2200 scalar-only pattern —
    // a federated grant could read the page via get_page but got [] here.
    // get_page parity (#4329): an explicit source_id is grant-checked by
    // federatedSearchScope and narrows the read; without one the scope is
    // unchanged. A multi-source scope can match the slug in several sources,
    // so every row names the source it was read from.
    const sourceIdParam = parseSourceIdParam(p.source_id, 'get_chunks', { allowAll: true });
    const scope = sourceIdParam === undefined
      ? await readPolicyOpts(ctx)
      : await readPolicyOpts(ctx, federatedSearchScope(ctx, sourceIdParam));
    if (sourceIdParam !== undefined) await assertExplicitSourceLive(ctx, sourceIdParam);
    // A trusted local '__all__' resolves to no source bound at all; the
    // engine read would fall back to 'default', so name every live source.
    if (sourceIdParam === ALL_SOURCES && scope.sourceIds === undefined && scope.sourceId === undefined) {
      scope.sourceIds = (await ctx.engine.listAllSources()).map(source => source.id);
    }
    // #4352 remediation: a `visibility: private` page's chunks read exactly
    // like a missing page's ([]) for untrusted callers — no existence oracle.
    const chunks = await ctx.engine.getChunks(slug, scope);
    return chunks.map(chunk => ({ ...chunk, slug }));
  },
  scope: 'read',
};


// Ops in EXACTLY the canonical `operations` array order.
export const chunksOperations: Operation[] = [resolve_slugs, get_chunks];
