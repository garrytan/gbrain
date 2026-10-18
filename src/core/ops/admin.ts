import { PAGE_MUTATION_PARAMS } from '../persistence/params.ts';
import { readPolicyOpts } from './context.ts';
import { attributeVersions, canReadWriteAttribution } from './attribution.ts';
import { GET_VERSIONS_DEFAULT_LIMIT, GET_VERSIONS_REMOTE_MAX_LIMIT, pagingLimit, reportVersionPage } from './read-paging.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
/**
 * Admin operation cluster — pure move from operations.ts (v0.46.x tranche 2).
 * Op consts stay module-private; `adminOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts (run_doctor / get_versions / revert_version were defined
 * under the skill-catalog divider in the original file but have always
 * occupied the Admin slots of the array — the array order is the contract).
 * Never import from '../operations.ts' here (cycle).
 */

import type { Operation, OperationContext } from './contract.ts';
import { opError } from './contract.ts';
import { enforceClientSlugFence, sourceScopeOpts } from './context.ts';
import { VERSION } from '../../version.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../search/embedding-column.ts';
import { memoizedHealth } from '../health-memo.ts';
import { LARGE_PAGES_CAPABILITY } from './get-page-body.ts';
import { isSegmentedPage, pageBodyBytes } from '../page-body/page-shape.ts';
import { openSegmentedBody } from '../page-body/read-range.ts';
import { segmentedReadDocument } from '../page-window/segmented.ts';
import { getVersionsKnownAsOf, KNOWN_AS_OF_PARAM, VERSIONS_DIFF_PARAM } from './known-as-of.ts';

// --- Admin ---

/**
 * #4592: the #4433 ladder, shared by the three diagnostic aggregates
 * (get_stats / get_health / get_brain_identity). Trusted local CLI keeps the
 * brain-wide view; every remote caller is confined to sourceScopeOpts(ctx)
 * (federated array > scalar > the unmatchable __all__ sentinel, which
 * fail-closes to zeros). Aggregates leak by subtraction, so they scope like
 * reads.
 */
function diagnosticScope(ctx: OperationContext): { sourceId?: string; sourceIds?: string[] } {
  return ctx.remote === false ? {} : sourceScopeOpts(ctx);
}

const get_stats: Operation = {
  name: 'get_stats',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Brain statistics (page count, chunk count, etc.) — remote callers see counters confined to their source grant.',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getStats(diagnosticScope(ctx));
  },
  scope: 'admin',
  cliHints: { name: 'stats' },
};

const get_health: Operation = {
  name: 'get_health',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Brain health dashboard (embed coverage, stale pages, orphans) — remote callers see counters confined to their source grant. Includes a `migrations {pending, pending_fresh_install, partial, wedged, skipped_future}` block from the host migration ledger so remote agents can detect wedged/outstanding host migrations without shelling into the brain host (pending_fresh_install = setup a new brain has not run yet, not a broken upgrade). `computed_at` is when the counters were read: a repeat call within `health.cache_ttl_ms` (default 30000; env GBRAIN_HEALTH_CACHE_TTL_MS; 0 disables) with no page or config change returns the memoized numbers.',
  params: {},
  handler: async (ctx) => {
    // The `migrations` block below stays GLOBAL for scoped callers by
    // decision: it is a host filesystem ledger with no per-source semantics,
    // and a wedged host migration is exactly what a remote agent needs to
    // see to explain degraded behavior.
    // F4a (O-ENG-13): memoized per engine, scope, config generation and page
    // clock (src/core/health-memo.ts); engine.getHealth itself stays uncached.
    const scope = diagnosticScope(ctx);
    const health = await memoizedHealth(ctx.engine, scope, async () => {
      const counters = await ctx.engine.getHealth(scope);
      // #4732: name the column embed_coverage and missing_embeddings measured
      // (the same resolution getHealth uses), so a 0% coverage on an embedded
      // brain points at a mis-routed column instead of a paid re-embed.
      const { name: embedding_column } = await resolveActiveEmbeddingColumnFromEngine(ctx.engine, { fallbackToLegacy: true });
      return { ...counters, embedding_column };
    });
    // TODOS:4063 — composed at the OP layer (not BrainEngine.getHealth):
    // the ledger is a filesystem JSONL, engine-agnostic; growing the engine
    // interface would force both engines to duplicate a file read.
    // Best-effort like the doctor's ledger read: a corrupt/unreadable ledger
    // degrades the field, never the health call.
    let migrations: unknown;
    try {
      const { declinedMigrations, migrationLedgerSummary } = await import('../migration-ledger.ts');
      const { VERSION } = await import('../../version.ts');
      migrations = migrationLedgerSummary(VERSION, await declinedMigrations(ctx.engine));
    } catch {
      migrations = { error: 'ledger_unreadable' };
    }
    return { ...health, migrations };
  },
  scope: 'admin',
  cliHints: { name: 'health' },
};

