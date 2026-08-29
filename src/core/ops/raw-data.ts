/**
 * Raw Data operation cluster — pure move from operations.ts (v0.46.x
 * tranche 2). Op consts stay module-private; `rawDataOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { enforceClientSlugFence, sourceScopeOpts } from './context.ts';
import { slugHiddenFromCaller } from '../search/private-visibility.ts';

// --- Raw Data ---

const put_raw_data: Operation = {
  name: 'put_raw_data',
  description: 'Store raw API response data for a page',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page to attach the raw data to.' },
    source: { type: 'string', required: true, description: 'Data source (e.g., crustdata, happenstance)' },
    data: { type: 'object', required: true, description: 'Raw data object' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    enforceClientSlugFence(ctx, p.slug as string, 'put_raw_data');
    if (ctx.dryRun) return { dry_run: true, action: 'put_raw_data', slug: p.slug, source: p.source };
    // v0.31.8 (D7 + D21): thread ctx.sourceId.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    await ctx.engine.putRawData(p.slug as string, p.source as string, p.data as object, sourceOpts);
    return { status: 'ok' };
  },
};

const get_raw_data: Operation = {
  name: 'get_raw_data',
  description: 'Retrieve raw data for a page',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose raw data to fetch.' },
    source: { type: 'string', description: 'Filter by source' },
  },
  handler: async (ctx, p) => {
    const scope = sourceScopeOpts(ctx);
    // #4352 remediation: a `visibility: private` page's raw data reads
    // exactly like a missing page's ([]) for untrusted callers — no
    // existence oracle.
    if (await slugHiddenFromCaller(ctx.engine, ctx.remote, p.slug as string, scope)) return [];
    return ctx.engine.getRawData(p.slug as string, p.source as string | undefined, scope);
  },
  scope: 'read',
};


// Ops in EXACTLY the canonical `operations` array order.
export const rawDataOperations: Operation[] = [put_raw_data, get_raw_data];
