/**
 * #6858 ask 6 (option C): how long a commit takes to become searchable, and embedded, per managed source.
 *
 * One sample per committed `managed_sync_import` receipt of the current source incarnation in the window (24 h):
 *   - commit time: the git committer time of the run's pinned target (`intent.target`), read from this host's
 *     checkout (one `git log --no-walk` per source). A run that spans several commits is dated by its newest, so the
 *     sample is a lower bound for the older commits in it. A first sync (`intent.from` null) and a working-tree entry
 *     are not samples: they import history or uncommitted files, not a commit that just landed.
 *   - searchable: the receipt's `completed_at` (the page write committed; search reads it from then on).
 *   - embedded: the newest `content_chunks.embedded_at` of the page's visible chunks, once every one has one (a page with a
 *     chunk still waiting counts as `pending`; a page with no chunks is not an embedding sample). Only a receipt whose
 *     write is still the page's current revision is an embedding sample: the chunks are the page's current ones, so a
 *     receipt superseded by a later committed write to the same page (same source and slug, higher sequence) would
 *     read the later revision's embed time; it still counts for commit→searchable. An embed time before the receipt's
 *     completion (chunks the write did not re-embed) is not a sample either.
 * Latencies are clamped at 0 (a committer clock ahead of the database clock). The read uses the partial index
 * `persistence_requests_sync_watermark` (its predicate is repeated verbatim) and stops after one probe when the window
 * is empty. Nothing is written. Readers: `gbrain sync status` (the `freshness` block), `gbrain status`, and doctor
 * `managed_sync_latency` (src/commands/doctor/checks/managed-sync-latency.ts).
 */
import type { BrainEngine } from '../engine.ts';
import { execFileBounded } from '../bounded-child-exec.ts';
import { gitChildEnv } from '../git-env.ts';
import { SYNC_FRESHNESS_TARGET_KEY } from '../sync-config-keys.ts';
import { chunkVisibleFilter } from '../search/safe-chunks.ts';

export const FRESHNESS_WINDOW_HOURS = 24;
/** The newest distinct targets dated per source; older ones in the window are left out of the sample. */
export const FRESHNESS_MAX_TARGETS = 200;
export const DEFAULT_FRESHNESS_TARGET_SECONDS = 300;
export const FRESHNESS_FAIL_SECONDS = 3600;

export interface LatencyStats { samples: number; p50_seconds: number | null; p95_seconds: number | null }
export interface SourceFreshness {
  source_id: string;
  window_hours: number;
  commit_to_searchable: LatencyStats;
  commit_to_embedded: LatencyStats & { pending: number };
  /** Distinct run targets dated from git. */
  commits: number;
  /**
   * Synced run targets in the window git could not date here (no checkout on this host, or the commit is not in it); their
   * pages are not sampled. Not the backlog: commits still waiting to sync are `waiting_commits` (`behind.commits`).
   */
  unresolved_commits: number;
  /** GBRA-133 (#7243): commits on this host's checkout HEAD the source has not synced yet (`behind.commits`), or null when git cannot say. */
  waiting_commits: number | null;
  /**
   * #7189: the current lag, which the latency samples above cannot show (they date only commits that already synced):
   * commits on this host's checkout HEAD after the source's last synced commit, and the committer age of the oldest
   * of them. Null when this host has no checkout, the source has not synced yet, or git could not answer.
   */
  behind: { commits: number; oldest_seconds: number | null } | null;
}

/** The commits after `from` up to HEAD of the checkout at `root`, oldest committer time first (unix seconds), or null when git cannot say. */
export type BehindReader = (root: string, from: string) => Promise<{ commits: number; oldest: number | null } | null>;

/** Commit time (unix seconds) of each sha that the checkout at `root` can resolve. */
export type CommitTimeReader = (root: string, shas: string[]) => Promise<Map<string, number>>;

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SAMPLE_WHERE = `r.worktree_id=$1::uuid AND r.source_incarnation=$2::uuid AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
    AND r.completed_at > now() - ($3::int * interval '1 hour') AND r.intent->>'kind'='managed_sync_import' AND r.intent->>'from' IS NOT NULL
    AND COALESCE(r.intent->>'working','false') <> 'true'`;

