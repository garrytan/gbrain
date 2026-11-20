/**
 * #7190: how far each source's writes have been applied, in one read, so an agent can tell whether a write
 * is searchable yet without running git, SQL or a landing loop.
 *
 *   - indexed_through.commit: `sources.last_commit`. Only a sync pass that finishes moves it: the checkpoint
 *     publication that writes it is reached only through the pass's stamp, so a deadline-stopped, aborted,
 *     selection-scoped or partial pass never advances it. Files held at that commit are counted in
 *     `pending.held_files`, and deletes a mass-delete cap withheld in `pending.deletes_withheld`.
 *   - embedded_through: `complete` when every live page of the source that is not `embed_skip` has a vector for each
 *     visible chunk in the active embedding column. Held and capped large pages count as not embedded. Otherwise
 *     `before` is the oldest `updated_at` among the pages still waiting: every page written before it is embedded.
 *   - committed_through_request: a `persistence_requests.sequence` at or below which every request of the source's
 *     current incarnation has settled (committed, conflict, failed or cancelled): one below the oldest queued, running
 *     or recovering request, else the journal's newest sequence. A receipt whose `sequence` is at or below it has settled.
 *   - pending: unsettled requests (count and oldest age), commits and changed files on this host's checkout after
 *     the last synced commit, held files and withheld deletes. `count` is requests + files behind + held files +
 *     withheld deletes.
 *   - writer_heartbeat: the source's drain-lease holder and its last progress (a committed sync write, a cursor
 *     save or a pass-row write); `stalled` after HOLDER_STALL_MS without progress. A remote caller sees the holder's
 *     kind and times, never its host, pid or job id.
 *
 * `readWriteWatermark` is the cheap subset `get_write_request` carries (indexed reads only, no git, no lease read).
 * Read-only; nothing is scheduled or written.
 */
import type { BrainEngine } from '../engine.ts';
import { embeddingsDisabled } from '../embedding-disabled.ts';
import { embeddingWriteTarget } from '../page-state/projections.ts';
import { execFileBounded } from '../bounded-child-exec.ts';
import { gitChildEnv } from '../git-env.ts';
import { readGitBehind, type BehindReader } from './sync-freshness.ts';
import { countGitHolds } from './sync-holds.ts';
import { holderStalled, publicDrainHolder, readLiveDrainLease } from './sync-lease.ts';

export interface WriteWatermark {
  source_id: string;
  indexed_through: { commit: string | null; synced_at: string | null };
  committed_through_request: number | null;
  requests_pending: { count: number; oldest_age_seconds: number | null };
}

export interface AppliedWatermark extends Omit<WriteWatermark, 'requests_pending'> {
  read_at: string;
  embedded_through: { state: 'complete' | 'partial' | 'embeddings_off'; commit: string | null; before: string | null; unembedded_pages: number; held_pages: number };
  pending: {
    count: number;
    oldest_age_seconds: number | null;
    requests: { count: number; oldest_age_seconds: number | null };
    commits_behind: { count: number; oldest_age_seconds: number | null } | null;
    files_behind: number | null;
    held_files: number;
    deletes_withheld: number;
  };
  writer_heartbeat: {
    holder: { kind: string; id: string | null; host: string | null; pid: number | null } | null;
    heartbeat_age_seconds: number | null;
    last_progress_at: string | null;
    progress_age_seconds: number | null;
    stalled: boolean;
  };
}

