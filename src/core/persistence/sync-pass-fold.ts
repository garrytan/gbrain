/**
 * #6712 PR 4b: the pass checkpoint folded into the publication of the round's last import (#6926, folded into 4b; GBRA-108
 * approved it under decision A's flip clause). The stamp rides that import's intent (sync-pass-run.ts `foldStamp`) and
 * commits in the import's own transaction, after its page and record, only when the database there proves what the next
 * round would have: every path at the target is settled. It is as conservative as the checkpoint request:
 * - the checkpoint's own checks: the drain lease (`FOR SHARE`, the pass's token), the pass row still naming this pass, no
 *   recovery row and no other open managed-sync request of the worktree (`findOpenPassWork`), and the commit checkpoint
 *   (`last_commit`, the slug-root pin) still where the pass found it; and no refused checkpoint of the source that no later
 *   checkpoint superseded (#6834): the stamp path's checkpoint request supersedes it, a folded stamp would leave it listed;
 * - `U_db` as the checkpoint records it: the converged watermark and `open_at_stamp` (`readConvergedWatermark`), read in
 *   the same transaction. A writeback (the import rewrites its file; GBRA-108, option A) folds through the coordinator's
 *   post-effects hook (`afterEffects`), after its Git effect is queued: that effect is in `open_at_stamp` and the import is
 *   recorded in `converged.writeback`, so the source is not idle until the effect commits (sync-pass.ts `passIdleProbe`), a
 *   failed or parked one blocks `sync status` (`writeback_failed`), and its own recovery record (the file publication's
 *   journal, which this commit resolves) is not open work;
 * - since the round's mark (S1), every change the level reads is this round's own write (sync-pass-confirm.ts
 *   `proveConfirm`, with this request's uncommitted page admitted): exactly one page per import of the round, the pages
 *   past S1's largest id the round's new ones, the counts S1's plus the round's new pages and records, and no hold at S1
 *   or now (a hold at the target keeps the stamp path);
 * - every page the round wrote classifies `matched` at the level its request froze (sync-pass.ts `passWritesMatched`);
 *   the rest of the level settled in the round's classification (the pass folds only a round whose only unsettled paths
 *   were its imports, sync-pass-run.ts).
 * Anything else publishes the import alone (`pass_stamp_skipped` names why) and the pass stamps by its checkpoint request
 * as before. The fold never fails the import on its own account: it runs under a savepoint, and a statement that fails
 * there (a validation timeout, a lost race) rolls back to it and skips the stamp, as one it cannot prove is skipped. A publication that rolls back takes the stamp with it; one that commits leaves the stamp and the pages
 * consistent for the next run.
 */
import { realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { hardenedGitSync } from '../hardened-git.ts';
import { fileContentHash } from './large-file.ts';
import { readBlobBytes, readTreeBlobs } from './sync-blobs.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { fenceLockRow, syncLockId } from '../db-lock.ts';
import { pipelined } from '../page-state/transactions.ts';
import { findOpenPassWork } from './checkpoint-validation.ts';
import { countsMatch, proveConfirm, type LevelMark } from './sync-pass-confirm.ts';
import { passWritesMatched } from './sync-pass.ts';
import { readConvergedWatermark } from './sync-pass-batch.ts';
import { OPEN_AT_STAMP_CAP, readPassRow, type ManagedSyncPassValue } from './sync-pass-row.ts';
import { emptySyncScope } from './sync-slug-mode.ts';
import { faultPoint } from './fault-points.ts';
import { supersessionSql } from './terminal-classify.ts';
import { publishPassStamp, syncGitTopLevel, type SyncIntent } from './sync-prepare.ts';

/** What a folded stamp's proof needs of its round: S1's mark, page count and largest page id, and the round's imports. */
export interface PassFold {
  base: LevelMark; pages: number; maxId: string;
  /** The round's imports, those that create a page, and those whose page had no import record at S1. */
  imports: number; newPages: number; newRecords: number;
  episodeFullId: string | null; scope: string;
  /** The pass row's obligations when the import was frozen: the stamp writes them, as the checkpoint request reads the row's. */
  obligations?: ManagedSyncPassValue['obligations'];
  /**
   * The imports of the batch the stamp rides, this one included: the stamp's counts were read before that batch drained,
   * and the proof shows each of them wrote its page, so the tail owes all of them (absent on a stamp frozen before: 1).
   */
  batch?: number;
}

/**
 * `prepared` (the round's last import) with the stamp folded into its publication: into its apply, or, for a writeback
 * (the import rewrites its file), into its post-effects hook, so the stamp sees and records the import's own Git effect.
 */
export function foldPassCheckpoint<T extends PreparedMutation>(prepared: T, input: { row: WriteRequest; p: SyncIntent; root: string }): T {
  if (prepared.noop) return prepared;
  prepared.sourceExclusive = true;
  if (prepared.file) {
    prepared.afterEffects = async (tx, outcome) => {
      const skipped = await foldedStamp(tx, input, outcome, input.row.id);
      Object.assign(outcome, skipped ? { pass_stamp_skipped: skipped } : { pass_stamp: 'folded' });
    };
    return prepared;
  }
  const apply = prepared.apply.bind(prepared);
  prepared.apply = async (tx, preimage) => {
    const outcome = await apply(tx, preimage);
    const skipped = await foldedStamp(tx, input, outcome);
    return { ...outcome, ...(skipped ? { pass_stamp_skipped: skipped } : { pass_stamp: 'folded' }) };
  };
  return prepared;
}

/**
 * The round after a folded writeback stamp, when HEAD left the stamp's target (durability on: the import's Git effect
 * committed meanwhile): whether `from..head` changes exactly the files of the stamp's writebacks (`converged.writeback`),
 * each to the bytes its import wrote (the Git effect's `expected_hash`), with every one of those effects committed or
 * still running (its commit lands before its row records it, so HEAD can show the commit first). Then the level at HEAD
 * is the one the stamp proved plus the pass's own bytes, and the pass ends on its stamp; anything else reads the level
 * in full.
 */
export async function ownWritebackCommit(engine: Pick<BrainEngine, 'executeRaw'>, input: { gitRoot: string; localPath: string; from: string; writeIds: readonly string[] }): Promise<boolean> {
  if (!input.writeIds.length) return false;
  const git = (args: string[]) => { const out = hardenedGitSync(input.gitRoot, args, { timeoutMs: 10_000, maxBytes: 1024 * 1024 }); return out.ok ? out.stdout.toString('utf8') : null; };
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])?.trim();
  const changed = head && head !== input.from ? git(['diff-tree', '-r', '-z', '--no-renames', input.from, head]) : null;
  if (!head || changed === null) return false;
  const effects = await engine.executeRaw<{ path: string | null; hash: string | null; state: string }>(`SELECT data->>'relative_path' AS path, data->>'expected_hash' AS hash, state
    FROM persistence_effects WHERE request_id = ANY($1::uuid[]) AND kind='git'`, [input.writeIds]);
  if (!effects.length || effects.some(effect => !['committed', 'running'].includes(effect.state) || !effect.path || !effect.hash)) return false;
  const root = realpathSync(input.localPath);
  const want = new Map(effects.map(effect => [relative(input.gitRoot, join(root, effect.path!)).split(sep).join('/'), effect.hash!]));
  // `:<mode> <mode> <oid> <oid> <status>\0<path>\0` per changed path: each must be a file of `want`, now a blob.
  const fields = changed.split('\0'), blobs = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, , oid] = fields[i]!.split(' ');
    if (!mode?.startsWith('100') || !oid || !want.has(fields[i + 1]!)) return false;
    blobs.set(fields[i + 1]!, oid);
  }
  if (blobs.size !== want.size) return false;
  const sized = readTreeBlobs(input.gitRoot, head, [...blobs.keys()]);
  const bytes = readBlobBytes(input.gitRoot, [...sized.values()]);
  return [...blobs].every(([path, oid]) => { const content = sized.get(path)?.oid === oid && bytes.get(oid); return !!content && fileContentHash(content) === want.get(path); });
}

/** A stamp whose checks did not hold: its savepoint rolls back, and the reason is returned. */
class StampSkipped extends Error { constructor(readonly reason: string) { super(reason); } }

/**
 * Publishes the stamp in `tx` when its checks hold; else why not (`error`: a statement failed). The stamp runs in a nested
 * transaction, so whatever it skips or fails rolls back to its savepoint and the import publishes alone. A raw SAVEPOINT is
 * not enough on Postgres: postgres.js rethrows a failed statement when its transaction scope ends even after the caller
 * caught it, so a stamp's checkpoint validation timeout would fail the whole import (#5762 recovery journey).
 */
async function foldedStamp(tx: BrainEngine, input: { row: WriteRequest; p: SyncIntent; root: string }, outcome: Record<string, unknown>, writeback?: string): Promise<string | null> {
  try {
    await tx.transaction(async stamp => {
      const skipped = await provenStamp(stamp, input, outcome, writeback);
      if (skipped) throw new StampSkipped(skipped);
    });
    return null;
  } catch (error) {
    return error instanceof StampSkipped ? error.reason : 'error';
  }
}

