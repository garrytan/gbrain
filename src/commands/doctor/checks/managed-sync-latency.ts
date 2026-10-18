/**
 * managed_sync_latency (#6858 ask 6): the p95 commit→searchable latency of each managed source over the last 24 h
 * (reader: persistence/sync-freshness.ts, which also reports commit→embedded). It grades only a brain that asked for low
 * latency, with `sync.on_commit` true or `sync.freshness_target_seconds` set: a p95 over the target (default 300 s)
 * warns and one over max(1 h, target) fails, and committed targets it cannot date (the commit is not in this host's git
 * checkout) with no sample warn that the latency could not be measured. Otherwise, with nothing to measure, and on a
 * brain that is not managed it reports ok with the numbers, so a cron-synced brain sees no new warning. `doctor
 * --source` (and a remote caller's sources) scope it like every source-aware check (doctorSourceIds). A stopped run belongs to managed_sync_blocked (#6861) and a
 * run that stopped moving to managed_sync_not_moving; this check reads latency only. Reads the database and runs one
 * read-only `git log` per sampled source.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { readManagedMode } from '../../../core/persistence/managed-mode.ts';
import { FRESHNESS_FAIL_SECONDS, formatLatency, readFreshnessTarget, readSyncFreshness, type SourceFreshness } from '../../../core/persistence/sync-freshness.ts';
import { SYNC_ON_COMMIT_KEY } from '../../../core/sync-config-keys.ts';

const DOCS = 'docs/guides/on-commit-sync.md';
const p95 = (f: SourceFreshness) => f.commit_to_searchable.p95_seconds ?? 0;
const line = (f: SourceFreshness) => `${f.source_id} (p95 ${formatLatency(f.commit_to_searchable.p95_seconds)}, p50 ${formatLatency(f.commit_to_searchable.p50_seconds)}, ${f.commit_to_searchable.samples} page(s))`;

async function runManagedSyncLatencyCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    if (!await readManagedMode(engine)) {
      checks.push({ name: 'managed_sync_latency', status: 'ok', message: 'Not a managed brain; commit→searchable latency is measured for managed sources only.' });
      return checks;
    }
    const onCommit = /^(1|true|on|yes)$/i.test((await engine.getConfig(SYNC_ON_COMMIT_KEY))?.trim() ?? '');
    const target = await readFreshnessTarget(engine);
    const failSeconds = Math.max(FRESHNESS_FAIL_SECONDS, target.seconds);
    const graded = onCommit || target.explicit;
    const freshness = await readSyncFreshness(engine, { sourceIds: doctorSourceIds(ctx) });
    const sampled = freshness.filter(f => f.commit_to_searchable.samples > 0);
    const details = { graded, on_commit: onCommit, target_seconds: target.seconds, fail_seconds: failSeconds, sources: freshness, docs: DOCS };
    const failing = sampled.filter(f => p95(f) > failSeconds);
    const slow = sampled.filter(f => p95(f) > target.seconds);
    const first = failing[0] ?? slow[0];
    const fix = first ? agentFix(['gbrain', 'sync', 'status', '--source', first.source_id, '--json'],
      `Read-only: shows whether ${first.source_id}'s managed sync is behind, held or stopped, and the next step it names.`, 'managed_sync_latency', { docs: DOCS }) : undefined;
    const undated = freshness.filter(f => f.unresolved_commits > 0);
    const undatedCount = undated.reduce((n, f) => n + f.unresolved_commits, 0);
    const undatedLine = undated.map(f => `${f.source_id} (${f.unresolved_commits})`).join(', ');
    if (!sampled.length && graded && undatedCount) {
      checks.push({ name: 'managed_sync_latency', status: 'warn', details,
        fix: agentFix(['gbrain', 'sync', 'status', '--source', undated[0]!.source_id, '--json'],
          `Read-only: shows ${undated[0]!.source_id}'s managed sync state and checkout; the latency needs the synced commits in this host's checkout.`, 'managed_sync_latency', { docs: DOCS }),
        message: `Commit→searchable latency could not be measured for ${undatedCount} commit(s) synced in the last ${freshness[0]?.window_hours ?? 24} h: ${undatedLine}. The commit is not in this host's local git checkout, so its commit time is unknown.` });
    } else if (!sampled.length) {
      checks.push({ name: 'managed_sync_latency', status: 'ok', details,
        message: undatedCount
          ? `No commit→searchable samples in the last ${freshness[0]?.window_hours ?? 24} h: ${undatedCount} synced commit(s) are not in this host's local git checkout (${undatedLine}); not graded (sync.on_commit is off and no target is set).`
          : `No commit→searchable samples in the last ${freshness[0]?.window_hours ?? 24} h (no managed sync imported a new commit).` });
    } else if (graded && failing.length) {
      checks.push({ name: 'managed_sync_latency', status: 'fail', readiness_state: 'degraded', details, fix,
        message: `${failing.map(line).join('; ')}: p95 commit→searchable is over ${formatLatency(failSeconds)}. New commits take that long to reach search.` });
    } else if (graded && slow.length) {
      checks.push({ name: 'managed_sync_latency', status: 'warn', readiness_state: 'degraded', details, fix,
        message: `${slow.map(line).join('; ')}: p95 commit→searchable is over the ${formatLatency(target.seconds)} target (sync.freshness_target_seconds).` });
    } else {
      checks.push({ name: 'managed_sync_latency', status: 'ok', severity: 'info', details,
        message: `Commit→searchable over the last 24 h: ${sampled.map(line).join('; ')}${graded ? `, within the ${formatLatency(target.seconds)} target` : '; not graded (sync.on_commit is off and no target is set)'}.` });
    }
  } catch (error) {
    checks.push(checkError('managed_sync_latency', 'read managed sync freshness', error, { details: { health: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const managedSyncLatencyEntry: DoctorEntry = { name: 'managed_sync_latency', emits: ['managed_sync_latency'], run: runManagedSyncLatencyCheck };
