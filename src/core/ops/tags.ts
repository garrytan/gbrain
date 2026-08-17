/**
 * Tags operation cluster — pure move from operations.ts (v0.46.x tranche 1).
 * Op consts stay module-private; `tagsOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { enforceClientSlugFence, sourceScopeOpts } from './context.ts';

// --- Tags ---

const add_tag: Operation = {
  name: 'add_tag',
  description: 'Add tag to page',
  params: {
    slug: { type: 'string', required: true, description: "Slug of the page to tag, e.g. 'people/alice-example'." },
    tag: { type: 'string', required: true, description: "Tag to add — a plain string like 'founder' or 'follow-up', not a slug." },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    enforceClientSlugFence(ctx, p.slug as string, 'add_tag');
    if (ctx.dryRun) return { dry_run: true, action: 'add_tag', slug: p.slug, tag: p.tag };
    // v0.31.8 (D7): thread ctx.sourceId.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    await ctx.engine.addTag(p.slug as string, p.tag as string, sourceOpts);
    return { status: 'ok' };
  },
  cliHints: { name: 'tag', positional: ['slug', 'tag'] },
};

const remove_tag: Operation = {
  name: 'remove_tag',
  description: 'Remove tag from page',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page to untag.' },
    tag: { type: 'string', required: true, description: 'Tag to remove (exact match against the tags get_tags returns).' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    enforceClientSlugFence(ctx, p.slug as string, 'remove_tag');
    if (ctx.dryRun) return { dry_run: true, action: 'remove_tag', slug: p.slug, tag: p.tag };
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    await ctx.engine.removeTag(p.slug as string, p.tag as string, sourceOpts);
    return { status: 'ok' };
  },
  cliHints: { name: 'untag', positional: ['slug', 'tag'] },
};

const get_tags: Operation = {
  name: 'get_tags',
  description: 'List tags for a page',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose tags to list.' },
  },
  handler: async (ctx, p) => {
    // #2200: route through sourceScopeOpts so a federated read grant
    // (ctx.auth.allowedSources) reaches the engine, not just scalar ctx.sourceId.
    // Was `ctx.sourceId ? {sourceId} : {}` — a federated client got '{}' →
    // engine fell back to 'default' (functionality gap + cross-source leak).
    const sourceOpts = sourceScopeOpts(ctx);
    return ctx.engine.getTags(p.slug as string, sourceOpts);
  },
  scope: 'read',
  cliHints: { name: 'tags', positional: ['slug'] },
};


// Ops in EXACTLY the canonical `operations` array order.
export const tagsOperations: Operation[] = [add_tag, remove_tag, get_tags];
