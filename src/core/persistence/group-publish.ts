/**
 * Grouped publication: one transaction publishes a claimed run of consecutive
 * requests of one worktree that share a group key (journal.ts
 * `publicationGroupKey`): the database-only pages of a bulk managed sync
 * (#5984, ENG-A3/A4) or the pages of one `put_pages` batch, files included
 * (#6007).
 *
 * Every member keeps its own request row, authorization, page guard,
 * visibility check, revision check, attribution, effects and receipt; only
 * the per-transaction work is shared: the worktree lock, the recovery and
 * capacity checks, the ownership guard, the counter and request locks, the
 * recovery records (one transaction records all of them before any file is
 * touched) and their cleanup (one transaction after commit). Counters are
 * locked after the members are applied and before their request rows, so the
 * brain-wide counter row is held only for the completion statements (ENG-A5).
 * A group therefore takes page guards before counters, the reverse of single
 * publication and of forget/mirror recovery; a deadlock with one of those on
 * the same page is detected by Postgres (40P01) and both sides retry: the
 * group falls back to single publication, admission and withdrawal retry.
 *
 * The group is all-or-nothing. Any failure rolls the transaction back; files
 * already published inside it are restored from their recovery records by
 * the ordinary recovery path (`recoverPublication`, which also requeues their
 * claims), and the caller then publishes the members one at a time, so a
 * failure is attributed to its own page and no later member overtakes it.
 * A member with a skill bundle or a source-exclusive checkpoint, or whose
 * file changed since preparation, takes the single path.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeStoredRequest } from './authority.ts';
import { localHostId } from './identity.ts';
import { acquireWorktree, acquireWorktreeShared, getWorktreeBinding, guardOwnership } from './ownership.ts';
import { awaitLaneBegin, awaitLaneTurn, LaneAbort, laneClaimed, laneFinished, stepDownLanes, type LaneState } from './sync-lanes.ts';
import { cancelRows, windowPredecessor } from './sync-window.ts';
import { clearResolvedRecoveries, completeWrite, ENSURE_COUNTERS_SQL, getWriteRequestById, LOCK_COUNTERS_SQL, markRecovering, prepareRecoveries,
  publicationGroupKey, reclaimReleasedWrite, releaseUnpublishedClaim, renewGroupClaims } from './journal.ts';
import { principalKey, requestPrincipal, type FileRecoveryRecord, type WriteRequest } from './model.ts';
import { CLAIM_LOST, DEFAULT_CLAIM_LEASE_TIMING, endLostLease, startClaimLease, type ClaimLeaseTiming } from './claim-lease.ts';
import { setMemberAttribution, withCoordinatedWrite } from './context.ts';
import { requestAttribution } from './attribution.ts';
import { tryAcquirePublicationCapacity } from './pool-capacity.ts';
import { queuePublicationEffects, queuesMentionLinks, reconcileFinishedBatch } from './effect-journal.ts';
import { assertUnboundPublication, classifyUnboundPage } from './unbound-source.ts';
import { declareDurablePersistence } from './protocol.ts';
import { classifyMirrorPage, sourceMirrorReadOnly } from './mirror-read-only.ts';
import { authorizePageVisibility } from './page-visibility.ts';
import { withFilesystemPublication } from './filesystem-guard.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { decoratePublicationOutcome, finishUnpublishedFailure, pageRecoveryRecord, persistenceFileHash, publicationPostimage, publishMutation,
  publishPersistenceFile, recoverPublication, type PreparedMutation } from './coordinator.ts';
import { pipelined } from '../page-state/transactions.ts';
import { jsonBytes } from './digest.ts';
import { writerStamp } from './writer-versions.ts';
import { recordPublicationFenceTrend } from '../fence-repair/census-store.ts';

/** A `put_pages` group publishes at most this many pages per transaction, so one commit stays a few seconds long. */
export const PAGE_BATCH_GROUP_MAX = 8;

function syncMember(row: WriteRequest): boolean {
  return row.operation === 'submit_job' && (row.intent?.kind === 'managed_sync_import' || row.intent?.kind === 'managed_sync_delete');
}

