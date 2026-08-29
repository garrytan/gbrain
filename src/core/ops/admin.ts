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
import { enforceClientSlugFence, sourceScopeOpts } from './context.ts';
import { stripTakesFence } from '../takes-fence.ts';
import { slugHiddenFromCaller } from '../search/private-visibility.ts';
import { VERSION } from '../../version.ts';

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
  description: 'Brain health dashboard (embed coverage, stale pages, orphans) — remote callers see counters confined to their source grant. Includes a `migrations {pending, partial, wedged, skipped_future}` block from the host migration ledger so remote agents can detect wedged/outstanding host migrations without shelling into the brain host.',
  params: {},
  handler: async (ctx) => {
    // The `migrations` block below stays GLOBAL for scoped callers by
    // decision: it is a host filesystem ledger with no per-source semantics,
    // and a wedged host migration is exactly what a remote agent needs to
    // see to explain degraded behavior.
    const health = await ctx.engine.getHealth(diagnosticScope(ctx));
    // TODOS:4063 — composed at the OP layer (not BrainEngine.getHealth):
    // the ledger is a filesystem JSONL, engine-agnostic; growing the engine
    // interface would force both engines to duplicate a file read.
    // Best-effort like the doctor's ledger read: a corrupt/unreadable ledger
    // degrades the field, never the health call.
    let migrations: unknown;
    try {
      const { migrationLedgerSummary } = await import('../migration-ledger.ts');
      const { VERSION } = await import('../../version.ts');
      migrations = migrationLedgerSummary(VERSION);
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
  description: 'Brain identity + counters for thin-client banner — remote callers see counters confined to their source grant. Returns version, engine kind, and page/chunk counts. Read-scope.',
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
  description: 'Run brain health checks and return a structured DoctorReport (thin-client doctor surface).',
  params: {},
  handler: async (ctx) => {
    const { doctorReportRemote } = await import('../../commands/doctor.ts');
    // Source isolation (cross-model P1): a source-bound caller's report must
    // not aggregate other sources' activity. Scope-aware checks (currently
    // volunteer_channels) filter on these ids; unscoped ctx = brain-wide.
    const scope = sourceScopeOpts(ctx);
    const sourceIds = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : undefined);
    return doctorReportRemote(ctx.engine, { sourceIds });
  },
  scope: 'admin',
  localOnly: false,
};

const get_versions: Operation = {
  name: 'get_versions',
  description: 'Page version history',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose version history to list.' },
  },
  handler: async (ctx, p) => {
    const scope = sourceScopeOpts(ctx);
    // #4352 remediation: a `visibility: private` page's version history reads
    // exactly like a missing page's ([]) for untrusted callers — snapshots
    // persist historical compiled_truth verbatim, so /history was a full
    // bypass of get_page's gate. No existence oracle.
    if (await slugHiddenFromCaller(ctx.engine, ctx.remote, p.slug as string, scope)) return [];
    const versions = await ctx.engine.getVersions(p.slug as string, scope);
    // Same takes-allow-list privacy boundary as get_page. Snapshots persist
    // historical compiled_truth verbatim, including the takes fence, so
    // a remote token bypassing get_page via /history would re-introduce
    // the same leak across every prior version.
    if (!ctx.takesHoldersAllowList) return versions;
    return versions.map(v => ({ ...v, compiled_truth: stripTakesFence(v.compiled_truth) }));
  },
  scope: 'read',
  cliHints: { name: 'history', positional: ['slug'] },
};

const revert_version: Operation = {
  name: 'revert_version',
  description: 'Revert page to a previous version',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page to revert.' },
    version_id: { type: 'number', required: true, description: 'Numeric version id to revert to, as returned by get_versions. Not a version NUMBER offset — pass the id field.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    enforceClientSlugFence(ctx, p.slug as string, 'revert_version');
    if (ctx.dryRun) return { dry_run: true, action: 'revert_version', slug: p.slug, version_id: p.version_id };
    // v0.31.8 (D7): thread ctx.sourceId so multi-source brains revert the
    // intended page row instead of whichever same-slug row Postgres returns
    // first.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    await ctx.engine.createVersion(p.slug as string, sourceOpts);
    await ctx.engine.revertToVersion(p.slug as string, p.version_id as number, sourceOpts);
    return { status: 'reverted' };
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

// Ops in EXACTLY the canonical `operations` array order.
export const adminOperations: Operation[] = [
  get_stats, get_health, run_doctor, get_versions, revert_version,
  get_brain_identity, quarantine_list,
];
