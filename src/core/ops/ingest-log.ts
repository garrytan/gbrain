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
import { remotePageAccess } from '../persistence/page-visibility.ts';

/** Row kinds whose source_ref and summary name one page while pages_updated stays empty. */
const PAGE_REF_TYPES = new Set(['facts:absorb', 'write-verify-guard']);

/** A file URL or an absolute, home-relative, relative or Windows path token in a free-form source_ref. */
const HOST_PATH_RE = /(^|\s)(?:file:\/\/|\.{1,2}[\\/]|~?\/|[A-Za-z]:[\\/])\S*/g;

/** A source_ref as a remote reader sees it: a sync row keeps only its commit, an import row names no directory. */
function remoteSourceRef(sourceType: string, ref: string): string {
  if (sourceType === 'git_sync') return ref.replace(/^.*?( @ [0-9a-f]+)?$/s, (_m, commit: string | undefined) => `<local path>${commit ?? ''}`);
  if (sourceType === 'directory') return '<local path>';
  return ref.replace(HOST_PATH_RE, '$1<local path>');
}

// --- Ingest Log ---

const log_ingest: Operation = {
  name: 'log_ingest',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'Record one ingestion event (source type, reference, pages updated, summary) in the brain\'s ingest log. Use after importing or enriching content. Needs write scope.',
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
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'Recent ingestion log entries: what was already imported, and when.',
  params: {
    limit: { type: 'number', description: 'Default 20.' },
  },
  handler: async (ctx, p) => {
    // Source-scope the log for remote callers (scalar grant → single-element
    // array; federated grant → the granted array — linkReadScopeOpts collapse
    // rule). Trusted local callers (remote === false) keep the whole-brain
    // view, matching every other read op's local posture. Ingest summaries
    // can carry another source's private context, so an unscoped remote read
    // is a cross-source leak.
    const scope = ctx.remote !== false ? linkReadScopeOpts(ctx) : {};
    const rows = await ctx.engine.getIngestLog({
      limit: clampSearchLimit(p.limit as number | undefined, 20, 50),
      ...(scope.sourceIds ? { sourceIds: scope.sourceIds } : scope.sourceId ? { sourceIds: [scope.sourceId] } : {}),
    });
    if (ctx.remote === false) return rows;
    // GBRA-431: a remote reader sees a row only when every page it names is a live page the reader can read (its
    // summary may describe any of them), with no host filesystem path (a sync row's source_ref names the checkout).
    // A row that names its page in source_ref alone is checked on that page; one whose ref names a page the reader
    // cannot read is dropped too.
    const { known, readable } = await remotePageAccess(ctx.engine, rows.flatMap(r => [...(r.pages_updated ?? []), r.source_ref].map(slug => ({ source_id: r.source_id, slug }))));
    const key = (r: { source_id: string }, slug: string) => `${r.source_id}\u0000${slug}`;
    return rows.filter(r => {
      const pages = r.pages_updated ?? [];
      if (!pages.every(slug => readable.has(key(r, slug)))) return false;
      if (pages.length === 0 && PAGE_REF_TYPES.has(r.source_type)) return readable.has(key(r, r.source_ref));
      return !known.has(key(r, r.source_ref)) || readable.has(key(r, r.source_ref));
    }).map(r => ({ ...r, source_ref: remoteSourceRef(r.source_type, r.source_ref) }));
  },
  scope: 'read',
};


// Ops in EXACTLY the canonical `operations` array order.
export const ingestLogOperations: Operation[] = [log_ingest, get_ingest_log];
