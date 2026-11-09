/**
 * Convergence PR B (docs/designs/REFRESH_WRITE_BARRIER.md): the replay side of the refresh write barrier.
 *
 * A page write admitted while `gbrain sources refresh` held its worktree waits in state `deferred` (journal.ts) until the
 * refresh is released (completed or aborted). When it is claimed, before anything is published, two checks run here:
 * the write's durable authority against current grants (it may have waited minutes), and whether the refresh changed
 * any file the publication writes. A refresh that changed one ends the write `revision_conflict` (nothing applied), so
 * a page the refresh changed is never overwritten. The check reads git, not the page revision: a refresh completes even
 * when a member's sync is blocked, so git can hold the refreshed bytes before the database does.
 */
import { relative, sep } from 'node:path';
import { execFileBounded } from '../bounded-child-exec.ts';
import { gitChildEnv } from '../git-env.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeWrite } from './authority.ts';
import type { BrainEngine } from '../engine.ts';
import { completeWrite, SYNC_KIND } from './journal.ts';
import { PENDING_IMPORT } from './pending-import.ts';
import { declarePersistenceProtocol } from './protocol.ts';
import type { SqlEngine, WriteRequest } from './model.ts';

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };
const DIFF_TIMEOUT_MS = 30_000;
const CACHED_REFRESHES = 32;
/** The paths each refresh changed, per checkout root: one diff serves the whole drain behind it. */
const changed = new Map<string, Promise<RefreshPaths | null>>();
/** GST-1623: with `core.ignorecase` true the checkout names one file in any case, so paths are compared case-folded. */
interface RefreshPaths { paths: ReadonlySet<string>; fold: boolean }

/** Paths (repository-relative, forward slashes) refresh `refreshId` changed; empty for an aborted refresh; null when unreadable. */
async function refreshChangedPaths(engine: SqlEngine, refreshId: string, root: string): Promise<RefreshPaths | null> {
  const key = `${refreshId}\0${root}`;
  const held = changed.get(key);
  if (held) return held;
  const read = (async () => {
    const [refresh] = await engine.executeRaw<{ state: string; old_head: string; target_head: string; released: boolean }>(
      'SELECT state,old_head,target_head,released_at IS NOT NULL AS released FROM persistence_worktree_refreshes WHERE id=$1::uuid', [refreshId]);
    if (!refresh?.released) return null;
    if (refresh.state === 'aborted' || refresh.old_head === refresh.target_head) return { paths: new Set<string>(), fold: false };
    const [diff, config] = await Promise.all([execFileBounded('git', ['-C', root, '-c', 'core.quotepath=false', 'diff', '--name-only', '-z', '--no-renames', '--relative',
      refresh.old_head, refresh.target_head], { timeout: DIFF_TIMEOUT_MS, maxBuffer: 64 * 1024 ** 2, env: gitChildEnv(GIT_ENV) }),
    execFileBounded('git', ['-C', root, 'config', '--bool', 'core.ignorecase'], { timeout: DIFF_TIMEOUT_MS, env: gitChildEnv(GIT_ENV) })]);
    if (diff.error) return null;
    const fold = !config.error && config.stdout.trim() === 'true';
    return { paths: new Set(diff.stdout.split('\0').filter(Boolean).map(path => fold ? path.toLowerCase() : path)), fold };
  })();
  changed.set(key, read);
  read.then(paths => { if (paths === null && changed.get(key) === read) changed.delete(key); }, () => { if (changed.get(key) === read) changed.delete(key); });
  while (changed.size > CACHED_REFRESHES) changed.delete(changed.keys().next().value!);
  return read;
}

export interface DeferredRefusal { state: 'conflict' | 'failed'; failure: { code: string; message: string } }

/** Writes that apply on top of the page as it is, so one accepted later never makes them overwrite anything. */
const APPENDING_OPERATIONS = ['remember', 'add_timeline_entry'];

/**
 * GST-1623: the refusal of deferred write `row` when a write to its page accepted after it has already committed (an older
 * consumer, which has no EARLIER_DEFERRED in its claim, claimed the later write first), so the deferred one, replayed now,
 * never lands on top of it. Managed sync's own rows are the import the write waited for and do not count; neither does a
 * write that only appends. A sync row is a `submit_job` with a managed_sync_ kind, or with an imported file once compaction
 * dropped its intent (#8765 review): a caller cannot make its own write look like one. A connector import names
 * `connector_database` in its outcome and stays a later write (overwritten-edits.ts MANAGED_IMPORT).
 */
