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
  outputRedaction: 'no_stored_text',
  description: 'Fuzzy-resolve a partial slug to matching page slugs',
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
  outputRedaction: { exempt: 'explicit chunk read by slug, the page-read twin of get_page (CEO-17 raw-read exception)' },
  description: 'Get content chunks for a page. Each chunk carries the source_id and slug of the page it was read from.',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose content chunks to return.' },
    source_id: { type: 'string', description: "Scope the read to a single source (a multi-source brain can hold the same slug in several sources). Defaults to ctx.sourceId / the caller's grant, where chunks from every source in scope that holds the slug are returned, each naming its source_id. '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
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
