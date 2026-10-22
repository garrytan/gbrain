/**
 * Orphans operation cluster — pure move from operations.ts (v0.46.x
 * tranche 2). Op consts stay module-private; `orphansOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import { assertSourceInCallerScope, readPolicyOpts } from './context.ts';
import type { Operation } from './contract.ts';
import { invalidParam } from './op-fix.ts';
import { encodeListingCursor, LISTING_DEFAULT_LIMIT, LISTING_MAX_LIMIT, pageSortedRows } from '../bounded-listing.ts';

// --- Orphans ---

export const ORPHANS_DEFAULT_LIMIT = LISTING_DEFAULT_LIMIT;
export const ORPHANS_MAX_LIMIT = LISTING_MAX_LIMIT;

const find_orphans: Operation = {
  name: 'find_orphans',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'Find disconnected pages. Default mode "islanded" (no live inbound AND no outbound link) matches get_health.orphan_pages; mode "inbound" is the legacy no-inbound-only view. Essential for content enrichment cycles.',
  params: {
    include_pseudo: {
      type: 'boolean',
      description: 'Include auto-generated and pseudo pages (default: false)',
    },
    mode: {
      type: 'string',
      description: "#4524: orphan definition — 'islanded' (default; agrees with get_health.orphan_pages and doctor) or 'inbound' (legacy: no inbound links, even when the page links out).",
    },
    source_id: {
      type: 'string',
      description: 'Only orphans from this source (it must be inside your source grant). Each row carries source_id and type.',
    },
    limit: {
      type: 'number',
      description: `Rows per page (default ${ORPHANS_DEFAULT_LIMIT}, max ${ORPHANS_MAX_LIMIT}); total_orphans counts every orphan, complete says whether this page holds the rest, and next_cursor (or next_offset) names the next page.`,
    },
    offset: { type: 'number', description: 'Skip the first N orphans (ordered by source_id, then slug).' },
    cursor: { type: 'string', description: 'next_cursor from the previous page, with the same filters (instead of offset).' },
    count_only: { type: 'boolean', description: 'Return the totals with no rows.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findOrphans } = await import('../../commands/orphans.ts');
    // #4524: validate rather than silently coerce — an unknown mode must not
    // quietly fall back to the default and misreport the orphan set.
    const mode = p.mode === undefined ? undefined : (p.mode as string);
    if (mode !== undefined && mode !== 'inbound' && mode !== 'islanded') {
      throw invalidParam(ctx, 'find_orphans', 'mode', 'find_orphans: invalid mode — use \'inbound\' or \'islanded\'', { choices: ['islanded', 'inbound'] });
    }
    // v0.41.29.0 (Codex F8): scope by the caller's source (ctx.sourceId /
    // ctx.auth.allowedSources) via the canonical sourceScopeOpts ladder.
    // Pre-fix, find_orphans returned brain-wide orphans regardless of a
    // source-bound OAuth client's scope — a read leak in the v0.34.1
    // source-isolation class. Local CLI callers route through `gbrain
    // orphans --source` instead (ctx.remote === false → empty scope here).
    // #5891: a named source narrows the caller's scope and never widens it.
    const named = p.source_id === undefined ? undefined : String(p.source_id);
    if (named !== undefined) assertSourceInCallerScope(ctx, named);
    const scope = named !== undefined ? await readPolicyOpts(ctx, { sourceId: named }) : await readPolicyOpts(ctx);
    const limit = p.limit === undefined ? ORPHANS_DEFAULT_LIMIT : Number(p.limit);
    const offset = p.offset === undefined ? 0 : Number(p.offset);
    const limitOk = Number.isInteger(limit) && limit >= 1 && limit <= ORPHANS_MAX_LIMIT;
    if (!limitOk || !Number.isInteger(offset) || offset < 0) {
      throw invalidParam(ctx, 'find_orphans', limitOk ? 'offset' : 'limit',
        `find_orphans: limit must be 1-${ORPHANS_MAX_LIMIT} and offset a non-negative integer`,
        limitOk ? { def: find_orphans.params.offset, example: 0 } : { def: find_orphans.params.limit, example: ORPHANS_DEFAULT_LIMIT });
    }
    const result = await findOrphans(ctx.engine, {
      includePseudo: (p.include_pseudo as boolean) || false,
      ...(mode ? { mode } : {}),
      ...scope,
    });
    const cursor = p.cursor === undefined ? undefined : String(p.cursor);
    if (cursor !== undefined && offset !== 0) {
      throw invalidParam(ctx, 'find_orphans', 'cursor', 'find_orphans: pass cursor or offset, not both', { def: find_orphans.params.cursor });
    }
    // #7246: one cursor kind per filter set, so a cursor never resumes a different listing.
    const kind = `find_orphans:${mode ?? 'islanded'}:${named ?? '*'}:${p.include_pseudo === true ? 'all' : 'policy'}`;
    const key = (row: { source_id?: string; slug: string }) => [row.source_id ?? '', row.slug];
    if (p.count_only === true) {
      return { ...result, orphans: [], limit, offset, next_offset: null, complete: result.total_orphans === 0, next_cursor: null };
    }
    if (cursor !== undefined) {
      const page = pageSortedRows(result.orphans, key, { limit, cursor }, kind);
      return { ...result, orphans: page.rows, limit, offset, next_offset: null, complete: page.complete, next_cursor: page.next_cursor };
    }
    const ordered = pageSortedRows(result.orphans, key, { limit: null }, kind).rows;
    const rows = ordered.slice(offset, offset + limit);
    const next = offset + limit < ordered.length ? offset + limit : null;
    return { ...result, orphans: rows, limit, offset, next_offset: next, complete: next === null,
      next_cursor: next === null ? null : encodeListingCursor(kind, key(rows[rows.length - 1]!)) };
  },
  cliHints: { name: 'orphans', hidden: true },
};


// Ops in EXACTLY the canonical `operations` array order.
export const orphansOperations: Operation[] = [find_orphans];