/** Changed paths between `from` and HEAD of the checkout at `root`, or null when git cannot say. */
export type FilesBehindReader = (root: string, from: string) => Promise<number | null>;

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ageSeconds = (at: unknown, now: number): number | null => {
  if (at === null || at === undefined) return null;
  const ms = at instanceof Date ? at.getTime() : Date.parse(String(at));
  return Number.isFinite(ms) ? Math.max(0, Math.round((now - ms) / 1000)) : null;
};
const iso = (at: unknown): string | null => {
  if (at === null || at === undefined) return null;
  const ms = at instanceof Date ? at.getTime() : Date.parse(String(at));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

export const readGitFilesBehind: FilesBehindReader = async (root, from) => {
  if (!SHA.test(from)) return null;
  const diff = await execFileBounded('git', ['-C', root, 'diff', '--name-only', '-z', `${from}..HEAD`], { timeout: 10_000, env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0' }) });
  return diff.error ? null : diff.stdout.split('\0').filter(Boolean).length;
};

/** The cheap watermark `get_write_request` carries: the source row, and two reads on the request journal's indexes. */
export async function readWriteWatermark(engine: Pick<BrainEngine, 'readWriteWatermarkRow'>, sourceId: string, now = Date.now()): Promise<WriteWatermark> {
  const row = await engine.readWriteWatermarkRow(sourceId);
  const through = row.pending_min != null ? Number(row.pending_min) - 1 : row.newest_sequence == null ? null : Number(row.newest_sequence);
  return {
    source_id: sourceId,
    indexed_through: { commit: row.last_commit ?? null, synced_at: iso(row.last_sync_at) },
    committed_through_request: through,
    requests_pending: { count: Number(row.pending_count ?? 0), oldest_age_seconds: ageSeconds(row.pending_since, now) },
  };
}

/** The source's incarnation and its checkout on this host (the host binding's path, else the source's), or nulls. */
export async function readCheckoutRoot(engine: Pick<BrainEngine, 'readSourceCheckoutRoot'>, sourceId: string): Promise<{ incarnation: string | null; root: string | null } | undefined> {
  return (await engine.readSourceCheckoutRoot(sourceId, (await import('./identity.ts')).existingHostIdFor(engine as BrainEngine))) ?? undefined;
}

/**
 * The watermark's held files. A failed count reads as 0 on PGLite and Postgres; a Rust brain rethrows, so a
 * missing or failing hold store member there never reports "nothing held".
 */
export async function heldFileCount(engine: Pick<BrainEngine, 'kind' | 'executeRaw' | 'countGitHolds'>, sourceId: string, incarnation: string): Promise<number> {
  try {
    return await countGitHolds(engine, sourceId, incarnation);
  } catch (error) {
    if (engine.kind === 'rust') throw error;
    return 0;
  }
}

/** The full watermark of one source for `gbrain sources status --json` and MCP `sources_status`. */
export async function readAppliedWatermark(engine: BrainEngine, sourceId: string,
  opts: { remote?: boolean; now?: number; behind?: BehindReader; filesBehind?: FilesBehindReader } = {}): Promise<AppliedWatermark> {
  const now = opts.now ?? Date.now();
  const write = await readWriteWatermark(engine, sourceId, now);
  const source = await readCheckoutRoot(engine, sourceId);
  const commit = write.indexed_through.commit;
  const root = !opts.remote && source?.root && commit ? source.root : null;
  const lag = root ? await (opts.behind ?? readGitBehind)(root, commit!).catch(() => null) : null;
  const filesBehind = root && lag?.commits ? await (opts.filesBehind ?? readGitFilesBehind)(root, commit!).catch(() => null) : lag ? 0 : null;
  const heldFiles = source?.incarnation ? await heldFileCount(engine, sourceId, source.incarnation) : 0;
  const { readPassReadings } = await import('./sync-pass-readers.ts');
  const [pass] = await readPassReadings(engine, { sourceIds: [sourceId], head: false }).catch(() => []);
  const deletesWithheld = pass?.row.value.obligations.deletes_withheld ? Number(pass.row.value.telemetry.classes?.deletes_withheld?.count ?? 0) : 0;
  const commitsBehind = lag ? { count: lag.commits, oldest_age_seconds: lag.oldest === null ? null : Math.max(0, Math.round(now / 1000 - lag.oldest)) } : null;
  const ages = [write.requests_pending.oldest_age_seconds, commitsBehind?.oldest_age_seconds ?? null].filter((age): age is number => age !== null);

  let embedded: AppliedWatermark['embedded_through'];
  if (await embeddingsDisabled(engine)) embedded = { state: 'embeddings_off', commit: null, before: null, unembedded_pages: 0, held_pages: 0 };
  else {
    const waiting = await engine.readUnembeddedPageSummary(sourceId, (await embeddingWriteTarget(engine)).column.name);
    const pages = Number(waiting?.pages ?? 0);
    embedded = pages ? { state: 'partial', commit: null, before: iso(waiting?.oldest), unembedded_pages: pages, held_pages: Number(waiting?.held ?? 0) }
      : { state: 'complete', commit, before: null, unembedded_pages: 0, held_pages: 0 };
  }

  const lease = await readLiveDrainLease(engine, sourceId).catch(() => null);
  const holder = lease?.holder ?? null;
  const shown = opts.remote ? publicDrainHolder(holder) : holder;
  const lastProgress = holder?.progress?.last_progress_at ?? null;
  return {
    source_id: sourceId,
    read_at: new Date(now).toISOString(),
    indexed_through: write.indexed_through,
    embedded_through: embedded,
    committed_through_request: write.committed_through_request,
    pending: {
      count: write.requests_pending.count + (filesBehind ?? 0) + heldFiles + deletesWithheld,
      oldest_age_seconds: ages.length ? Math.max(...ages) : null,
      requests: write.requests_pending,
      commits_behind: commitsBehind,
      files_behind: filesBehind,
      held_files: heldFiles,
      deletes_withheld: deletesWithheld,
    },
    writer_heartbeat: {
      holder: shown ? { kind: shown.kind, id: shown.id, host: shown.host, pid: shown.pid } : null,
      heartbeat_age_seconds: ageSeconds(holder?.last_heartbeat_at, now),
      last_progress_at: lastProgress,
      progress_age_seconds: ageSeconds(lastProgress, now),
      stalled: holderStalled(holder, opts.now ?? lease?.db_now),
    },
  };
}

/** One status line: `<source>: indexed through <sha>, embedded <state>, N pending (oldest ...), writer ...`. */
export function formatAppliedWatermark(w: AppliedWatermark): string {
  const age = (seconds: number | null) => seconds === null ? '' : seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
  const embedded = w.embedded_through.state === 'complete' ? 'embedded through it'
    : w.embedded_through.state === 'embeddings_off' ? 'embeddings off'
    : `${w.embedded_through.unembedded_pages} page(s) wait for vectors${w.embedded_through.held_pages ? ` (${w.embedded_through.held_pages} held)` : ''}`;
  const parts = [w.pending.requests.count && `${w.pending.requests.count} request(s)`, w.pending.files_behind && `${w.pending.files_behind} file(s) behind`,
    w.pending.held_files && `${w.pending.held_files} held`, w.pending.deletes_withheld && `${w.pending.deletes_withheld} delete(s) withheld`].filter(Boolean);
  const pending = parts.length ? `pending: ${parts.join(', ')}${w.pending.oldest_age_seconds !== null ? ` (oldest ${age(w.pending.oldest_age_seconds)})` : ''}` : 'nothing pending';
  const holder = w.writer_heartbeat.holder;
  const writer = holder ? `; writer ${holder.kind}${holder.pid ? ` PID ${holder.pid}` : ''}${w.writer_heartbeat.stalled ? ' stalled' : ''}${w.writer_heartbeat.progress_age_seconds !== null ? `, last progress ${age(w.writer_heartbeat.progress_age_seconds)} ago` : ''}` : '';
  return `${w.source_id}: indexed through ${w.indexed_through.commit?.slice(0, 12) ?? '(never synced)'}, ${embedded}; ${pending}${writer}`;
}