/**
 * v0.31.1 (Issue #734): lightweight identity packet for the thin-client
 * banner. Read-scope so any authenticated client can surface "thin-client →
 * <host> · brain: 102k pages, 265k chunks · v0.31.1" without needing admin.
 *
 * Reuses engine.getStats() for counters (banner cache TTL bounds frequency
 * to ≤1/60s per CLI process; well below the Fly.io health-check cadence
 * that motivated the `getStats` cost warning in CLAUDE.md).
 *
 * No CLI surface (no cliHints) — this op exists only for thin-client banner
 * data. `last_sync_iso` deferred (no canonical source field today; would
 * need autopilot cycle to write a config key — TODO in v0.31.x).
 */
const get_brain_identity: Operation = {
  name: 'get_brain_identity',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Brain identity + counters for thin-client banner — remote callers see counters confined to their source grant. Returns version, engine kind, page/chunk counts and capabilities (large_pages_v1: windowed get_page). Read-scope.',
  params: {},
  handler: async (ctx) => {
    // #4592: read-scope + unscoped counters made this op the quiet third
    // aggregate leak (the issue named only stats/health). Same ladder.
    const stats = await ctx.engine.getStats(diagnosticScope(ctx));
    // v0.42 self-upgrade: surface a pending update on the thin-client banner
    // (bonus channel; the CLI stderr marker + `gbrain self-upgrade` are the
    // load-bearing surface). Cache-read-only, no network, fail-open.
    let update_available = false;
    let latest_version: string | null = null;
    try {
      const su = await import('../self-upgrade.ts');
      // Shared stale/foreign-cache guard (pendingUpgradeVersion): only an
      // upgrade strictly newer than the RUNNING version counts.
      const latest = su.pendingUpgradeVersion(VERSION, Date.now());
      if (latest) {
        update_available = true;
        latest_version = latest;
      }
    } catch {
      /* never let the banner break the op */
    }
    return {
      version: VERSION,
      engine: ctx.engine.kind,
      page_count: stats.page_count,
      chunk_count: stats.chunk_count,
      last_sync_iso: null as string | null,
      update_available,
      latest_version,
      capabilities: [LARGE_PAGES_CAPABILITY],
    };
  },
  scope: 'read',
  // intentionally no cliHints — banner-only op
};

/**
 * Multi-topology v1 (Tier B): structured doctor report for remote callers.
 *
 * First read-only diagnostic op exposed over HTTP MCP. Wraps the focused
 * thin-client check set in `src/commands/doctor.ts:doctorReportRemote()` and
 * returns the structured `DoctorReport` JSON verbatim. The matching client-
 * side renderer lives in `src/commands/remote.ts` (used by `gbrain remote
 * doctor`). Local doctor is unchanged — operators on the host still get the
 * full check set.
 *
 * scope=admin because some checks expose system-state (queue depth, schema
 * version) that read-only consumers don't need. localOnly=false so HTTP
 * callers can invoke it. No mutation; safe to call repeatedly.
 *
 * Precedent: doctor only. Generalizing to lint/integrity/orphans is filed as
 * follow-up work pending demand.
 */
