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
  /** Targets in the window git could not date here (no checkout on this host, or the commit is not in it); their pages are not sampled. */
  unresolved_commits: number;
}

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

const num = (value: unknown): number | null => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10) / 10;

interface BindingRow { source_id: string; worktree_id: string; source_incarnation: string; root: string | null }
interface AggregateRow { samples: number | string; s50: unknown; s95: unknown; embedded: number | string; e50: unknown; e95: unknown; pending: number | string }

/** The freshness of every bound managed source (or of `sourceIds`); a source without a binding is omitted. */
export async function readSyncFreshness(engine: BrainEngine, opts: { sourceIds?: string[]; commitTimes?: CommitTimeReader } = {}): Promise<SourceFreshness[]> {
  const { existingLocalHostId } = await import('./identity.ts');
  const bindings = await engine.executeRaw<BindingRow>(`SELECT b.source_id, b.worktree_id::text AS worktree_id, b.source_incarnation::text AS source_incarnation, COALESCE(h.local_path, s.local_path) AS root
    FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation
    LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id::text=$2
    WHERE ($1::text[] IS NULL OR b.source_id=ANY($1::text[])) ORDER BY b.source_id`, [opts.sourceIds ?? null, existingLocalHostId()]);
  const commitTimes = opts.commitTimes ?? readGitCommitTimes;
  const out: SourceFreshness[] = [];
  for (const b of bindings) {
    const empty: SourceFreshness = { source_id: b.source_id, window_hours: FRESHNESS_WINDOW_HOURS, commit_to_searchable: { samples: 0, p50_seconds: null, p95_seconds: null },
      commit_to_embedded: { samples: 0, p50_seconds: null, p95_seconds: null, pending: 0 }, commits: 0, unresolved_commits: 0 };
    const targets = (await engine.executeRaw<{ target: string }>(`SELECT r.intent->>'target' AS target FROM persistence_requests r WHERE ${SAMPLE_WHERE}
      GROUP BY 1 ORDER BY max(r.completed_at) DESC LIMIT ${FRESHNESS_MAX_TARGETS}`, [b.worktree_id, b.source_incarnation, FRESHNESS_WINDOW_HOURS]))
      .map(row => row.target).filter(target => typeof target === 'string' && SHA.test(target));
    if (!targets.length) { out.push(empty); continue; }
    const dated = b.root ? await commitTimes(b.root, targets).catch(() => new Map<string, number>()) : new Map<string, number>();
    const times = Object.fromEntries(targets.filter(t => dated.has(t)).map(t => [t, dated.get(t)!]));
    const commits = Object.keys(times).length;
    if (!commits) { out.push({ ...empty, unresolved_commits: targets.length }); continue; }
    const [row] = await engine.executeRaw<AggregateRow>(`WITH c AS (SELECT key AS target, to_timestamp(value::double precision) AS committed_at FROM jsonb_each_text($4::text::jsonb)),
      s AS (SELECT r.completed_at, c.committed_at, COALESCE(r.page_id, (SELECT p.id FROM pages p WHERE p.source_id=r.source_id AND p.slug=r.slug LIMIT 1)) AS page_id,
          EXISTS (SELECT 1 FROM persistence_requests later WHERE later.source_id=r.source_id AND later.slug=r.slug AND later.sequence>r.sequence AND later.state='committed') AS superseded
        FROM persistence_requests r JOIN c ON c.target=r.intent->>'target' WHERE ${SAMPLE_WHERE}),
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
  if (!f.commit_to_searchable.samples) {
    return `no commit→searchable samples in the last ${f.window_hours} h${f.unresolved_commits ? `, ${f.unresolved_commits} commit(s) not datable from this host's checkout` : ''}`;
  }
  const s = f.commit_to_searchable, e = f.commit_to_embedded;
  return `commit→searchable p50 ${formatLatency(s.p50_seconds)}, p95 ${formatLatency(s.p95_seconds)} (${s.samples} page(s), last ${f.window_hours} h); `
    + `commit→embedded ${e.samples ? `p50 ${formatLatency(e.p50_seconds)}, p95 ${formatLatency(e.p95_seconds)}` : 'no samples'} (${e.samples} page(s), ${e.pending} pending)`;
}
