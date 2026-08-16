/**
 * Admin operation cluster — pure move from operations.ts (v0.46.x tranche 2).
 * Op consts stay module-private; `adminOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts (run_doctor / get_versions / revert_version were defined
 * under the skill-catalog divider in the original file but have always
 * occupied the Admin slots of the array — the array order is the contract).
 * Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { enforceClientSlugFence, sourceScopeOpts } from './context.ts';
import { stripTakesFence } from '../takes-fence.ts';
import { VERSION } from '../../version.ts';

// --- Admin ---

const get_stats: Operation = {
  name: 'get_stats',
  description: 'Brain statistics (page count, chunk count, etc.)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getStats();
  },
  scope: 'admin',
  cliHints: { name: 'stats' },
};

const get_health: Operation = {
  name: 'get_health',
  description: 'Brain health dashboard (embed coverage, stale pages, orphans)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getHealth();
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
  description: 'Brain identity + counters for thin-client banner. Returns version, engine kind, and page/chunk counts. Read-scope.',
  params: {},
  handler: async (ctx) => {
    const stats = await ctx.engine.getStats();
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
    const versions = await ctx.engine.getVersions(p.slug as string, sourceScopeOpts(ctx));
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


// Ops in EXACTLY the canonical `operations` array order.
export const adminOperations: Operation[] = [
  get_stats, get_health, run_doctor, get_versions, revert_version,
  get_brain_identity,
];