/** Whether a prepared member can share a group transaction. */
export function groupable(row: WriteRequest, prepared: PreparedMutation): boolean {
  if ((row.target_kind ?? 'page') !== 'page' || prepared.target === 'skill_bundle' || prepared.sourceExclusive || prepared.exclusiveSources?.length) return false;
  if (syncMember(row)) return !prepared.file && typeof prepared.validate === 'function';
  return publicationGroupKey(row)?.startsWith('batch:') === true;
}

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
/**
 * Reads a group transaction repeats for every member and whose answer cannot
 * change before it commits: the source's local path (its source row is held
 * FOR SHARE by authorization, whose own reads `transactionMemo` answers) and
 * the owner's host binding (its worktree row is held FOR SHARE by the
 * ownership guard). Nothing in a page publication writes them.
 */
const STABLE_IN_GROUP = new Set([
  'SELECT local_path FROM sources WHERE id=$1 AND incarnation=$2::uuid',
  'SELECT h.local_path FROM persistence_host_bindings h JOIN persistence_worktrees w ON w.id=h.worktree_id AND w.owner_host_id=h.host_id WHERE w.id=$1::uuid',
]);
/**
 * #6007: the group transaction seen through a per-transaction read snapshot.
 * The stable reads above and config values (`getConfig`, one consistent value
 * per key for every member) are answered once; every other call reaches the
 * transaction unchanged. It lives only for one group transaction, so nothing
 * survives a rollback.
 */