export const readGitCommitTimes: CommitTimeReader = async (root, shas) => {
  const out = new Map<string, number>();
  const run = (args: string[]) => execFileBounded('git', ['-C', root, ...args], { timeout: 10_000, env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0' }) });
  const parse = (stdout: string) => {
    for (const line of stdout.split('\n')) {
      const [sha, at] = line.trim().split(' ');
      if (sha && SHA.test(sha) && Number.isFinite(Number(at))) out.set(sha, Number(at));
    }
  };
  const all = await run(['log', '--no-walk=unsorted', '--format=%H %ct', ...shas]);
  if (!all.error) { parse(all.stdout); return out; }
  for (const sha of shas) {
    const one = await run(['log', '-1', '--format=%H %ct', sha]);
    if (!one.error) parse(one.stdout);
  }
  return out;
};

export const readGitBehind: BehindReader = async (root, from) => {
  if (!SHA.test(from)) return null;
  const run = (args: string[]) => execFileBounded('git', ['-C', root, ...args], { timeout: 10_000, env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0' }) });
  const count = await run(['rev-list', '--count', `${from}..HEAD`]);
  const commits = Number(count.stdout.trim());
  if (count.error || !Number.isInteger(commits)) return null;
  if (!commits) return { commits: 0, oldest: null };
  const oldest = await run(['log', '--reverse', '--format=%ct', `${from}..HEAD`]);
  const at = Number(oldest.stdout.slice(0, oldest.stdout.indexOf('\n') >>> 0).trim());
  return { commits, oldest: !oldest.error && Number.isFinite(at) && at > 0 ? at : null };
};

const num = (value: unknown): number | null => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10) / 10;

interface BindingRow { source_id: string; worktree_id: string; source_incarnation: string; root: string | null; last_commit: string | null }
interface AggregateRow { samples: number | string; s50: unknown; s95: unknown; embedded: number | string; e50: unknown; e95: unknown; pending: number | string }

/** The freshness of every bound managed source (or of `sourceIds`); a source without a binding is omitted. */
export async function readSyncFreshness(engine: BrainEngine, opts: { sourceIds?: string[]; commitTimes?: CommitTimeReader; behind?: BehindReader } = {}): Promise<SourceFreshness[]> {
  const { existingLocalHostId } = await import('./identity.ts');
  const bindings = await engine.executeRaw<BindingRow>(`SELECT b.source_id, b.worktree_id::text AS worktree_id, b.source_incarnation::text AS source_incarnation, COALESCE(h.local_path, s.local_path) AS root, s.last_commit
    FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation
    LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id::text=$2
    WHERE ($1::text[] IS NULL OR b.source_id=ANY($1::text[])) ORDER BY b.source_id`, [opts.sourceIds ?? null, existingLocalHostId()]);
  const commitTimes = opts.commitTimes ?? readGitCommitTimes;
  const behindOf = opts.behind ?? readGitBehind;
  const out: SourceFreshness[] = [];
  for (const b of bindings) {
    const lag = b.root && b.last_commit ? await behindOf(b.root, b.last_commit).catch(() => null) : null;
    const behind = lag && { commits: lag.commits, oldest_seconds: lag.oldest === null ? null : Math.max(0, Math.round(Date.now() / 1000 - lag.oldest)) };
    const empty: SourceFreshness = { source_id: b.source_id, window_hours: FRESHNESS_WINDOW_HOURS, commit_to_searchable: { samples: 0, p50_seconds: null, p95_seconds: null },
      commit_to_embedded: { samples: 0, p50_seconds: null, p95_seconds: null, pending: 0 }, commits: 0, unresolved_commits: 0, waiting_commits: behind ? behind.commits : null, behind };
    const targets = (await engine.executeRaw<{ target: string }>(`SELECT r.intent->>'target' AS target FROM persistence_requests r WHERE ${SAMPLE_WHERE}
      GROUP BY 1 ORDER BY max(r.completed_at) DESC LIMIT ${FRESHNESS_MAX_TARGETS}`, [b.worktree_id, b.source_incarnation, FRESHNESS_WINDOW_HOURS]))
      .map(row => row.target).filter(target => typeof target === 'string' && SHA.test(target));
    if (!targets.length) { out.push(empty); continue; }
    const dated = b.root ? await commitTimes(b.root, targets).catch(() => new Map<string, number>()) : new Map<string, number>();
    const times = Object.fromEntries(targets.filter(t => dated.has(t)).map(t => [t, dated.get(t)!]));
    const commits = Object.keys(times).length;
    if (!commits) { out.push({ ...empty, unresolved_commits: targets.length }); continue; }
    const [row] = await engine.executeRaw<AggregateRow>(`WITH c AS (SELECT key AS target, to_timestamp(value::double precision) AS committed_at FROM jsonb_each_text($4::text::jsonb)),
      sample AS (SELECT r.source_id, r.slug, r.sequence, r.page_id, r.completed_at, c.committed_at
        FROM persistence_requests r JOIN c ON c.target=r.intent->>'target' WHERE ${SAMPLE_WHERE}),
      later AS MATERIALIZED (SELECT l.source_id, l.slug, max(l.sequence) AS sequence FROM persistence_requests l
        WHERE l.state='committed' AND l.source_id IN (SELECT source_id FROM sample) AND l.sequence > (SELECT min(sequence) FROM sample) GROUP BY l.source_id, l.slug),
      s AS (SELECT r.completed_at, r.committed_at, COALESCE(r.page_id, (SELECT p.id FROM pages p WHERE p.source_id=r.source_id AND p.slug=r.slug LIMIT 1)) AS page_id,
          COALESCE(later.sequence > r.sequence, false) AS superseded
        FROM sample r LEFT JOIN later ON later.source_id=r.source_id AND later.slug=r.slug),
      e AS (SELECT s.completed_at, s.committed_at, s.superseded, ch.n, ch.missing, ch.last_at FROM s
        LEFT JOIN LATERAL (SELECT count(*) AS n, count(*) FILTER (WHERE cc.embedded_at IS NULL) AS missing, max(cc.embedded_at) AS last_at FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
          WHERE cc.page_id=s.page_id AND ${chunkVisibleFilter('p', 'cc')}) ch ON true),
      l AS (SELECT GREATEST(0, extract(epoch FROM completed_at - committed_at)) AS searchable,
          CASE WHEN NOT superseded AND n > 0 AND missing = 0 AND last_at >= completed_at THEN GREATEST(0, extract(epoch FROM last_at - committed_at)) END AS embedded,
          (NOT superseded AND n > 0 AND missing > 0) AS pending FROM e)
      SELECT count(*) AS samples, percentile_cont(0.5) WITHIN GROUP (ORDER BY searchable) AS s50, percentile_cont(0.95) WITHIN GROUP (ORDER BY searchable) AS s95,
        count(embedded) AS embedded, percentile_cont(0.5) WITHIN GROUP (ORDER BY embedded) AS e50, percentile_cont(0.95) WITHIN GROUP (ORDER BY embedded) AS e95,
        count(*) FILTER (WHERE pending) AS pending FROM l`, [b.worktree_id, b.source_incarnation, FRESHNESS_WINDOW_HOURS, JSON.stringify(times)]);
    out.push({ ...empty, commits, unresolved_commits: targets.length - commits,
      commit_to_searchable: { samples: Number(row?.samples ?? 0), p50_seconds: num(row?.s50), p95_seconds: num(row?.s95) },
      commit_to_embedded: { samples: Number(row?.embedded ?? 0), p50_seconds: num(row?.e50), p95_seconds: num(row?.e95), pending: Number(row?.pending ?? 0) } });
  }
  return out;
}

/** The p95 commit→searchable target in seconds (`sync.freshness_target_seconds`, default 300) and whether it is set explicitly. */
export async function readFreshnessTarget(engine: BrainEngine): Promise<{ seconds: number; explicit: boolean }> {
  const raw = (await engine.getConfig(SYNC_FRESHNESS_TARGET_KEY).catch(() => null))?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? { seconds: value, explicit: true } : { seconds: DEFAULT_FRESHNESS_TARGET_SECONDS, explicit: false };
}

export function formatLatency(value: number | null): string {
  if (value === null) return '?';
  if (value < 120) return `${value}s`;
  if (value < 7200) return `${Math.round(value / 6) / 10}m`;
  return `${Math.round(value / 360) / 10}h`;
}

/** One human line per source: `commit→searchable p50 8s, p95 14s (12 page(s), last 24 h); commit→embedded ...`. */
export function formatSyncFreshness(f: SourceFreshness): string {
  const behind = f.behind?.commits ? `; ${f.behind.commits} commit(s) not synced yet${f.behind.oldest_seconds !== null ? `, oldest ${formatLatency(f.behind.oldest_seconds)} old` : ''}` : '';
  if (!f.commit_to_searchable.samples) {
    return `no commit→searchable samples in the last ${f.window_hours} h${f.unresolved_commits ? `, ${f.unresolved_commits} commit(s) not datable from this host's checkout` : ''}${behind}`;
  }
  const s = f.commit_to_searchable, e = f.commit_to_embedded;
  return `commit→searchable p50 ${formatLatency(s.p50_seconds)}, p95 ${formatLatency(s.p95_seconds)} (${s.samples} page(s), last ${f.window_hours} h); `
    + `commit→embedded ${e.samples ? `p50 ${formatLatency(e.p50_seconds)}, p95 ${formatLatency(e.p95_seconds)}` : 'no samples'} (${e.samples} page(s), ${e.pending} pending)${behind}`;
}
