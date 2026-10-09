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
 *
 * Phase 4.1: an eligible single page write (`publishSingleWrite`) also
 * publishes here, as a group of one, on Postgres. Its intent carries no group
 * marker, so its request identity and replay are unchanged; when the group
 * does not commit it takes `publishMutation` like any other member.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeStoredRequest, storedAuthorizationReads } from './authority.ts';
import { localHostId } from './identity.ts';
import { acquireWorktree, acquireWorktreeShared, getWorktreeBinding, guardOwnership, joinWorktreeLease } from './ownership.ts';
import { awaitLaneBegin, awaitLaneTurn, LaneAbort, laneApplyBegin, laneClaimed, laneFinished, lanePolicy, stepDownLanes, type LaneState } from './sync-lanes.ts';
import { cancelRows, windowPredecessor } from './sync-window.ts';
import { clearResolvedRecoveries, completeWrite, ENSURE_COUNTERS_SQL, getWriteRequestById, LOCK_COUNTERS_SQL, markDispatched, markRecovering, prepareRecoveries,
  foregroundPriority, independentGroup, publicationGroupKey, reclaimReleasedWrite, releaseUnpublishedClaim, renewGroupClaims } from './journal.ts';
import { principalKey, requestPrincipal, type FileRecoveryRecord, type WriteRequest } from './model.ts';
import { CLAIM_LOST, DEFAULT_CLAIM_LEASE_TIMING, endLostLease, startClaimLease, type ClaimLeaseTiming } from './claim-lease.ts';
import { claimPhaseStamp, enterClaimPhase, startClaimPhase, type ClaimPhaseClock } from './claim-phase.ts';
import { DEFAULT_PREPARATION_POLICY, preparationBudgetMs, startPreparation, type PreparationPolicy, type PreparationRun } from './preparation-budget.ts';
import { setMemberAttribution, withCoordinatedWrite } from './context.ts';
import { publicationAttribution } from './attribution.ts';
import { tryAcquirePublicationCapacity } from './pool-capacity.ts';
import { queuePublicationEffects, queuesMentionLinks, reconcileFinishedBatch } from './effect-journal.ts';
import { assertUnboundPublication, classifyUnboundPage } from './unbound-source.ts';
import { declareDurablePersistence } from './protocol.ts';
import { classifyMirrorPage, sourceMirrorReadOnly } from './mirror-read-only.ts';
import { authorizePageVisibility } from './page-visibility.ts';
import { withFilesystemPublication } from './filesystem-guard.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { decoratePublicationOutcome, finishPreparationStalled, finishUnpublishedFailure, pageRecoveryRecord, persistenceFileHash, preparationAbortReason, publicationPostimage, publishMutation,
  publishPersistenceFile, recoverPublication, type PreparedMutation } from './coordinator.ts';
import { pipelined } from '../page-state/transactions.ts';
import { jsonBytes } from './digest.ts';
import { readJournalLimits } from './limits.ts';
import type { JournalLimits } from './model.ts';
import { writerStamp } from './writer-versions.ts';
import { recordPublicationFenceTrend } from '../fence-repair/census-store.ts';
import { faultPoint, type PublicationBoundary } from './fault-points.ts';
import { assertMutationProtocol } from './protocol.ts';
import { writeSwitchOn } from './switches.ts';

/** A `put_pages` or managed import group publishes at most this many pages per transaction, so one commit stays a few seconds long. */
export const PAGE_BATCH_GROUP_MAX = 8;

function syncMember(row: WriteRequest): boolean {
  return row.operation === 'submit_job' && (row.intent?.kind === 'managed_sync_import' || row.intent?.kind === 'managed_sync_delete');
}

/** Single page writes that may publish as a group of one (Phase 4.1); owner-internal kinds keep the single path. */
const SINGLE_GROUP_OPERATIONS = new Set(['put_page', 'capture', 'edit_page', 'delete_page', 'restore_page', 'revert_version']);
export function singleWrite(row: Pick<WriteRequest, 'operation' | 'intent'>): boolean {
  return SINGLE_GROUP_OPERATIONS.has(row.operation) && !row.intent?.kind && publicationGroupKey(row) === null;
}

/** Whether a prepared member can share a group transaction. */
export function groupable(row: WriteRequest, prepared: PreparedMutation): boolean {
  if ((row.target_kind ?? 'page') !== 'page' || prepared.target === 'skill_bundle' || prepared.sourceExclusive || prepared.exclusiveSources?.length) return false;
  if (syncMember(row)) return !prepared.file && typeof prepared.validate === 'function';
  return independentGroup(publicationGroupKey(row)) || singleWrite(row);
}

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
/**
 * Reads a group transaction repeats for every member and whose answer cannot
 * change before it commits: the source's local path (its source row is held
 * FOR SHARE by authorization, whose own reads `transactionMemo` answers) and
 * the owner's host binding (its worktree row is held FOR SHARE by the
 * ownership guard). Nothing in a page publication writes them.
 */