async function laterWriteRefusal(engine: SqlEngine, row: WriteRequest): Promise<DeferredRefusal | null> {
  if (APPENDING_OPERATIONS.includes(row.operation)) return null;
  const [later] = await engine.executeRaw<{ request_id: string }>(`SELECT r.request_id::text AS request_id FROM persistence_requests r
    WHERE r.source_id=$1 AND r.slug=$2 AND r.sequence>$3 AND r.state='committed' AND NOT (r.operation='submit_job'
      AND (${SYNC_KIND('r')} OR (r.intent IS NULL AND COALESCE(r.outcome->>'imported_file','')='true' AND NOT (r.outcome ? 'connector_database')))) ORDER BY r.sequence LIMIT 1`,
  [row.source_id, row.slug, String(row.sequence)]);
  if (!later) return null;
  return { state: 'conflict', failure: { code: 'revision_conflict', message: `Request ${row.request_id} waited ${row.deferred_refresh_id ? `behind refresh ${row.deferred_refresh_id}` : 'for an import'}, and request ${later.request_id}, accepted after it, has already changed ${row.slug}, so nothing was applied and the later write was not overwritten. Read the page again and submit the change with a new request_id.` } };
}

/**
 * Null when a claimed deferred write may publish `files` (its own page file and its companions'); otherwise the terminal
 * refusal to record. A row that was never deferred is not checked. GST-1623: a write held for an import is checked too, for a
 * later write to its page that committed first.
 */
export async function deferredReplayRefusal(engine: SqlEngine, row: WriteRequest, files: ReadonlyArray<{ path: string; root: string }>): Promise<DeferredRefusal | null> {
  const refreshId = row.deferred_refresh_id;
  if (!refreshId && row.deferred_import_from == null) return null;
  const later = await laterWriteRefusal(engine, row);
  if (later || !refreshId) return later;
  try { await authorizeWrite(engine, row.authority, row.operation, row.slug); } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return { state: 'failed', failure: { code: error.code, message: `Request ${row.request_id} waited behind refresh ${refreshId}, and its credential no longer grants this write: ${error.message}` } };
  }
  let unreadable = false;
  const touched: string[] = [];
  for (const file of files) {
    const changes = await refreshChangedPaths(engine, refreshId, file.root);
    const target = relative(file.root, file.path).split(sep).join('/');
    if (changes === null) unreadable = true;
    if (changes === null || changes.paths.has(changes.fold ? target.toLowerCase() : target)) touched.push(target);
  }
  if (!touched.length) return null;
  return { state: 'conflict', failure: { code: 'revision_conflict', message: unreadable
    ? `Request ${row.request_id} waited behind refresh ${refreshId}, and what that refresh changed could not be read, so nothing was applied. Read the page again and submit the change with a new request_id.`
    : `Refresh ${refreshId} changed ${touched.join(', ')} after request ${row.request_id} was accepted, so nothing was applied and no newer content was overwritten. Read the page again and submit the change with a new request_id.` } };
}

export const REFRESH_BARRIER_MAX_WAIT_KEY = 'persistence.refresh_barrier_max_wait_ms';
export const REFRESH_BARRIER_MAX_WAIT_MS = 15 * 60_000;
/** The wait limit in ms: the configured value when it is a positive integer, else the default. */
const MAX_WAIT_SQL = `COALESCE((SELECT CASE WHEN value ~ '^[1-9][0-9]{0,14}$' THEN value::double precision END FROM config WHERE key='${REFRESH_BARRIER_MAX_WAIT_KEY}'), ${REFRESH_BARRIER_MAX_WAIT_MS})`;
const overdueDeferredFrom = (host: string, maxWait: string) => `JOIN persistence_worktrees w ON w.id=r.worktree_id
    JOIN persistence_worktree_refreshes f ON f.id=r.deferred_refresh_id
    WHERE w.owner_host_id=${host}::uuid AND r.state='deferred' AND f.released_at IS NULL AND r.created_at<now()-(${maxWait}*interval '1 millisecond')`;
/**
 * GST-1623: however often a write is held again (another writer committing to its file faster than sync imports), it waits at
 * most this many wait limits from its admission, and never less than HOLD_CEILING_FLOOR_MS.
 */
