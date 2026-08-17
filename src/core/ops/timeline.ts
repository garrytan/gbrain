/**
 * Timeline operation cluster — pure move from operations.ts (v0.46.x
 * tranche 1). Op consts stay module-private; `timelineOperations` below
 * lists them in EXACTLY the order they appear in the canonical `operations`
 * array in ../operations.ts. Never import from '../operations.ts' here
 * (cycle).
 */

import type { Operation } from './contract.ts';
import { enforceSubagentSlugFence, enforceClientSlugFence, sourceScopeOpts } from './context.ts';

// --- Timeline ---

const add_timeline_entry: Operation = {
  name: 'add_timeline_entry',
  description: 'Add timeline entry to a page',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose timeline to append to.' },
    date: { type: 'string', required: true, description: "Entry date, strict YYYY-MM-DD (e.g. '2026-04-03'). Timestamps and non-calendar dates are rejected." },
    summary: { type: 'string', required: true, description: 'One-line summary of what happened on that date.' },
    detail: { type: 'string', description: 'Longer free-text detail behind the summary.' },
    source: { type: 'string', description: "Provenance ref for the entry, e.g. a meeting slug like 'meetings/2026-04-03' or a URL." },
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
    // Reject anything that isn't a strict YYYY-MM-DD with year 1900-2199 and
    // a real calendar day. PG DATE accepts year 5874897 silently — that's a
    // semantic bug nobody actually wants.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid date format "${date}" (expected YYYY-MM-DD)`);
    }
    const [y, m, d] = date.split('-').map(Number);
    if (y < 1900 || y > 2199 || m < 1 || m > 12 || d < 1 || d > 31) {
      throw new Error(`Invalid date "${date}" (year 1900-2199, month 1-12, day 1-31)`);
    }
    // Round-trip through Date to catch e.g. Feb 30.
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error(`Invalid calendar date "${date}"`);
    }
    // v0.31.8 (D7): thread ctx.sourceId.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    await ctx.engine.addTimelineEntry(p.slug as string, { // gbrain-allow-direct-insert: add_timeline_entry MCP op is the explicit canonical surface for manual timeline entries
      date,
      source: (p.source as string) || '',
      summary: p.summary as string,
      detail: (p.detail as string) || '',
    }, sourceOpts);
    return { status: 'ok' };
  },
  cliHints: { name: 'timeline-add', positional: ['slug', 'date', 'summary'] },
};

const get_timeline: Operation = {
  name: 'get_timeline',
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
    // #2200: route through sourceScopeOpts so a federated grant reaches the
    // engine via TimelineOpts.sourceIds; scalar/unset unchanged.
    const after = typeof p.after === 'string' ? p.after : typeof p.since === 'string' ? p.since : undefined;
    const before = typeof p.before === 'string' ? p.before : typeof p.until === 'string' ? p.until : undefined;
    const limit = typeof p.limit === 'number' ? p.limit : undefined;
    return ctx.engine.getTimeline(p.slug as string, {
      ...sourceScopeOpts(ctx),
      ...(after ? { after } : {}),
      ...(before ? { before } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  },
  scope: 'read',
  cliHints: { name: 'timeline', positional: ['slug'] },
};


// Ops in EXACTLY the canonical `operations` array order.
export const timelineOperations: Operation[] = [add_timeline_entry, get_timeline];