async function provenStamp(tx: BrainEngine, { row, p, root }: { row: WriteRequest; p: SyncIntent; root: string }, outcome: Record<string, unknown>, writeback?: string): Promise<string | null> {
  const stamp = p.stamp!, fold = stamp.fold!, postgres = tx.kind === 'postgres';
  const scope = { worktreeId: row.worktree_id!, sourceId: row.source_id, incarnation: row.source_incarnation };
  await faultPoint('sync:pass_fold', { requestId: row.request_id, writeId: row.id, sourceId: row.source_id });
  const [lease, pass, blocker, watermark, sources, proof, refused] = await pipelined(tx, [
    () => fenceLockRow(tx, syncLockId(row.source_id), stamp.leaseToken),
    () => readPassRow(tx, row.source_id, stamp.incarnation),
    () => findOpenPassWork(tx, row.worktree_id!, row.request_id, !!writeback),
    () => readConvergedWatermark(tx, scope, row.request_id, OPEN_AT_STAMP_CAP, writeback ? { own: writeback } : undefined),
    () => tx.executeRaw(`SELECT last_commit, config->>'slug_root_mode' AS mode FROM sources WHERE id=$1 AND incarnation=$2::uuid`, [row.source_id, row.source_incarnation]),
    () => proveConfirm(tx, { sourceId: row.source_id, incarnation: row.source_incarnation, passId: p.passId!, base: fold.base, postgres, self: row.id }),
    () => tx.executeRaw(`SELECT 1 FROM persistence_requests r WHERE r.source_id=$1 AND r.slug='__managed_sync_checkpoint__' AND r.intent IS NOT NULL AND NOT r.compacted
      AND r.operation='submit_job' AND r.intent->>'kind'='managed_sync_checkpoint' AND r.state IN ('failed','conflict','cancelled')
      AND NOT EXISTS (SELECT 1 FROM persistence_requests c WHERE ${supersessionSql('r', 'c')}) LIMIT 1`, [row.source_id]),
  ]) as [unknown[], Awaited<ReturnType<typeof readPassRow>>, string | null, Awaited<ReturnType<typeof readConvergedWatermark>>, Array<{ last_commit: string | null; mode: string | null }>,
    Awaited<ReturnType<typeof proveConfirm>>, unknown[]];
  if (!lease.length || !pass || pass.value.lease_token !== stamp.leaseToken || pass.value.telemetry.pass_id !== p.passId) return 'lease';
  if (blocker) return 'open_work';
  if (refused.length) return 'refused_checkpoint';
  const emptyScope = stamp.configured ? emptySyncScope(root, syncGitTopLevel(root, p.passId!)) : undefined;
  const source = sources[0];
  if (stamp.configured && (!source || (source.last_commit !== p.from && source.last_commit !== p.target) || (!emptyScope && source.mode !== null && source.mode !== p.slugMode))) return 'checkpoint_moved';
  if (!proof.ok) return proof.reason;
  if (fold.base.holds.length || proof.mark.holds.length || proof.summary) return 'holds';
  if (proof.pages.length !== fold.imports || proof.pages.filter(id => BigInt(id) > BigInt(fold.maxId)).length !== fold.newPages) return 'pages';
  if (!countsMatch(fold.base, proof, { pages: fold.pages + fold.newPages, newRecords: fold.newRecords })) return 'counts';
  if (!await passWritesMatched(tx, { kind: postgres ? 'postgres' : 'pglite', sourceId: row.source_id, incarnation: row.source_incarnation, pack: stamp.pack, scope: fold.scope,
    slugMode: p.slugMode, episodeFullId: fold.episodeFullId, ids: proof.pages })) return 'unsettled';
  // A prior stamp's open writebacks (rare) are carried on: the watermark is read again with them.
  const prior = pass.value.obligations.converged?.writeback;
  const read = prior?.length ? await readConvergedWatermark(tx, scope, row.request_id, OPEN_AT_STAMP_CAP, { own: writeback, prior }) : watermark;
  await publishPassStamp(tx, row, p, root, async () => {}, fold.obligations ? { value: { ...pass.value, obligations: fold.obligations } } : pass,
    { changed: stamp.changed + (outcome.noop === true ? 0 : fold.batch ?? 1), watermark: read, ...(emptyScope === undefined ? {} : { emptyScope }) });
  return null;
}