const run_doctor: Operation = {
  name: 'run_doctor',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Run brain health checks and return a structured DoctorReport (thin-client doctor surface). tier "ops": only the operational sections under a 4 s deadline; only: just the named checks.',
  params: {
    tier: { type: 'string', enum: ['ops'], description: 'ops: capacity, write failures, embedding state, sync movement, compaction, serve build and schema pack, under one 4 s deadline. Omit for the focused remote report.' },
    only: { type: 'array', items: { type: 'string' }, description: 'Run just these checks (doctor check names, for example persistence_capacity).' },
  },
  handler: async (ctx, p) => {
    if (p.tier !== undefined || p.only !== undefined) return (await import('../../commands/doctor/remote-tier.ts')).runRemoteDoctorTier(ctx, p);
    const { doctorReportRemote } = await import('../../commands/doctor.ts');
    // Source isolation (cross-model P1): a source-bound caller's report must
    // not aggregate other sources' activity. Scope-aware checks (connection,
    // brain_score, chronicle_projection_health, multi_source_drift,
    // volunteer_channels, extract_atoms_backlog,
    // contextual_retrieval_coverage) filter on these ids;
    // unscoped ctx = brain-wide.
    const scope = sourceScopeOpts(ctx);
    const sourceIds = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : undefined);
    const transport = ctx.remote === false ? 'cli' : ctx.transport ?? 'http';
    return doctorReportRemote(ctx.engine, { sourceIds, remote: ctx.remote,
      render: { transport, isCallable: (op) => op === 'run_doctor', preapproved: () => false } });
  },
  scope: 'admin',
  localOnly: false,
};