const HOLD_CEILING_LIMITS = 4;
const HOLD_CEILING_FLOOR_MS = 4 * 60 * 60_000;
const holdCeiling = (maxWait: string) => `GREATEST(${maxWait}*${HOLD_CEILING_LIMITS},${HOLD_CEILING_FLOOR_MS})`;
/** A held write past its limit: held longer than the wait limit, or accepted longer ago than the ceiling. */
const holdOverdue = (maxWait: string) => `(r.updated_at<now()-(${maxWait}*interval '1 millisecond') OR r.created_at<now()-(${holdCeiling(maxWait)}*interval '1 millisecond'))`;
/** GST-1582: a write held for an import still pending (its refresh, if any, released) whose hold is past its limit. */
const overdueImportFrom = (host: string, maxWait: string) => `JOIN persistence_worktrees w ON w.id=r.worktree_id JOIN sources s ON s.id=r.source_id
    WHERE w.owner_host_id=${host}::uuid AND r.state='deferred' AND r.deferred_import_from IS NOT NULL AND COALESCE(s.last_commit,'')=r.deferred_import_from
      AND (r.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes f WHERE f.id=r.deferred_refresh_id AND f.released_at IS NOT NULL))
      AND ${holdOverdue(maxWait)}`;
/** The owner's idle probe counts an overdue deferred or import-held write as work, so its expiry runs even when nothing else is queued. */
export const overdueDeferredWorkSql = (host: string) => `(EXISTS (SELECT 1 FROM persistence_requests r ${overdueDeferredFrom(host, MAX_WAIT_SQL)})
  OR EXISTS (SELECT 1 FROM persistence_requests r ${overdueImportFrom(host, MAX_WAIT_SQL)}))`;

/**
 * The owner's housekeeping: a deferred write whose refresh is still unreleased past the wait limit ends failed with
 * `refresh_barrier_expired` (nothing applied, counters released). The transaction declares the persistence protocol (the
 * brain row FOR SHARE) before it locks the refresh row, the order fenceAndMerge takes them in (brain FOR UPDATE, then the
 * refresh), so an expiry overlapping a fence waits instead of deadlocking; with the refresh row locked, an expiry and
 * the release that would make the row claimable never both win.
 * GST-1582: one held for an import that has not landed within the limit of its hold ends `pending_import_expired` the
 * same way, except a `remember`, which ends as its `pending_import` refusal did (conflict `source_changed`, origin
 * `pending_import`), so the first sync that imports the file replays the fact. Its claim and its expiry both move the row,
 * so the expiry checks the row is still unclaimed and its import still pending with the sources row locked FOR SHARE
 * (after the protocol's brain lock, the order a fence takes them in), so an import that is landing makes the check wait
 * and then see it landed. GST-1623: it also rechecks the hold it scanned (the same import and an age past the limit), so an
 * import and a new hold between the scan and the lock never expire the new hold. A write held again and again expires at
 * the ceiling counted from its admission (holdOverdue). An expired remember says whether a sync will replay it: only one that named its entity is replayed (failed-writes.ts).
 */