function groupReads(tx: BrainEngine): BrainEngine {
  const reads = new Map<string, Promise<unknown>>();
  const once = <T>(id: string, read: () => Promise<T>): Promise<T> => {
    let value = reads.get(id) as Promise<T> | undefined;
    if (!value) { value = read(); reads.set(id, value); value.catch(() => reads.delete(id)); }
    return value;
  };
  return new Proxy(tx, { get(target, key) {
    if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) =>
      STABLE_IN_GROUP.has(flat(sql)) ? once(JSON.stringify([flat(sql), params ?? null]), () => target.executeRaw(sql, params, opts)) : target.executeRaw(sql, params, opts);
    if (key === 'getConfig') return (name: string) => once(`config:${name}`, () => target.getConfig(name));
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** Test seams around a group's commit and its rollback. */
export interface GroupHooks {
  beforeCommit?(rows: WriteRequest[]): Promise<void>;
  /** After a failed group transaction and the restoration of any file it published. */
  rolledBack?(rows: WriteRequest[]): Promise<void>;
}

/**
 * Publishes the whole group or nothing. `done` null means the transaction did
 * not commit; `requeued` lists members whose claims the file restoration
 * released, which the caller may claim again while it holds the worktree.
 */
export async function publishGroup(engine: BrainEngine, rows: WriteRequest[], prepared: PreparedMutation[], hostId = localHostId(),
  hooks: GroupHooks = {}, lane: LaneState | null = null): Promise<{ done: WriteRequest[] | null; requeued: string[]; reason?: GroupFailure }> {
  const head = rows[0];
  const none: { done: null; requeued: string[]; reason?: GroupFailure } = { done: null, requeued: [] };
  if (!head?.worktree_id || rows.some((row, i) => row.worktree_id !== head.worktree_id || row.source_id !== head.source_id || !groupable(row, prepared[i]!))) return none;
  const binding = await getWorktreeBinding(engine, head.source_id, hostId);
  if (!binding || binding.owner_host_id !== hostId || !binding.local_path) return none;
  // #5984 lanes: lane groups share this process's native lock; everything else takes it exclusively.
  const lock = lane ? await acquireWorktreeShared(binding, engine) : await acquireWorktree(binding, 0, undefined, engine);
  if (!lock) return { ...none, reason: 'busy' };
  if (lane) lane.coordinationPath ??= binding.coordination_path;
  let releaseCapacity: (() => void) | null = null;
  const recorded = new Map<number, { row: WriteRequest; record: FileRecoveryRecord; bytes: number }>();
  let committed = false;
  try {
    const blocked = await engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE worktree_id=$1::uuid AND NOT (id=ANY($2::uuid[])) AND recovery IS NOT NULL
      UNION ALL SELECT 1 FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1`, [head.worktree_id, rows.map(row => row.id)]);
    if (blocked.length) return none;
    releaseCapacity = tryAcquirePublicationCapacity(engine, lane ? lane.effective + 1 : undefined);
    if (!releaseCapacity) return { ...none, reason: 'busy' };
    const files = new Map<number, { row: WriteRequest; record: FileRecoveryRecord; bytes: number }>();
    for (let i = 0; i < rows.length; i++) {
      const file = prepared[i]!.file;
      if (!file || prepared[i]!.noop) continue;
      if (!isWriteTargetContained(file.path, file.root)) return none;
      const member = { row: rows[i]!, ...pageRecoveryRecord(rows[i]!, file, binding) };
      // A file that moved since preparation takes the single path, which decides between reprepare and refusal.
      if (file.expectedBeforeHash !== undefined && member.record.beforeHash !== file.expectedBeforeHash) return none;
      files.set(i, member);
    }
    if (files.size) {
      await prepareRecoveries(engine, [...files.values()]);
      for (const [i, member] of files) recorded.set(i, member);
    }
    if (lane) await awaitLaneBegin(lane, rows);
    const done = await engine.transaction(async transaction => {
      const tx = groupReads(transaction);
      await declareDurablePersistence(tx);
      const live = await guardOwnership(tx, head, hostId);
      if (String(live?.owner_epoch) !== String(binding.owner_epoch)) throw new OperationError('owner_unavailable', 'Owner epoch changed before publication.', 'Inspect the source owner with gbrain sources writer status; do not claim or transfer the source to push this write.');
      if (recorded.size) {
        // A published file needs recovery even if this transaction rolls back; claims are verified first.
        const members = [...recorded.values()].map(member => member.row);
        const started = await tx.executeRaw(`UPDATE persistence_requests r SET publication_started=true FROM unnest($1::uuid[],$2::uuid[]) AS t(id,token)
          WHERE r.id=t.id AND r.execution_token=t.token AND r.state='running' RETURNING r.id`, [members.map(row => row.id), members.map(row => row.execution_token)]);
        if (started.length !== members.length) throw new OperationError('write_claim_lost', 'Execution claim changed before publication.', 'Another worker holds the request; inspect it rather than resubmitting.');
        if (await sourceMirrorReadOnly(tx, head.source_id, true)) throw new OperationError('source_changed', 'The source became a read-only mirror after this write was prepared.', 'The members publish one at a time.');
      }
      await tx.lockPageKeys(rows.flatMap((row, i) => [{ sourceId: row.source_id, slug: row.slug }, ...(prepared[i]!.additionalPageKeys ?? [])]));
      const outcomes: Record<string, unknown>[] = [];
      // One coordinated write for the group; each member is the attributed actor of what it writes.
      await withCoordinatedWrite(tx, [head.source_id], async () => {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!, member = prepared[i]!, file = recorded.get(i);
          await authorizeStoredRequest(tx, row, true, { pageVisibility: false });
          if (!syncMember(row)) await assertKnowledgePublicationAllowed(tx, row, member.file);
          const snapshot = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
          await authorizePageVisibility(tx, row.authority, row.slug);
          if ((snapshot?.page.id ?? null) !== row.page_id) throw new OperationError('page_identity_changed', 'The accepted page was deleted or recreated.', 'Read the page again and submit a new intent with a new request_id.');
          await assertUnboundPublication(tx, row, snapshot?.page.source_path);
          if ((snapshot?.revision ?? null) !== member.observedRevision) throw new OperationError('revision_conflict', 'The page changed during preparation.', 'Read its current revision and submit the updated intent with a new request_id.');
          await member.validate?.(tx);
          if (file) {
            if (persistenceFileHash(file.record.path) !== file.record.beforeHash) throw new OperationError('unexpected_file_bytes', 'The canonical file changed during preparation.', 'The members publish one at a time.');
            await withFilesystemPublication([file.record.root], async () => publishPersistenceFile(member.file!, file.record.staging?.publication?.path));
          }
          await setMemberAttribution(tx, requestAttribution(row));
          member.postimage = undefined;
          const outcome = await member.apply(tx, snapshot);
          await classifyUnboundPage(tx, row);
          if (member.databaseOnlyReason === 'mirror_read_only') await classifyMirrorPage(tx, row);
          const final = await publicationPostimage(tx, row, member);
          decoratePublicationOutcome(row, member, outcome, final, file ? 1 : 0, false);
          await recordPublicationFenceTrend(tx, row, outcome);
          await queuePublicationEffects(tx, row, final, outcome, member, { deferBatchReconcile: true });
          outcomes.push(outcome);
        }
      }, requestAttribution(head));
      // #5984 lanes: applied concurrently, committed in manifest order.
      if (lane) await awaitLaneTurn(tx, lane, rows);
      const done = await completeGroup(tx, rows, outcomes);
      // Every member is complete in this transaction: the batch's last page re-arms the batch's mention links once.
      const last = rows[rows.length - 1]!;
      if (publicationGroupKey(last)?.startsWith('batch:') && queuesMentionLinks(last)) await reconcileFinishedBatch(tx, last);
      await hooks.beforeCommit?.(rows);
      return done;
    });
    committed = true;
    if (recorded.size) {
      try { await clearResolvedRecoveries(engine, done); }
      catch {
        // The ordinary recovery pass finishes cleanup of a committed receipt, or blocks its worktree on unexpected bytes.
        for (const row of done) if (row.recovery) {
          try { await recoverPublication(engine, row.id, hostId, true, undefined, true); } catch { /* the recovery scan retries */ }
        }
      }
    }
    return { done, requeued: [] };
  } catch (error) {
    if (committed || !recorded.size) { await hooks.rolledBack?.(rows); return { ...none, reason: groupFailure(error) }; }
    // Restore every file this group may have published and release those claims; a committed member (an uncertain commit) only cleans up.
    const requeued: string[] = [];
    for (const { row } of recorded.values()) {
      try {
        await markRecovering(engine, row, 'publication_not_started');
        const recovered = await recoverPublication(engine, row.id, hostId, true, undefined, true);
        if (recovered.state === 'queued' && !recovered.recovery) requeued.push(row.id);
      } catch { /* the recovery record stays; the worktree waits for the recovery scan */ }
    }
    await hooks.rolledBack?.(rows);
    return { done: null, requeued };
  } finally {
    releaseCapacity?.();
    await lock.release();
  }
}

/** Why a group transaction did not commit, for the lane fallback and step-down. */
export type GroupFailure = 'busy' | 'predecessor_failed' | 'predecessor_requeued' | 'wounded' | 'order_timeout' | 'lock_timeout' | 'statement_timeout' | 'failed';
function groupFailure(error: unknown): GroupFailure {
  if (error instanceof LaneAbort) return error.reason;
  const code = (error as { code?: unknown } | null)?.code;
  return code === '55P03' ? 'lock_timeout' : code === '57014' ? 'statement_timeout' : 'failed';
}

/**
 * #5984 lanes: a lane group that did not commit. A group whose predecessor ended without committing is
 * cancelled; one whose predecessor committed takes the single path like any FIFO head (null); one whose
 * predecessor still publishes, waits in the queue or is not admitted yet releases its claims so it runs first. Lock and statement timeouts
 * cost one lane for the rest of the drain.
 */
async function laneFallback(engine: BrainEngine, rows: WriteRequest[], reason: GroupFailure | undefined, run: GroupExecution): Promise<boolean | null> {
  if (run.lane) run.lane.fallbacks++;
  if (reason === 'lock_timeout' || reason === 'statement_timeout') stepDownLanes(rows[0]!.worktree_id!, `${reason} on a lane group`);
  const after = windowPredecessor(rows[0]!);
  const prior = after ? await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid',
    [rows[0]!.principal_kind, rows[0]!.principal_id, after]).then(found => found[0]?.state ?? null) : 'committed';
  if (prior === 'committed') return null;
  if (prior !== null && ['failed', 'conflict', 'cancelled'].includes(prior)) {
    for (const done of await cancelRows(engine, rows)) run.settled(done);
    return true;
  }
  for (const row of rows) await releaseUnpublishedClaim(engine, row, 'group_member_waiting');
  return false;
}

/**
 * #5984: completes every member's request row in one statement. Each member's
 * queued effect bytes are read (and missing counter rows created) before the
 * counters are locked; then the counter lock (`brain`, each principal,
 * `worktree:<id>`, the order every completion uses) and one UPDATE that checks
 * each member's claim (`execution_token`, `state='running'`) and terminal
 * reservation, completes the rows and decrements the counters, are pipelined.
 * If the UPDATE returns fewer rows than the group, this throws so the
 * transaction rolls back; the group then takes the single path, where
 * completeWrite reports each member's exact error code. JSON binds as text.
 */
export async function completeGroup(tx: BrainEngine, rows: WriteRequest[], outcomes: Record<string, unknown>[]): Promise<WriteRequest[]> {
  const ids = rows.map(row => row.id);
  const keys = [...new Set(['brain', ...rows.map(row => principalKey(requestPrincipal(row))), `worktree:${rows[0]!.worktree_id}`])].sort();
  const [effects] = await pipelined(tx, [
    () => tx.executeRaw<{ request_id: string; bytes: string }>(`SELECT request_id::text AS request_id,SUM(octet_length(data::text)+octet_length(kind)+1024)::text AS bytes
      FROM persistence_effects WHERE request_id=ANY($1::uuid[]) GROUP BY request_id`, [ids]),
    () => tx.executeRaw(ENSURE_COUNTERS_SQL, [keys]),
  ]) as [Array<{ request_id: string; bytes: string }>];
  const effectBytes = new Map(effects.map(e => [e.request_id, Number(e.bytes)]));
  const stamp = writerStamp();
  const [, completed] = await pipelined(tx, [
    () => tx.executeRaw(LOCK_COUNTERS_SQL, [keys]),
    () => tx.executeRaw<WriteRequest & { principal_key: string }>(`WITH m AS (
        SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::text[],$4::bigint[],$5::text[]) AS m(id,token,outcome,need,principal_key)
      ), done AS (
        UPDATE persistence_requests r SET state='committed',outcome=m.outcome::jsonb,error_code=NULL,error_message=NULL,
          completed_at=now(),updated_at=now(),claim_expires_at=NULL,blocked_reason=NULL,
          consumer_version=$6,consumer_host_id=$7::uuid,published_at=now()
        FROM m WHERE r.id=m.id AND r.execution_token=m.token AND r.state='running' AND m.need<=r.terminal_reservation
        RETURNING r.*,m.principal_key
      ), released AS (
        UPDATE persistence_counters c SET outstanding_count=c.outstanding_count-d.n,intent_bytes=c.intent_bytes-d.bytes
        FROM (SELECT k.key,count(*) AS n,SUM(done.intent_bytes) AS bytes FROM done CROSS JOIN LATERAL (VALUES ('brain'),(done.principal_key)) AS k(key) GROUP BY k.key) d
        WHERE c.key=d.key
      )
      SELECT * FROM done`, [ids, rows.map(row => row.execution_token), outcomes.map(outcome => JSON.stringify(outcome)),
      rows.map((row, i) => jsonBytes(outcomes[i]) + jsonBytes(row.authority) + 1024 + (effectBytes.get(row.id) ?? 0)),
      rows.map(row => principalKey(requestPrincipal(row))), stamp.version, stamp.hostId]),
  ]) as [unknown, Array<WriteRequest & { principal_key: string }>];
  if (completed.length !== rows.length) throw new OperationError('write_claim_lost', 'A group member failed its claim or terminal-reservation check before publication.',
    'The group rolls back and its members publish one at a time, where each member reports its own outcome; inspect the requests rather than resubmitting.');
  const byId = new Map(completed.map(({ principal_key: _key, ...row }) => [row.id, row as WriteRequest]));
  return rows.map(row => byId.get(row.id)!);
}

export interface GroupExecution {
  /** #5984 lanes: the open lane run this group belongs to in this process. */
  lane?: LaneState | null;
  prepare(row: WriteRequest): Promise<PreparedMutation>;
  settled(row: WriteRequest): void;
  hostId: string;
  hooks?: GroupHooks;
  /** #5373: renewal timing for the group's claims (default DEFAULT_CLAIM_LEASE_TIMING). */
  lease?: ClaimLeaseTiming;
  /**
   * #5373: receives work still running when the group lets go of its claims: the
   * renewal in flight, or (`blocksRoot`) the preparation abandoned after a lost claim.
   */
  leftRunning?(work: Promise<unknown>, blocksRoot: boolean): void;
}

/**
 * Prepares a claimed group (four members at a time), publishes it in one
 * transaction when every member qualifies, and otherwise publishes the
 * members one at a time in order. After a member ends in failure the later
 * members are cancelled, and after one is released back to the queue the
 * later ones are released too, so nothing overtakes it. Claims are renewed
 * for the whole group while it runs (claim-lease.ts). If the group stops
 * holding every member's claim while it is still preparing, it lets go: each
 * member is released unpublished with `claim_lost` (token-fenced, so a member
 * another consumer took over keeps its new claim) and the unfinished
 * preparation goes to `leftRunning`, never to publication. Returns whether
 * any member settled.
 */
export async function executeClaimedGroup(engine: BrainEngine, rows: WriteRequest[], run: GroupExecution): Promise<boolean> {
  const lease = startClaimLease(async signal => (await renewGroupClaims(engine, rows, 30_000, signal)).size === rows.length,
    run.lease ?? DEFAULT_CLAIM_LEASE_TIMING);
  if (run.lane) laneClaimed(run.lane, rows);
  try {
    const prepared: Array<{ ok: PreparedMutation } | { error: unknown }> = new Array(rows.length);
    // A put_pages group prepares all of its (at most PAGE_BATCH_GROUP_MAX) pages at once.
    const width = publicationGroupKey(rows[0]!)?.startsWith('batch:') ? PAGE_BATCH_GROUP_MAX : 4;
    const preparing = (async () => {
      for (let start = 0; start < rows.length; start += width) {
        await Promise.all(rows.slice(start, start + width).map(async (row, offset) => {
          try { prepared[start + offset] = { ok: await run.prepare(row) }; } catch (error) { prepared[start + offset] = { error }; }
        }));
      }
    })();
    if (await lease.whileHeld(preparing) === CLAIM_LOST) {
      run.leftRunning?.(preparing, true);
      await endLostLease(lease);
      for (const row of rows) await releaseUnpublishedClaim(engine, row, 'claim_lost');
      return false;
    }
    // A put_pages batch is independent page writes: one page's failure never cancels its siblings.
    const independent = publicationGroupKey(rows[0]!)?.startsWith('batch:') === true;
    let requeued = new Set<string>();
    if (prepared.every(p => 'ok' in p)) {
      const result = await publishGroup(engine, rows, prepared.map(p => (p as { ok: PreparedMutation }).ok), run.hostId, run.hooks, run.lane ?? null);
      if (result.done) { for (const row of result.done) run.settled(row); return true; }
      requeued = new Set(result.requeued);
      if (run.lane) { const settled = await laneFallback(engine, rows, result.reason, run); if (settled !== null) return settled; }
    } else if (run.lane) {
      const settled = await laneFallback(engine, rows, 'failed', run);
      if (settled !== null) return settled;
    }
    let progressed = false, stop: 'cancel' | 'release' | null = null;
    for (let i = 0; i < rows.length; i++) {
      let row = rows[i]!;
      let current = await getWriteRequestById(engine, row.id);
      // A claim the group's file restoration released is taken back, in order, while this pass still owns the worktree.
      if (current?.state === 'queued' && requeued.has(row.id) && stop === null) {
        const reclaimed = await reclaimReleasedWrite(engine, row.id);
        if (reclaimed) { row = reclaimed; current = reclaimed; }
      }
      if (!current || current.execution_token !== row.execution_token || current.state !== 'running') {
        if (current && ['committed', 'conflict', 'failed', 'cancelled'].includes(current.state)) { run.settled(current); progressed = true; if (current.state !== 'committed' && !independent) stop ??= 'cancel'; }
        else if (independent) stop ??= 'release';
        continue;
      }
      if (stop === 'release') { await releaseUnpublishedClaim(engine, row, 'group_member_waiting'); continue; }
      if (stop === 'cancel') {
        const cancelled = await engine.transaction(tx => completeWrite(tx, current, 'cancelled', {}, { code: 'cancelled',
          message: 'An earlier page of the same bulk sync group failed; this page was not published and is re-frozen after that failure is resolved.' }));
        run.settled(cancelled); progressed = true; continue;
      }
      const p = prepared[i]!;
      const done = 'ok' in p ? await publishMutation(engine, row, p.ok, run.hostId) : await finishUnpublishedFailure(engine, current, p.error, 'preparation');
      run.settled(done);
      if (done.state === 'committed') { progressed = true; continue; }
      if (['conflict', 'failed', 'cancelled'].includes(done.state)) { progressed = true; if (!independent) stop = 'cancel'; } else stop = 'release';
    }
    return progressed;
  } finally {
    if (run.lane) laneFinished(run.lane, rows);
    const renewal = lease.end();
    if (renewal) run.leftRunning?.(renewal, false);
  }
}
