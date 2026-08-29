/**
 * Orphans operation cluster — pure move from operations.ts (v0.46.x
 * tranche 2). Op consts stay module-private; `orphansOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { sourceScopeOpts } from './context.ts';
import { dropPrivateOnlyRows } from '../search/private-visibility.ts';

// --- Orphans ---

const find_orphans: Operation = {
  name: 'find_orphans',
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
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findOrphans } = await import('../../commands/orphans.ts');
    // #4524: validate rather than silently coerce — an unknown mode must not
    // quietly fall back to the default and misreport the orphan set.
    const mode = p.mode === undefined ? undefined : (p.mode as string);
    if (mode !== undefined && mode !== 'inbound' && mode !== 'islanded') {
      throw new Error(`find_orphans: invalid mode "${mode}" — use 'inbound' or 'islanded'`);
    }
    // v0.41.29.0 (Codex F8): scope by the caller's source (ctx.sourceId /
    // ctx.auth.allowedSources) via the canonical sourceScopeOpts ladder.
    // Pre-fix, find_orphans returned brain-wide orphans regardless of a
    // source-bound OAuth client's scope — a read leak in the v0.34.1
    // source-isolation class. Local CLI callers route through `gbrain
    // orphans --source` instead (ctx.remote === false → empty scope here).
    const scope = sourceScopeOpts(ctx);
    const result = await findOrphans(ctx.engine, {
      includePseudo: (p.include_pseudo as boolean) || false,
      ...(mode ? { mode } : {}),
      ...scope,
    });
    // An orphaned `visibility: private` page's slug + title must not reach
    // remote readers (same read-leak class as the delta page arm; same
    // helper family as the get_page/resolve_slugs gates). Hidden orphans
    // VANISH from every published counter — total_pages and total_linkable
    // shrink with them and `excluded` is left alone. Folding them into
    // `excluded` instead would relocate the count, not hide it: with
    // include_pseudo:true the unfiltered op guarantees excluded === 0, so a
    // non-zero value would be an exact one-call private-orphan-count oracle.
    // Subtracting from both denominators keeps doctor-remote's
    // total_orphans/total_linkable ratio and the excluded ===
    // total_pages - total_linkable invariant coherent over the
    // world-visible universe.
    const kept = await dropPrivateOnlyRows(ctx.engine, ctx.remote, result.orphans, o => o.slug, scope);
    const hiddenCount = result.orphans.length - kept.length;
    if (hiddenCount > 0) {
      result.orphans = kept;
      result.total_orphans = kept.length;
      result.total_pages -= hiddenCount;
      result.total_linkable -= hiddenCount;
    }
    return result;
  },
  cliHints: { name: 'orphans', hidden: true },
};


// Ops in EXACTLY the canonical `operations` array order.
export const orphansOperations: Operation[] = [find_orphans];