export async function expireDeferredWrites(engine: BrainEngine, hostId: string, signal?: AbortSignal): Promise<WriteRequest[]> {
  const [config] = await engine.executeRaw<{ ms: number }>(`SELECT ${MAX_WAIT_SQL} AS ms`, undefined, { signal });
  const maxWaitMs = Number(config?.ms ?? REFRESH_BARRIER_MAX_WAIT_MS);
  const expired = await engine.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r ${overdueDeferredFrom('$1', '$2::double precision')}
    ORDER BY r.sequence LIMIT 100`, [hostId, maxWaitMs], { signal });
  const finished: WriteRequest[] = [];
  for (const row of expired) {
    const done = await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      const [held] = await tx.executeRaw('SELECT 1 FROM persistence_worktree_refreshes WHERE id=$1::uuid AND released_at IS NULL FOR NO KEY UPDATE', [row.deferred_refresh_id]);
      if (!held) return null;
      return completeWrite(tx, row, 'failed', {}, { code: 'refresh_barrier_expired',
        message: `Request ${row.request_id} waited behind refresh ${row.deferred_refresh_id} for more than ${Math.round(maxWaitMs / 1000)} s, and the refresh has not finished, so nothing was applied. Check the refresh with gbrain sources writer status --source ${row.source_id} --json, then submit the write again with a new request_id.` });
    });
    if (done) finished.push(done);
  }
  const imports = await engine.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r ${overdueImportFrom('$1', '$2::double precision')}
    ORDER BY r.sequence LIMIT 100`, [hostId, maxWaitMs], { signal });
  await afterImportScan?.(imports);
  for (const row of imports) {
    const done = await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      const [held] = await tx.executeRaw(`SELECT 1 FROM persistence_requests r JOIN sources s ON s.id=r.source_id
        WHERE r.id=$1::uuid AND r.state='deferred' AND r.deferred_import_from=$2 AND COALESCE(s.last_commit,'')=r.deferred_import_from
          AND ${holdOverdue('$3::double precision')} FOR SHARE OF s`, [row.id, row.deferred_import_from, maxWaitMs]);
      if (!held) return null;
      const waited = `Request ${row.request_id} waited more than ${Math.round(maxWaitMs / 1000)} s`;
      const status = `gbrain sync status --source ${row.source_id} --json`;
      if (row.operation === 'remember') return completeWrite(tx, row, 'conflict', {}, { code: 'source_changed', detail: { origin: PENDING_IMPORT },
        message: `${waited} for managed sync to import a committed change to the file of ${row.slug}, and the import has not landed, so the fact is not saved yet. ${typeof row.intent?.entity_slug === 'string'
          ? `It is kept for one automatic replay attempt by the first managed sync that imports the file; until that replay commits, gbrain repair failed-writes --source ${row.source_id} lists it (a replay that is refused stays there for a person to replay).`
          : `It is kept, but it named no entity, so no sync replays it: gbrain repair failed-writes --source ${row.source_id} lists it for a person to replay once the source has synced.`} Do not save it again; check the source with ${status}.` });
      return completeWrite(tx, row, 'failed', {}, { code: 'pending_import_expired',
        message: `${waited} for managed sync to import a committed change to the file of ${row.slug}, and the import has not landed, so nothing was applied. Check the source with ${status}, then submit the write again with a new request_id.` });
    }).catch(error => { if ((error as { code?: string })?.code === 'write_claim_lost') return null; throw error; });
    if (done) finished.push(done);
  }
  return finished;
}

/**
 * Whether a deferred write still waits: behind a refresh not yet released, or (GST-1582) for an import that has not landed
 * (`sources.last_commit` still the commit it was held at). A read that fails counts as waiting.
 */
export async function deferredWaiting(engine: SqlEngine, row: Pick<WriteRequest, 'source_id' | 'deferred_refresh_id' | 'deferred_import_from'>): Promise<boolean> {
  const [held] = await engine.executeRaw<{ waiting: boolean }>(`SELECT
    ($1::uuid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes WHERE id=$1::uuid AND released_at IS NOT NULL))
    OR ($2::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sources WHERE id=$3 AND COALESCE(last_commit,'')<>$2::text)) AS waiting`,
  [row.deferred_refresh_id ?? null, row.deferred_import_from ?? null, row.source_id]).catch(() => [{ waiting: true }]);
  return held?.waiting !== false;
}

/** Writes admitted deferred that have not finished (waiting, or claimed and still publishing), for `gbrain upgrade --check-downgrade`. */
export async function deferredBacklog(engine: SqlEngine): Promise<{ count: number; oldest_age_ms: number }> {
  const [row] = await engine.executeRaw<{ count: number; oldest_age_ms: number | null }>(`SELECT count(*)::int AS count,
    (EXTRACT(EPOCH FROM now()-min(created_at))*1000)::bigint AS oldest_age_ms FROM persistence_requests
    WHERE (deferred_refresh_id IS NOT NULL OR deferred_import_from IS NOT NULL) AND state IN ('deferred','queued','running','recovering')`);
  return { count: Number(row?.count ?? 0), oldest_age_ms: Number(row?.oldest_age_ms ?? 0) };
}

let afterImportScan: ((rows: WriteRequest[]) => Promise<void>) | null = null;
/** Test seam: runs between the expiry's scan of import holds and their transactions. */
export function _setAfterImportExpiryScanForTests(fn: typeof afterImportScan): void { afterImportScan = fn; }

/** Test seam: forget every cached refresh diff. */
export function _resetRefreshBarrierCacheForTests(): void { changed.clear(); }