const get_versions: Operation = {
  name: 'get_versions',
  mutating: false,
  idempotent: true,
  outputRedaction: { exempt: 'full page version snapshots by slug; a page read governed by visibility like get_page (CEO-17)' },
  description: `Page version history, newest snapshot first: metadata only (id, snapshot_at, title, type, tags, frontmatter) for the newest ${GET_VERSIONS_DEFAULT_LIMIT} versions by default. Pass include_body: true for each version's compiled_truth and timeline, and a larger limit (at most ${GET_VERSIONS_REMOTE_MAX_LIMIT} over MCP) for older versions. Trusted local and admin callers also get written_by and archived_by (who wrote each snapshot and whose write archived it). revert_version takes the id field.`,
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose version history to list.' },
    limit: { type: 'number', description: `Return only the newest N versions (a positive integer). Default ${GET_VERSIONS_DEFAULT_LIMIT}; MCP callers are capped at ${GET_VERSIONS_REMOTE_MAX_LIMIT}.` },
    include_body: { type: 'boolean', description: 'true adds compiled_truth and timeline to every version. Default false (metadata only).' },
    known_as_of: { ...KNOWN_AS_OF_PARAM, description: 'Recorded time: the validity intervals this brain had recorded by this ISO 8601 instant, from the belief ledger. Not as_of, which is valid time (a date).' },
    diff: VERSIONS_DIFF_PARAM,
    source_id: { type: 'string', description: 'With known_as_of: the source.', fullSurfaceOnly: true },
  },
  handler: async (ctx, p) => {
    // #5234: the bound and the body projection run in SQL, after the scope and
    // privacy predicates, so a bounded or metadata-only read never loads more
    // than it returns and never widens what the caller may see.
    // Large pages: metadata only and the newest 20 by default (100 per MCP
    // call); one probe row past the limit says whether older versions exist.
    const { limit, clampedFrom } = pagingLimit(ctx, 'get_versions', p.limit, GET_VERSIONS_DEFAULT_LIMIT, GET_VERSIONS_REMOTE_MAX_LIMIT);
    if (p.known_as_of !== undefined) return getVersionsKnownAsOf(ctx, p, limit);
    if (p.diff !== undefined || p.source_id !== undefined) throw opError('invalid_params', 'get_versions: diff and source_id need known_as_of.', 'Pass known_as_of (an ISO 8601 instant) with them, or drop them for the snapshot list.');
    const opts = { ...(await readPolicyOpts(ctx)), limit: limit + 1 };
    const page = <T>(rows: T[]): T[] => {
      reportVersionPage(ctx, p, { limit, clampedFrom, truncated: rows.length > limit });
      return rows.slice(0, limit);
    };
    if (p.include_body !== true) {
      // An adapter that ignores includeBody never leaks an unsanitized body through the metadata default.
      const metadata = page(await ctx.engine.getVersions(p.slug as string, { ...opts, includeBody: false }))
        .map(v => { const { compiled_truth: _b, timeline: _t, ...rest } = v as typeof v & { compiled_truth?: unknown; timeline?: unknown }; return rest; });
      const sized = [];
      for (const v of metadata) sized.push(await remoteVersionSize(ctx, v));
      return canReadWriteAttribution(ctx) ? attributeVersions(ctx.engine, sized) : sized;
    }
    const plain = page(await ctx.engine.getVersions(p.slug as string, opts));
    const versions = canReadWriteAttribution(ctx) ? await attributeVersions(ctx.engine, plain) : plain;
    // Wave B: a segmented version's body is never returned whole; body_ref names its size and the windowed read.
    const out = [];
    for (const v of versions) {
      if (isSegmentedPage(v)) {
        const sized = await remoteVersionSize(ctx, v);
        const { compiled_truth: _b, timeline: _t, ...rest } = sized;
        out.push({ ...rest, body_ref: { version_id: v.id, total_bytes: 'total_bytes' in sized ? sized.total_bytes : pageBodyBytes(v),
          read: { tool: 'get_page', arguments: { slug: p.slug, version_id: v.id, body: 'window' } } } });
        continue;
      }
      if (ctx.remote === false) { out.push(v); continue; }
      out.push({ ...v, compiled_truth: sanitizeRemoteBody(v.compiled_truth),
        ...(typeof v.timeline === 'string' ? { timeline: sanitizeRemoteBody(v.timeline) } : {}) });
    }
    return out;
  },
  scope: 'read',
  cliHints: { name: 'history', positional: ['slug'] },
};

/**
 * A segmented version as a remote caller sees it: the size of its read projection (`total_bytes`, what get_page reports
 * for a segmented page), never the stored body_bytes, whose difference would say how much text the projection hides.
 */
async function remoteVersionSize<V extends { page_id: number; body_storage?: string; body_generation?: number; body_bytes?: number }>(ctx: OperationContext, v: V):
  Promise<V | Omit<V, 'body_bytes'> & { total_bytes: number }> {
  if (ctx.remote === false || v.body_storage !== 'segmented') return v;
  const { body_bytes: _stored, ...rest } = v;
  const body = await openSegmentedBody(ctx.engine, { pageId: v.page_id, generation: v.body_generation });
  return { ...rest, total_bytes: (await segmentedReadDocument(ctx.engine, body)).total };
}

