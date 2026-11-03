/**
 * Tags operation cluster — pure move from operations.ts (v0.46.x tranche 1).
 * Op consts stay module-private; `tagsOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation, OperationContext } from './contract.ts';
import { fenceTranscriptText, quotesStored, unquoteTranscriptText } from '../search/transcript-quote.ts';
import { enforceClientSlugFence, readPolicyOpts } from './context.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { MERGE_PRECONDITION_PARAMS, WRITE_REQUEST_PARAM } from '../persistence/params.ts';

// --- Tags ---

/** #8384: a remote caller's tag copied out of a quoted read (get_tags, get_page, fetch) names the tag, not its fence. */
function unquotedTag(ctx: OperationContext, p: Record<string, unknown>): Record<string, unknown> {
  return ctx.remote === false || typeof p.tag !== 'string' || typeof p.slug !== 'string' ? p : { ...p, tag: unquoteTranscriptText(p.tag, p.slug.toLowerCase()) };
}

const add_tag: Operation = {
  name: 'add_tag',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Add one tag to a page (idempotent). Use when filing or grouping pages for later get_tags / list_pages tag filters. Needs write scope. On page_not_found: resolve the slug with resolve_slugs, then call again.',
  params: {
    request_id: WRITE_REQUEST_PARAM,
    ...MERGE_PRECONDITION_PARAMS,
    slug: { type: 'string', required: true, description: "Slug of the page to tag, e.g. 'people/alice-example'." },
    tag: { type: 'string', required: true, description: "Tag to add — a plain string like 'founder' or 'follow-up', not a slug." },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    enforceClientSlugFence(ctx, p.slug as string, 'add_tag');
    if (ctx.dryRun) return { dry_run: true, action: 'add_tag', slug: p.slug, tag: p.tag };
    // v0.31.8 (D7): thread ctx.sourceId.
    return submitPageMutation(ctx, { operation: 'add_tag', params: unquotedTag(ctx, p) });
  },
  cliHints: { name: 'tag', positional: ['slug', 'tag'] },
};

const remove_tag: Operation = {
  name: 'remove_tag',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Remove one tag from a page. Use when a tag was wrong or no longer applies. Needs write scope. On page_not_found: resolve the slug with resolve_slugs, then call again.',
  params: {
    request_id: WRITE_REQUEST_PARAM,
    ...MERGE_PRECONDITION_PARAMS,
    slug: { type: 'string', required: true, description: 'Slug of the page to untag.' },
    tag: { type: 'string', required: true, description: 'Tag to remove (exact match against the tags get_tags returns).' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    enforceClientSlugFence(ctx, p.slug as string, 'remove_tag');
    if (ctx.dryRun) return { dry_run: true, action: 'remove_tag', slug: p.slug, tag: p.tag };
    return submitPageMutation(ctx, { operation: 'remove_tag', params: unquotedTag(ctx, p) });
  },
  cliHints: { name: 'untag', positional: ['slug', 'tag'] },
};

const get_tags: Operation = {
  name: 'get_tags',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'List the tags on one page. Use when checking how a page is filed before adding or removing tags. Needs read scope. On page_not_found: resolve the slug with resolve_slugs.',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose tags to list.' },
  },
  handler: async (ctx, p) => {
    // #2200: route through the source scope (via readPolicyOpts) so a federated read grant
    // (ctx.auth.allowedSources) reaches the engine, not just scalar ctx.sourceId.
    // Was `ctx.sourceId ? {sourceId} : {}` — a federated client got '{}' →
    // engine fell back to 'default' (functionality gap + cross-source leak).
    // Untrusted callers never learn a private or soft-deleted page's tags
    // (readPolicyOpts resolves the operator's private-pages posture).
    const policy = await readPolicyOpts(ctx);
    const tags = await ctx.engine.getTags(p.slug as string, {
      sourceId: policy.sourceId,
      sourceIds: policy.sourceIds,
      excludePrivate: policy.excludePrivate,
      liveOnly: ctx.remote !== false,
    });
    if (ctx.remote === false || tags.length === 0) return tags;
    // #8384: a remote reader gets a quoted page's tags quoted, as get_page and fetch return them.
    const pages = await ctx.engine.executeRaw<{ type: string | null; trust_tier: string | null }>(
      'SELECT type, trust_tier FROM pages WHERE slug = $1 AND source_id = ANY($2::text[]) AND deleted_at IS NULL',
      [p.slug, policy.sourceIds?.length ? policy.sourceIds : [policy.sourceId ?? 'default']]);
    return pages.length && pages.every(r => !quotesStored(r.type, r.trust_tier)) ? tags : tags.map(t => fenceTranscriptText(t, p.slug as string));
  },
  scope: 'read',
  cliHints: { name: 'tags', positional: ['slug'] },
};


// Ops in EXACTLY the canonical `operations` array order.
export const tagsOperations: Operation[] = [add_tag, remove_tag, get_tags];
