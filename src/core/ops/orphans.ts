/**
 * Orphans operation cluster — pure move from operations.ts (v0.46.x
 * tranche 2). Op consts stay module-private; `orphansOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { sourceScopeOpts } from './context.ts';

// --- Orphans ---

const find_orphans: Operation = {
  name: 'find_orphans',
  description: 'Find pages with no inbound wikilinks. Essential for content enrichment cycles.',
  params: {
    include_pseudo: {
      type: 'boolean',
      description: 'Include auto-generated and pseudo pages (default: false)',
    },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findOrphans } = await import('../../commands/orphans.ts');
    // v0.41.29.0 (Codex F8): scope by the caller's source (ctx.sourceId /
    // ctx.auth.allowedSources) via the canonical sourceScopeOpts ladder.
    // Pre-fix, find_orphans returned brain-wide orphans regardless of a
    // source-bound OAuth client's scope — a read leak in the v0.34.1
    // source-isolation class. Local CLI callers route through `gbrain
    // orphans --source` instead (ctx.remote === false → empty scope here).
    return findOrphans(ctx.engine, {
      includePseudo: (p.include_pseudo as boolean) || false,
      ...sourceScopeOpts(ctx),
    });
  },
  cliHints: { name: 'orphans', hidden: true },
};


// Ops in EXACTLY the canonical `operations` array order.
export const orphansOperations: Operation[] = [find_orphans];