const revert_version: Operation = {
  name: 'revert_version',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Restore a page to an earlier version from its history (a new revision; history is kept). Use when an edit must be undone. Needs write scope. On a revision conflict: re-read the page with get_page and resubmit with its revision.',
  params: {
    ...PAGE_MUTATION_PARAMS,
    slug: { type: 'string', required: true, description: 'Slug of the page to revert.' },
    version_id: { type: 'number', required: true, description: 'Numeric version id to revert to, as returned by get_versions. Not a version NUMBER offset — pass the id field.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const { pageMutationSource, submitPageMutation } = await import('../persistence/page-mutations.ts');
    pageMutationSource(ctx, p, 'revert_version');
    enforceClientSlugFence(ctx, p.slug as string, 'revert_version');
    if (ctx.dryRun) return { dry_run: true, action: 'revert_version', slug: p.slug, version_id: p.version_id };
    return submitPageMutation(ctx, { operation: 'revert_version', params: p });
  },
  cliHints: { name: 'revert', positional: ['slug', 'version_id'] },
};


/**
 * CLI→MCP gap-closure wave — read-only view of the content-quality gate
 * (issue #1699). User story: an operator/agent reviewing what the gate hid or
 * flagged, remotely or via a thin-client CLI. Admin scope: enumerates
 * deliberately-hidden page slugs (the run_doctor posture). `quarantine scan`
 * (bulk re-import + re-embed) and `quarantine clear` (the trust decision —
 * same class as extraction_review) stay CLI-only.
 */
const quarantine_list: Operation = {
  name: 'quarantine_list',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description:
    'List quarantined (hidden) and optionally content-flagged pages by scanning page ' +
    'frontmatter, newest-updated first. When truncated is true, count is a LOWER BOUND — ' +
    'raise max_scan/limit or run the quarantine list command on the brain host for the full ' +
    'set. Clearing a marker is a local-only trust decision (CLI).',
  params: {
    include_flagged: { type: 'boolean', required: false, description: 'Also list content_flag pages (searchable-but-warned). Default false.' },
    limit: { type: 'number', required: false, description: 'Max rows returned (default 200, cap 1000).' },
    max_scan: { type: 'number', required: false, description: 'Max pages scanned (default 20000, cap 100000).' },
  },
  scope: 'admin',
  area: 'admin',
  handler: async (ctx, p) => {
    const {
      collectQuarantineRows,
      QUARANTINE_LIST_DEFAULT_LIMIT, QUARANTINE_LIST_MAX_LIMIT,
      QUARANTINE_SCAN_DEFAULT, QUARANTINE_SCAN_MAX,
    } = await import('../../commands/quarantine.ts');
    const rawLimit = typeof p.limit === 'number' && Number.isFinite(p.limit) ? p.limit : QUARANTINE_LIST_DEFAULT_LIMIT;
    const rawScan = typeof p.max_scan === 'number' && Number.isFinite(p.max_scan) ? p.max_scan : QUARANTINE_SCAN_DEFAULT;
    const { rows, scanned, truncated } = await collectQuarantineRows(ctx.engine, {
      includeFlagged: p.include_flagged === true,
      limit: Math.max(1, Math.min(QUARANTINE_LIST_MAX_LIMIT, rawLimit)),
      maxScan: Math.max(1, Math.min(QUARANTINE_SCAN_MAX, rawScan)),
      ...sourceScopeOpts(ctx),
    });
    return { schema_version: 1, count: rows.length, truncated, scanned, rows };
  },
};

/**
 * #6696 B2 (Garry decision d2b): banded brain health for any read-scope caller,
 * the `verify.mcp` of every write-capacity fix. Capacity band with a days band,
 * write-failure, ghost-page and unsearchable-chunk counts as bands, scoped to
 * the sources the caller may read; no slugs, paths or exact counters.
 */
const get_brain_health: Operation = {
  name: 'get_brain_health',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Brain health as bands for agents without admin scope: write capacity (ok, low or critical, with a days band) and counts of write failures, ghost pages and unsearchable chunks as bands, for the sources you can read. No slugs. Cached 60 s.',
  params: {},
  handler: async (ctx) => {
    const scope = sourceScopeOpts(ctx);
    const sourceIds = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : undefined);
    return (await import('../../commands/doctor/brain-health-bands.ts')).readBrainHealthBands(ctx.engine, { sourceIds });
  },
  scope: 'read',
};

// Ops in EXACTLY the canonical `operations` array order.
export const adminOperations: Operation[] = [
  get_stats, get_health, run_doctor, get_brain_health, get_versions, revert_version,
  get_brain_identity, quarantine_list,
];
