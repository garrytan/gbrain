/**
 * advisor/collect-stalled-jobs.ts — stuck background work + stale sync.
 *
 * #14: `minion_jobs` may be ABSENT on older/partial brains, and very old
 * brains lack `sources` or `sources.last_sync_at`: exactly those missing
 * objects yield no finding. Any other read failure is rethrown so runAdvisor
 * reports `collector_failed:stalled-jobs` instead of a clean check. Engine-agnostic
 * SQL via executeRaw (works on Postgres + PGLite); timestamps compared with
 * `now()` which both engines provide. No PG-only constructs.
 */

import type { AdvisorCollector, AdvisorFinding } from './types.ts';
import { isMissingSchemaObject } from '../utils.ts';

export const collectStalledJobs: AdvisorCollector = {
  id: 'stalled-jobs',
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];

    // Stuck active jobs: lock lapsed or stalled-counter climbing.
    try {
      const rows = await ctx.engine.executeRaw<{ name: string; n: number }>(
        `SELECT name, count(*)::int AS n
           FROM minion_jobs
          WHERE status = 'active'
            AND (lock_until < now() OR stalled_counter >= 2)
          GROUP BY name
          ORDER BY n DESC`,
      );
      for (const r of rows) {
        findings.push({
          id: `stalled_job:${r.name}`,
          severity: 'warn',
          title: `${r.n} "${r.name}" job${r.n === 1 ? '' : 's'} look stalled (lock lapsed / retrying).`,
          detail: 'A wedged worker stops backfill/sync from progressing.',
          // 'jobs stats' is the real subcommand — 'jobs status' never existed
          // (the dead fix-command shipped unnoticed because nothing executes
          // advisor fixes automatically).
          fix: { command_argv: ['gbrain', 'jobs', 'stats'] },
          collector: 'stalled-jobs',
          ask_user: true,
        });
      }
    } catch (err) {
      if (!isMissingSchemaObject(err, 'table', 'minion_jobs')) throw err;
    }

    // Stale federated sources: synced sources that haven't advanced in a week.
    try {
      const rows = await ctx.engine.executeRaw<{ id: string }>(
        `SELECT id
           FROM sources
          WHERE last_sync_at IS NOT NULL
            AND last_sync_at < now() - interval '7 days'
          ORDER BY id`,
      );
      for (const r of rows) {
        findings.push({
          id: `stale_sync:${r.id}`,
          severity: 'info',
          title: `Source "${r.id}" hasn't synced in over a week.`,
          detail: 'Re-sync to pull in new content the brain has not indexed yet.',
          fix: { command_argv: ['gbrain', 'sync', '--source', r.id] },
          collector: 'stalled-jobs',
          ask_user: true,
        });
      }
    } catch (err) {
      if (!isMissingSchemaObject(err, 'table', 'sources') && !isMissingSchemaObject(err, 'column', 'last_sync_at')) throw err;
    }

    return findings;
  },
};
