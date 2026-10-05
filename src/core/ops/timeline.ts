import { submitPageMutation } from '../persistence/page-mutations.ts';
import { WRITE_REQUEST_PARAM } from '../persistence/params.ts';
/**
 * Timeline operation cluster — pure move from operations.ts (v0.46.x
 * tranche 1). Op consts stay module-private; `timelineOperations` below
 * lists them in EXACTLY the order they appear in the canonical `operations`
 * array in ../operations.ts. Never import from '../operations.ts' here
 * (cycle).
 */

import { opError, type Operation } from './contract.ts';
import { opTransport } from './op-fix.ts';
import { readPolicyOpts, scopedPageNotFoundError } from './context.ts';
import {
  enforceSubagentSlugFence,
  enforceClientSlugFence,
} from './context.ts';

// --- Timeline ---

const add_timeline_entry: Operation = {
  name: 'add_timeline_entry',
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'Append a dated entry to a page timeline. Replaying the same entry changes nothing. A page\'s Timeline section needs no call.',
  params: {
    request_id: WRITE_REQUEST_PARAM,
    slug: { type: 'string', description: 'Page slug.', required: true },
    date: { type: 'string', required: true, description: 'YYYY-MM-DD.' },
    summary: { type: 'string', required: true, description: 'One line.' },
    detail: { type: 'string', description: 'Longer text.' },
    source: { type: 'string', description: 'Provenance slug or URL.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    // #2778: same fail-closed slug fence as put_page. add_timeline_entry is
    // subagent-allowlisted (brain-allowlist.ts), so timeline writes must be
    // confined to the same namespace/allow-list as page writes. Runs before
    // the dry-run short-circuit so preview calls surface the same rejection.
    enforceSubagentSlugFence(ctx, p.slug as string, 'add_timeline_entry');
    enforceClientSlugFence(ctx, p.slug as string, 'add_timeline_entry');
    if (ctx.dryRun) return { dry_run: true, action: 'add_timeline_entry', slug: p.slug };
    const date = p.date as string;
    const badDate = (message: string) => opError('invalid_params', message,
      `Nothing was written. Pass ${opTransport(ctx) === 'cli' ? 'the date argument' : '`date`'} as a strict YYYY-MM-DD calendar date (year 1900-2199), for example 2026-04-03.`);
    // Reject anything that isn't a strict YYYY-MM-DD with year 1900-2199 and
    // a real calendar day. PG DATE accepts year 5874897 silently — that's a
    // semantic bug nobody actually wants.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw badDate(`Invalid date format "${date}" (expected YYYY-MM-DD)`);
    }
    const [y, m, d] = date.split('-').map(Number);
    if (y < 1900 || y > 2199 || m < 1 || m > 12 || d < 1 || d > 31) {
      throw badDate(`Invalid date "${date}" (year 1900-2199, month 1-12, day 1-31)`);
    }
    // Round-trip through Date to catch e.g. Feb 30.
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw badDate(`Invalid calendar date "${date}"`);
    }
    return submitPageMutation(ctx, { operation: 'add_timeline_entry', params: p });
  },
  cliHints: { name: 'timeline-add', positional: ['slug', 'date', 'summary'] },
};

const get_timeline: Operation = {
  name: 'get_timeline',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'Get timeline entries for a page, optionally filtered by date window',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose timeline entries to return.' },
    after: { type: 'string', description: 'Return entries on or after this date (YYYY-MM-DD)' },
    before: { type: 'string', description: 'Return entries on or before this date (YYYY-MM-DD)' },
    since: { type: 'string', description: 'Alias for after; accepted for agent callers' },
    until: { type: 'string', description: 'Alias for before; accepted for agent callers' },
    limit: { type: 'number', description: 'Maximum number of timeline entries to return' },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    // #2200: route through sourceScopeOpts so a federated grant reaches the
    // engine via TimelineOpts.sourceIds; scalar/unset unchanged.
    const scope = await readPolicyOpts(ctx);
    const after = typeof p.after === 'string' ? p.after : typeof p.since === 'string' ? p.since : undefined;
    const before = typeof p.before === 'string' ? p.before : typeof p.until === 'string' ? p.until : undefined;
    const limit = typeof p.limit === 'number' ? p.limit : undefined;
    const entries = await ctx.engine.getTimeline(slug, {
      ...scope,
      ...(after ? { after } : {}),
      ...(before ? { before } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (entries.length > 0) return entries;
    // An empty read must still tell "no events" from "no such page". The
    // check reuses the read's scope and #4352 private-page gate, so a page
    // outside the grant or a `visibility: private` page (untrusted callers)
    // throws the same page_not_found as a missing slug — no existence oracle.
    // Soft-deleted pages count as existing: the read above still returns
    // their rows.
    const page = await ctx.engine.getPage(slug, {
      sourceId: scope.sourceId,
      sourceIds: scope.sourceIds,
      excludePrivate: scope.excludePrivate,
      includeDeleted: true,
    });
    if (!page) throw await scopedPageNotFoundError(ctx, slug, scope, { includeDeleted: true });
    return entries;
  },
  scope: 'read',
  cliHints: { name: 'timeline', positional: ['slug'] },
};


// Ops in EXACTLY the canonical `operations` array order.
export const timelineOperations: Operation[] = [add_timeline_entry, get_timeline];