const HOST_BINDING_SQL = 'SELECT h.local_path FROM persistence_host_bindings h JOIN persistence_worktrees w ON w.id=h.worktree_id AND w.owner_host_id=h.host_id WHERE w.id=$1::uuid';
const STABLE_IN_GROUP = new Set([
  'SELECT local_path FROM sources WHERE id=$1 AND incarnation=$2::uuid',
  HOST_BINDING_SQL,
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

/**
 * #5984: reads a claimed group's preparation repeats for every member and that
 * publication checks again inside the group transaction (the local writer, the
 * source binding and root, the coordinator switch, the shared skill packs), plus
 * the source's own row. Plain reads only; a locking read is never answered here.
 */
const STABLE_IN_PREPARATION = new Set([
  'SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid',
  'SELECT s.source_id,s.source_incarnation,s.worktree_id,s.relative_path, s.topology_generation::text AS topology_generation,w.owner_host_id,w.owner_epoch::text AS owner_epoch,w.state, h.local_path,h.coordination_path FROM persistence_source_bindings s JOIN persistence_worktrees w ON w.id=s.worktree_id LEFT JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=$2::uuid WHERE s.source_id=$1',
  'SELECT local_path FROM sources WHERE id=$1',
  'SELECT enabled FROM persistence_brain WHERE singleton=1',
  "SELECT to_regclass('shared_skill_packs') IS NOT NULL AS present",
  'SELECT p.source_id,p.source_incarnation,s.local_path AS source_root, h.local_path AS worktree_root,b.relative_path FROM shared_skill_packs p JOIN sources s ON s.id=p.source_id AND s.incarnation=p.source_incarnation LEFT JOIN persistence_source_bindings b ON b.source_id=p.source_id AND b.source_incarnation=p.source_incarnation LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid',
  'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at, contextual_retrieval_mode, trust_frontmatter_overrides FROM sources WHERE id = $1',
]);
/**
 * #5984: the engine a claimed group's members are prepared with. The reads
 * above and config values (`getConfig`, `getAllConfig`) are answered once for
 * the whole preparation, as if every member were prepared at the same moment;
 * publication re-checks what it relies on under its locks. It lives only for
 * one group's preparation; a failed read is not kept.
 */
export function preparationReads(engine: BrainEngine): BrainEngine {
  const reads = new Map<string, Promise<unknown>>();
  const once = <T>(id: string, read: () => Promise<T>): Promise<T> => {
    let value = reads.get(id) as Promise<T> | undefined;
    if (!value) { value = read(); reads.set(id, value); value.catch(() => reads.delete(id)); }
    return value;
  };
  return new Proxy(engine, { get(target, key) {
    // A shared read takes no member's signal: a caller's own signal bypasses the memo, and (#6278) a bounded preparation read
    // (`timeoutMs`, whose signal only covers its connection wait) is answered once with the member's bound and signal dropped.
    if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: { signal?: AbortSignal; timeoutMs?: number }) =>
      STABLE_IN_PREPARATION.has(flat(sql)) && (!opts?.signal || opts.timeoutMs !== undefined)
        ? once(JSON.stringify([flat(sql), params ?? null]), () => target.executeRaw(sql, params)) : target.executeRaw(sql, params, opts);
    if (key === 'getConfig') return (name: string) => once(`config:${name}`, () => target.getConfig(name));
    if (key === 'getAllConfig') return () => once('config:*', () => target.getAllConfig()).then(all => ({ ...all }));
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** Test seams around a group's commit and its rollback. */
export interface GroupHooks {
  beforeCommit?(rows: WriteRequest[]): Promise<void>;
  /** After a failed group transaction and the restoration of any file it published. */
  rolledBack?(rows: WriteRequest[]): Promise<void>;
  /** Right after the commit, before the recovery records are cleared: the committed rows, for waiters. */
  committed?(rows: WriteRequest[]): void;
}

/**
 * Publishes the whole group or nothing. `done` null means the transaction did
 * not commit; `requeued` lists members whose claims the file restoration
 * released, which the caller may claim again while it holds the worktree.
 */
/** Runs one transaction: `engine.transaction`, or a reserved connection's (Phase 4.4). */
export type TransactionRunner = <T>(fn: (tx: BrainEngine) => Promise<T>) => Promise<T>;

/** #5984 Phase 4.5: foreground writes publishing beside this process's lane groups, until their recovery record is cleared. */
const publishingBeside = new Set<string>();

export async function publishGroup(engine: BrainEngine, rows: WriteRequest[], prepared: PreparedMutation[], hostId = localHostId(),
  hooks: GroupHooks = {}, lane: LaneState | null = null, transaction: TransactionRunner = fn => engine.transaction(fn)): Promise<{ done: WriteRequest[] | null; requeued: string[]; reason?: GroupFailure }> {
  const head = rows[0];
  const none: { done: null; requeued: string[]; reason?: GroupFailure } = { done: null, requeued: [] };
  if (!head?.worktree_id || rows.some((row, i) => row.worktree_id !== head.worktree_id || row.source_id !== head.source_id || !groupable(row, prepared[i]!)
    || rows.length > 1 && singleWrite(row))) return none;
  const binding = await getWorktreeBinding(engine, head.source_id, hostId);
  if (!binding || binding.owner_host_id !== hostId || !binding.local_path) return none;
  // #5984 lanes: lane groups share this process's native lock; a foreground page write (Phase 4.5) joins their
  // lease and publishes beside them; everything else takes it exclusively.
  // With this process's lanes open on the worktree but none publishing, it opens the lease for them to join.
  const beside = !lane && rows.length === 1 && singleWrite(head) && await foregroundPriority(engine);
  const joined = beside ? joinWorktreeLease(binding) ?? ((lanePolicy(head.worktree_id)?.effective ?? 1) > 1 ? await acquireWorktreeShared(binding, engine) : null) : null;
  const lock = lane ? await acquireWorktreeShared(binding, engine) : joined ?? await acquireWorktree(binding, 0, undefined, engine, { yieldLanes: true });
  if (!lock) return { ...none, reason: 'busy' };
  if (joined) publishingBeside.add(head.id);
  if (lane) lane.coordinationPath ??= binding.coordination_path;
  let releaseCapacity: (() => void) | null = null;
  const recorded = new Map<number, { row: WriteRequest; record: FileRecoveryRecord; bytes: number }>();
  let committed = false;
  const timed: { apply: ReturnType<typeof laneApplyBegin> | null } = { apply: null };
  try {
    // The recovery check and the journal limits the recovery record is sized against go out together.
    // A lane group passes the recovery record of a foreground write this process publishes beside it (Phase 4.5,
    // another page); any other record still blocks it, and the group releases its claims to retry.
    const [blocked, limits] = await pipelined(engine, [
      () => engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE worktree_id=$1::uuid AND NOT (id=ANY($2::uuid[])) AND recovery IS NOT NULL
      UNION ALL SELECT 1 FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1`,
      [head.worktree_id, [...rows.map(row => row.id), ...(lane ? publishingBeside : [])]]),
      () => prepared.some(member => member.file && !member.noop) ? readJournalLimits(engine) : Promise.resolve(undefined),
    ]) as [unknown[], JournalLimits | undefined];
    if (blocked.length) return lane ? { ...none, reason: 'busy' } : none;
    releaseCapacity = tryAcquirePublicationCapacity(engine, lane ? lane.effective + 1 : joined ? Number.POSITIVE_INFINITY : undefined);
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
      await prepareRecoveries(engine, [...files.values()], transaction, limits);
      for (const [i, member] of files) recorded.set(i, member);
      for (const member of files.values()) await seam('prepared', member.row);
    }
    if (lane) await awaitLaneBegin(lane, rows);
    const done = await transaction(async opened => {
      timed.apply?.end(rows.length);
      if (lane) timed.apply = laneApplyBegin(lane);
      const tx = groupReads(opened);
      // #5984: the transaction's guards, locks and the members' shared authorization reads (answered from the memo
      // below) go out as one pipeline in the order they always took; they are judged in order, and any failure rolls
      // the whole transaction back.
      const members = [...recorded.values()].map(member => member.row);
      const keys = rows.flatMap((row, i) => [{ sourceId: row.source_id, slug: row.slug, incarnation: row.source_incarnation },
        ...(prepared[i]!.additionalPageKeys ?? []).map(key => key.sourceId === row.source_id ? { ...key, incarnation: row.source_incarnation } : key)]);
      const ready = pipelined(tx, [
        () => declareDurablePersistence(tx),
        () => guardOwnership(tx, head, hostId),
        // A published file needs recovery even if this transaction rolls back; claims are verified first.
        () => members.length ? tx.executeRaw(`UPDATE persistence_requests r SET publication_started=true FROM unnest($1::uuid[],$2::uuid[]) AS t(id,token)
          WHERE r.id=t.id AND r.execution_token=t.token AND r.state='running' RETURNING r.id`, [members.map(row => row.id), members.map(row => row.execution_token)]) : Promise.resolve([]),
        () => prepared.some(member => member.file) ? sourceMirrorReadOnly(tx, head.source_id, true) : Promise.resolve(false),
        () => tx.lockPageKeys(keys),
        // The owner's host binding every file member's Git effect records (a STABLE_IN_GROUP read), fetched with the guards.
        () => prepared.some(member => member.file && !member.noop) ? tx.executeRaw(HOST_BINDING_SQL, [head.worktree_id]) : Promise.resolve([]),
        ...storedAuthorizationReads(tx, rows, true),
      ]).then(results => {
        const [, live, started, readOnly] = results as [unknown, Awaited<ReturnType<typeof guardOwnership>>, unknown[], boolean];
        if (String(live?.owner_epoch) !== String(binding.owner_epoch)) throw new OperationError('owner_unavailable', 'Owner epoch changed before publication.', 'Inspect the source owner with gbrain sources writer status; do not claim or transfer the source to push this write.');
        if (started.length !== members.length) throw new OperationError('write_claim_lost', 'Execution claim changed before publication.', 'Another worker holds the request; inspect it rather than resubmitting.');
        // A file target prepared before the source became a read-only mirror is never published (as in publishMutation, noop included).
        if (readOnly) throw new OperationError('source_changed', 'The source became a read-only mirror after this write was prepared.', 'The members publish one at a time.');
      });
      // The coordinated write's settings statement follows that pipeline. When the pipeline fails first, the
      // transaction reports that failure (postgres.js names the cause of a 25P02 abort), not the settings statement's abort.
      ready.catch(() => undefined);
      const outcomes: Record<string, unknown>[] = [];
      // A member's lead (authorization, knowledge guard, its locked read) only reads; the first member's
      // is sent ahead of the coordinated-write settings statement, the others with the previous member's effects.
      const lead = (i: number) => pipelined(tx, [
        () => authorizeStoredRequest(tx, rows[i]!, true, { pageVisibility: false }),
        async () => { if (!syncMember(rows[i]!)) await assertKnowledgePublicationAllowed(tx, rows[i]!, prepared[i]!.file); },
        () => tx.readPageSnapshot(rows[i]!.slug, { sourceId: rows[i]!.source_id, includeDeleted: true }),
      ]) as Promise<[unknown, unknown, Awaited<ReturnType<BrainEngine['readPageSnapshot']>>]>;
      const first = lead(0);
      first.catch(() => undefined);
      // One coordinated write for the group; each member is the attributed actor of what it writes.
      await withCoordinatedWrite(tx, [head.source_id], async () => {
        await ready;
        // The previous member's effects (rows no attribution or page check depends on) go out with the next member's checks.
        let effects: (() => Promise<void>) | null = null;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!, member = prepared[i]!, file = recorded.get(i), sync = syncMember(row), previous = effects;
          // A group of one is already attributed to its only member (and its declared trust) by the coordinated write.
          const attribute = rows.length > 1;
          // #5984: a member's checks and reads are pipelined and run in their usual order, so the first failing one is reported.
          // A sync member validates alongside (read-only checks); a member that publishes a file sets its attribution after the file.
          const [, snapshot] = await pipelined(tx, [
            async () => { await previous?.(); },
            async () => {
              const [, , snapshot] = await (i === 0 ? first : lead(i));
              await authorizePageVisibility(tx, row.authority, row.slug);
              if ((snapshot?.page.id ?? null) !== row.page_id) throw new OperationError('page_identity_changed', 'The accepted page was deleted or recreated.', 'Read the page again and submit a new intent with a new request_id.');
              await assertUnboundPublication(tx, row, snapshot?.page.source_path);
              if ((snapshot?.revision ?? null) !== member.observedRevision) throw new OperationError('revision_conflict', 'The page changed during preparation.', 'Read its current revision and submit the updated intent with a new request_id.');
              return snapshot;
            },
            async () => { if (sync) await member.validate?.(tx); },
            async () => { if (!file && attribute) await setMemberAttribution(tx, publicationAttribution(row, member.trust)); },
          ]) as [unknown, Awaited<ReturnType<BrainEngine['readPageSnapshot']>>];
          if (!sync) await member.validate?.(tx);
          if (file) {
            if (persistenceFileHash(file.record.path) !== file.record.beforeHash) throw new OperationError('unexpected_file_bytes', 'The canonical file changed during preparation.', 'The members publish one at a time.');
            await seam('before_publication', row);
            await withFilesystemPublication([file.record.root], async () => publishPersistenceFile(member.file!, file.record.staging?.publication?.path));
            await seam('after_publication', row);
            if (attribute) await setMemberAttribution(tx, publicationAttribution(row, member.trust));
          }
          member.postimage = undefined;
          const outcome = await member.apply(tx, snapshot);
          await classifyUnboundPage(tx, row);
          if (member.databaseOnlyReason === 'mirror_read_only') await classifyMirrorPage(tx, row);
          const final = await publicationPostimage(tx, row, member);
          decoratePublicationOutcome(row, member, outcome, final, file ? 1 : 0, false);
          effects = async () => {
            await recordPublicationFenceTrend(tx, row, outcome);
            await queuePublicationEffects(tx, row, final, outcome, member, singleWrite(row) ? {} : { deferBatchReconcile: true });
          };
          outcomes.push(outcome);
        }
        await effects?.();
      }, publicationAttribution(head, prepared[0]!.trust));
      // #5984 lanes: applied concurrently, committed in manifest order.
      if (lane) { timed.apply?.turn(); await faultPoint('lane:applied', { requestId: head.request_id, sourceId: head.source_id, operation: head.operation }); await awaitLaneTurn(tx, lane, rows); timed.apply?.turned(); }
      const done = await completeGroup(tx, rows, outcomes);
      // Every member is complete in this transaction: the batch's last page re-arms the batch's mention links once.
      const last = rows[rows.length - 1]!;
      if (publicationGroupKey(last)?.startsWith('batch:') && queuesMentionLinks(last)) await reconcileFinishedBatch(tx, last);
      await hooks.beforeCommit?.(rows);
      for (const row of rows) await seam('before_commit', row);
      return done;
    });
    committed = true;
    for (const row of done) await seam('after_commit', row);
    hooks.committed?.(done);
    if (recorded.size) {
      try { await clearResolvedRecoveries(engine, done, transaction); }
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
    timed.apply?.end(rows.length);
    releaseCapacity?.();
    publishingBeside.delete(head.id);
    await lock.release();
  }
}

/** The publication crash seams (fault-points.ts) a member passes, named as in publishMutation. */
function seam(name: PublicationBoundary, row: WriteRequest): Promise<void> {
  return faultPoint(`publication:${name}`, { requestId: row.request_id, sourceId: row.source_id, operation: row.operation });
}

/**
 * Phase 4.1: publishes one claimed single page write as a group of one when
 * it qualifies (Postgres, a page target the group path accepts, the
 * `single_write_group` switch on), otherwise, or when that group does not
 * commit, through `publishMutation`. A claim the group's file restoration
 * released is taken back first; a request the group left recovering or that
 * another worker now holds is returned as it stands.
 */
export async function publishSingleWrite(engine: BrainEngine, row: WriteRequest, prepared: PreparedMutation, hostId = localHostId(), hooks: GroupHooks = {},
  transaction?: TransactionRunner): Promise<WriteRequest> {
  if (engine.kind !== 'postgres' || !singleWrite(row) || !groupable(row, prepared) || !await writeSwitchOn(engine, 'single_write_group').catch(() => true)) {
    return publishMutation(engine, row, prepared, hostId);
  }
  try { assertMutationProtocol(row); } catch { return publishMutation(engine, row, prepared, hostId); }
  const result = await publishGroup(engine, [row], [prepared], hostId, hooks, null, transaction);
  if (result.done) return result.done[0]!;
  let current = await getWriteRequestById(engine, row.id);
  if (current?.state === 'queued' && result.requeued.includes(row.id)) {
    const reclaimed = await reclaimReleasedWrite(engine, row.id);
    if (!reclaimed) return current;
    current = reclaimed;
  } else if (!current || current.execution_token !== row.execution_token) return current ?? row;
  if (current.state !== 'running' || current.recovery) return current;
  return publishMutation(engine, current, prepared, hostId);
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
  // A group that found the worktree busy (another holder or no publication capacity) releases its claims and is
  // claimed again as a lane head; publishing its members one at a time would hold the lanes back.
  if (prior === 'committed' && reason !== 'busy') return null;
  if (prior !== null && ['failed', 'conflict', 'cancelled'].includes(prior)) {
    for (const done of await cancelRows(engine, rows)) run.settled(done);
    return true;
  }
  for (const row of rows) await releaseUnpublishedClaim(engine, row, 'group_member_waiting');
  return false;
}

/**
 * #5984: completes every member's request row in one statement. Missing
 * counter rows are created, then the counter lock (`brain`, each principal,
 * `worktree:<id>`, the order every completion uses) and one UPDATE that sizes
 * each member's queued effects, checks its claim (`execution_token`,
 * `state='running'`) and terminal reservation, completes the rows and
 * decrements the counters: three statements sent together, one round trip.
 * If the UPDATE returns fewer rows than the group, this throws so the
 * transaction rolls back; the group then takes the single path, where
 * completeWrite reports each member's exact error code. JSON binds as text.
 */
export async function completeGroup(tx: BrainEngine, rows: WriteRequest[], outcomes: Record<string, unknown>[]): Promise<WriteRequest[]> {
  const ids = rows.map(row => row.id);
  const keys = [...new Set(['brain', ...rows.map(row => principalKey(requestPrincipal(row))), `worktree:${rows[0]!.worktree_id}`])].sort();
  const stamp = writerStamp();
  const [, , completed] = await pipelined(tx, [
    () => tx.executeRaw(ENSURE_COUNTERS_SQL, [keys]),
    () => tx.executeRaw(LOCK_COUNTERS_SQL, [keys]),
    () => tx.executeRaw<WriteRequest & { principal_key: string }>(`WITH m AS (
        SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::text[],$4::bigint[],$5::text[]) AS m(id,token,outcome,need,principal_key)
      ), e AS (
        SELECT request_id,SUM(octet_length(data::text)+octet_length(kind)+1024) AS bytes FROM persistence_effects WHERE request_id=ANY($1::uuid[]) GROUP BY request_id
      ), done AS (
        UPDATE persistence_requests r SET state='committed',outcome=m.outcome::jsonb,error_code=NULL,error_message=NULL,
          completed_at=now(),updated_at=now(),claim_expires_at=NULL,blocked_reason=NULL,
          consumer_version=$6,consumer_host_id=$7::uuid,published_at=now(),preparation_attempts=0
        FROM m LEFT JOIN e ON e.request_id=m.id
        WHERE r.id=m.id AND r.execution_token=m.token AND r.state='running' AND m.need+COALESCE(e.bytes,0)<=r.terminal_reservation
        RETURNING r.*,m.principal_key
      ), released AS (
        UPDATE persistence_counters c SET outstanding_count=c.outstanding_count-d.n,intent_bytes=c.intent_bytes-d.bytes
        FROM (SELECT k.key,count(*) AS n,SUM(done.intent_bytes) AS bytes FROM done CROSS JOIN LATERAL (VALUES ('brain'),(done.principal_key)) AS k(key) GROUP BY k.key) d
        WHERE c.key=d.key
      )
      SELECT * FROM done`, [ids, rows.map(row => row.execution_token), outcomes.map(outcome => JSON.stringify(outcome)),
      rows.map((row, i) => jsonBytes(outcomes[i]) + jsonBytes(row.authority) + 1024),
      rows.map(row => principalKey(requestPrincipal(row))), stamp.version, stamp.hostId]),
  ]) as [unknown, unknown, Array<WriteRequest & { principal_key: string }>];
  if (completed.length !== rows.length) throw new OperationError('write_claim_lost', 'A group member failed its claim or terminal-reservation check before publication.',
    'The group rolls back and its members publish one at a time, where each member reports its own outcome; inspect the requests rather than resubmitting.');
  const byId = new Map(completed.map(({ principal_key: _key, ...row }) => [row.id, row as WriteRequest]));
  return rows.map(row => byId.get(row.id)!);
}

export interface GroupExecution {
  /** #5984 lanes: the open lane run this group belongs to in this process. */
  lane?: LaneState | null;
  /** `engine` answers the members' repeated preparation reads once (see preparationReads); `signal` and `clock` (#6278) are the member's own. */
  prepare(row: WriteRequest, engine: BrainEngine, signal?: AbortSignal, clock?: ClaimPhaseClock): Promise<PreparedMutation>;
  settled(row: WriteRequest): void;
  hostId: string;
  hooks?: GroupHooks;
  /** #5373: renewal timing for the group's claims (default DEFAULT_CLAIM_LEASE_TIMING). */
  lease?: ClaimLeaseTiming;
  /** #6278: the budgets, ceiling, attempt limit and switch in effect (default: the defaults with deadlines on). */
  policy?: PreparationPolicy & { deadlines: boolean };
  /** #6278: the foreground (remember/put_page/edit_page) budget, the consumer's `preparationMs` (default 30 s). */
  foregroundMs?: number;
  /**
   * #5373: receives work still running when the group lets go of its claims: the
   * renewal in flight, or (`blocksRoot`) a preparation abandoned after a lost claim
   * or (#6278) a deadline; `abandoned` names the member and its clock for the ceiling.
   */
  leftRunning?(work: Promise<unknown>, blocksRoot: boolean, abandoned?: { row: WriteRequest; clock: ClaimPhaseClock }): void;
}

/**
 * The memo rule (#6278): `preparationReads` and `groupReads` answer a read
 * once for every member, so a member's own signal never reaches a shared
 * read (the memo skips itself for a signalled statement, and an aborted
 * member must never reject a sibling's read). A member that must give up on a
 * shared read races its own signal against the shared promise instead:
 * `enterClaimStep` at its next boundary throws the member's abort reason.
 */
type MemberOutcome = { ok: PreparedMutation } | { error: unknown } | { released: 'preparation_deadline' | 'group_member_waiting' | 'claim_lost' };

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
 *
 * #6278: each member's budget clock starts when its wave dispatches it (the
 * wave is marked durably first), and the lease renews the mutable set of
 * members still held, so one release never reads as a lost group lease. When
 * member k expires: no later wave is dispatched, the in-flight suffix is
 * aborted, k is released `preparation_deadline` (charged; finished
 * `preparation_stalled` when that reaches the limit) and the later members
 * `group_member_waiting` (not charged), and the contiguous prepared prefix
 * 0..k-1 publishes. An independent `batch:` group releases only k. An
 * abandoned member's preparation goes to `leftRunning` with its clock.
 */
export async function executeClaimedGroup(engine: BrainEngine, rows: WriteRequest[], run: GroupExecution): Promise<boolean> {
  const policy = run.policy ?? { ...DEFAULT_PREPARATION_POLICY, deadlines: true };
  const foregroundMs = run.foregroundMs ?? 30_000;
  const groupClock = startClaimPhase();
  const clocks: Array<ClaimPhaseClock | undefined> = rows.map(() => undefined);
  const held = new Set(rows.map(row => row.id));
  const inFlight = new Map<number, PreparationRun<PreparedMutation>>();
  const preps: Array<PreparationRun<PreparedMutation> | undefined> = rows.map(() => undefined);
  const stampOf = (i: number) => clocks[i] ? claimPhaseStamp(clocks[i]!, rows[i]!.execution_token) : null;
  const lease = startClaimLease(async signal => {
    const live = rows.map((row, i) => [row, i] as const).filter(([row]) => held.has(row.id));
    if (!live.length) return true;
    return (await renewGroupClaims(engine, live.map(([row]) => row), 30_000, signal, live.map(([, i]) => stampOf(i)))).size === live.length;
  }, run.lease ?? DEFAULT_CLAIM_LEASE_TIMING, () => { for (const prep of inFlight.values()) prep.abort({ code: 'claim_lost' }); });
  if (run.lane) laneClaimed(run.lane, rows);
  // A put_pages batch or a managed import batch is independent page writes: one page's failure never cancels its siblings.
  const independent = independentGroup(publicationGroupKey(rows[0]!));
  const prepared: MemberOutcome[] = new Array(rows.length);
  // The first member whose deadline passed in an ordered group: nothing after it is dispatched or published this pass.
  let cut: number | null = null;
  const abandon = (i: number, work: Promise<unknown>) => run.leftRunning?.(work, true, { row: rows[i]!, clock: clocks[i]! });
  try {
    const reads = preparationReads(engine);
    // A put_pages or import group prepares all of its (at most PAGE_BATCH_GROUP_MAX) pages at once.
    const width = independent ? PAGE_BATCH_GROUP_MAX : 4;
    const preparing = (async () => {
      for (let start = 0; start < rows.length && (independent || cut === null); start += width) {
        const wave = rows.slice(start, start + width);
        const now = Date.now();
        const cancels = wave.map(() => new AbortController());
        const budgets = wave.map(row => policy.deadlines ? preparationBudgetMs(row, policy, foregroundMs) : undefined);
        wave.forEach((_row, offset) => { clocks[start + offset] = startClaimPhase(now, cancels[offset]!.signal, budgets[offset]); });
        if (policy.deadlines) await markDispatched(engine, wave.map((row, offset) => ({ row, stamp: stampOf(start + offset)! })));
        const wavePreps = wave.map((row, offset) => {
          const i = start + offset;
          const budget = budgets[offset];
          // The member's signal reaches its preparer through its clock (enterClaimStep), never as a blanket statement signal: see the memo rule.
          const prep = startPreparation(async signal => {
            signal.addEventListener('abort', () => cancels[offset]!.abort(signal.reason), { once: true });
            await faultPoint('consumer:preparing', { requestId: row.request_id, sourceId: row.source_id, operation: row.operation, signal });
            return run.prepare(row, reads, undefined, clocks[i]);
          }, budget, { onDeadline: () => {
            if (independent) return;
            if (cut === null || i < cut) cut = i;
            for (const [j, other] of inFlight) if (j > i) other.abort({ code: 'group_member_waiting' });
          } });
          inFlight.set(i, prep);
          preps[i] = prep;
          return prep;
        });
        await Promise.all(wavePreps.map(async (prep, offset) => {
          const i = start + offset;
          try {
            const outcome = policy.deadlines ? await prep.outcome : await prep.work.then(result => ({ result }));
            prepared[i] = 'deadline' in outcome ? { released: 'preparation_deadline' } : { ok: outcome.result };
          } catch (error) {
            const reason = preparationAbortReason(error, prep.signal);
            // #6278: a bounded read the server ended inside the budget reports the deadline itself; it cuts the group like the timer would.
            if (reason === 'preparation_deadline' && policy.deadlines) prep.expire();
            prepared[i] = reason === 'preparation_deadline' || reason === 'group_member_waiting' || reason === 'claim_lost' ? { released: reason } : { error };
          } finally { inFlight.delete(i); }
        }));
      }
    })();
    if (await lease.whileHeld(preparing) === CLAIM_LOST) {
      run.leftRunning?.(preparing, true, { row: rows[0]!, clock: groupClock });
      await endLostLease(lease);
      for (const row of rows) if (held.has(row.id)) await releaseUnpublishedClaim(engine, row, 'claim_lost');
      return false;
    }
    let progressed = false;
    // #6278: the members the deadline took off this pass leave the held set before their release statement runs.
    const released = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!, outcome = prepared[i];
      const expired = outcome !== undefined && 'released' in outcome && outcome.released === 'preparation_deadline';
      const after = !independent && cut !== null && i > cut;
      if (!expired && !after) continue;
      held.delete(row.id); released.add(row.id);
      // A dispatched member the deadline or the suffix abort took off this pass may still run: it blocks the root until it settles or the ceiling passes.
      if (outcome !== undefined && 'released' in outcome && preps[i]) abandon(i, preps[i]!.work);
      if (!expired) { await releaseUnpublishedClaim(engine, row, 'group_member_waiting'); continue; }
      if ((row.preparation_attempts ?? 0) + 1 >= policy.maxAttempts) {
        const done = await finishPreparationStalled(engine, row, { step: clocks[i]!.step, waiting_on: clocks[i]!.waitingOn, limit: policy.maxAttempts }, true);
        run.settled(done); progressed = true;
        continue;
      }
      await releaseUnpublishedClaim(engine, row, 'preparation_deadline', { charge: true });
    }
    for (const clock of clocks) if (clock) enterClaimPhase(clock, 'publishing');
    enterClaimPhase(groupClock, 'publishing');
    const live = rows.map((row, i) => ({ row, i })).filter(({ row }) => !released.has(row.id));
    if (!live.length) return progressed;
    const liveRows = live.map(({ row }) => row);
    let requeued = new Set<string>();
    if (live.every(({ i }) => 'ok' in prepared[i]!)) {
      // #6278 lanes: a prefix publishes under the original group's order key, then drops its own begun mark.
      if (run.lane && liveRows.length < rows.length) await awaitLaneBegin(run.lane, rows);
      const result = await publishGroup(engine, liveRows, live.map(({ i }) => (prepared[i] as { ok: PreparedMutation }).ok), run.hostId, run.hooks, run.lane ?? null);
      if (run.lane && liveRows.length < rows.length) run.lane.begun.delete(liveRows.at(-1)!.request_id);
      if (result.done) { for (const row of result.done) run.settled(row); return true; }
      requeued = new Set(result.requeued);
      if (run.lane) { const settled = await laneFallback(engine, liveRows, result.reason, run); if (settled !== null) return settled || progressed; }
    } else if (run.lane) {
      const settled = await laneFallback(engine, liveRows, 'failed', run);
      if (settled !== null) return settled || progressed;
    }
    let stop: 'cancel' | 'release' | null = null;
    for (const { row: member, i } of live) {
      let row = member;
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
      // #6278: a member aborted by our own cancellation (never a deadline here) is released, not failed.
      if ('released' in p) { await releaseUnpublishedClaim(engine, row, p.released === 'claim_lost' ? 'claim_lost' : 'group_member_waiting'); stop ??= independent ? null : 'release'; continue; }
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
