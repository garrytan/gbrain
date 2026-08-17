/**
 * Ingest Log operation cluster — pure move from operations.ts (v0.46.x
 * tranche 2). Op consts stay module-private; `ingestLogOperations` below
 * lists them in EXACTLY the order they appear in the canonical `operations`
 * array in ../operations.ts. Never import from '../operations.ts' here
 * (cycle).
 */

import type { Operation } from './contract.ts';
import { clampSearchLimit } from '../engine.ts';
import { linkReadScopeOpts } from './context.ts';

// --- Ingest Log ---

const log_ingest: Operation = {
  name: 'log_ingest',
  description: 'Log an ingestion event',
  params: {
    source_type: { type: 'string', required: true, description: "Kind of ingest source, e.g. 'email', 'meeting', 'rss', 'api'." },
    source_ref: { type: 'string', required: true, description: 'Identifier of the ingested item — a URL, message id, or file path.' },
    pages_updated: { type: 'array', required: true, items: { type: 'string' }, description: 'Slugs of the pages this ingest created or updated.' },
    summary: { type: 'string', required: true, description: 'One-line human-readable summary of what was ingested.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'log_ingest' };
    await ctx.engine.logIngest({
      // Thread ctx.sourceId (same pattern as get_chunks/get_page above): on a
      // multi-source brain the ingest event must be attributed to the caller's
      // source, not the shared 'default' bucket. Absent sourceId still falls to
      // the engine's 'default' (single-source brains unchanged).
      ...(ctx.sourceId ? { source_id: ctx.sourceId } : {}),
      source_type: p.source_type as string,
      source_ref: p.source_ref as string,
      pages_updated: p.pages_updated as string[],
      summary: p.summary as string,
    });
    return { status: 'ok' };
  },
};

const get_ingest_log: Operation = {
  name: 'get_ingest_log',
  description: 'Get recent ingestion log entries',
  params: {
    limit: { type: 'number', description: 'Max entries (default 20)' },
  },
  handler: async (ctx, p) => {
    // Source-scope the log for remote callers (scalar grant → single-element
    // array; federated grant → the granted array — linkReadScopeOpts collapse
    // rule). Trusted local callers (remote === false) keep the whole-brain
    // view, matching every other read op's local posture. Ingest summaries
    // can carry another source's private context, so an unscoped remote read
    // is a cross-source leak.
    const scope = ctx.remote !== false ? linkReadScopeOpts(ctx) : {};
    return ctx.engine.getIngestLog({
      limit: clampSearchLimit(p.limit as number | undefined, 20, 50),
      ...(scope.sourceIds ? { sourceIds: scope.sourceIds } : scope.sourceId ? { sourceIds: [scope.sourceId] } : {}),
    });
  },
  scope: 'read',
};


// Ops in EXACTLY the canonical `operations` array order.
export const ingestLogOperations: Operation[] = [log_ingest, get_ingest_log];
