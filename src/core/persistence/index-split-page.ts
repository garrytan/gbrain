/**
 * Wave C 1I-a (spec §3.6, unsplit pages): the `index-split-page` consumer. A strict git-first write of a page up to
 * PAGE_MAX_BYTES committed its file through the door and left the page's rows to this step (git-first.ts). The consumer
 * derives them from the committed file, never from the request's payload:
 *
 * 1. Token check: the page's `page_pending_heads` row must still name this request and revision. A newer commit of the
 *    page replaced it (that request indexes the newer head), and a delete, rename or private transition removed it; either
 *    way this request ends `committed` with `index.state: superseded`.
 * 2. The committed blob: HEAD's blob at the path must be the head the door committed, and the file on disk must hash to
 *    the committed size and sha256. A missing object or a mismatch is a content cause: the request ends `committed` with
 *    `index.state: held` and the hold code (index_held; the bytes are in Git, nothing is resent).
 * 3. Derive: a managed import of the canonical file (the owner's ordinary import of a committed file, which stages the
 *    segmented body from it and queues the post-content effects once, against this generation).
 * 4. Flip: under the pending head's row lock the token is checked again; the head is deleted, `pages.indexed_commit`
 *    records the commit and the request becomes `committed` with `index.state: indexed`.
 *
 * The per-page index lease: a job is claimed only while no other index job of its page holds a live claim
 * (effect-journal.ts), and it renews its claim while it runs, so a long import keeps the page; a lost claim stops the job
 * before it holds or flips anything. Split pages (over PAGE_MAX_BYTES) and incremental re-segmentation are PR 5's.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GBrainConfig } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import type { PersistenceEffect } from './effect-model.ts';
import { completeEffect, effectClaimKeeper } from './effect-journal.ts';
import { registerBuiltInIndexSplitPageConsumer, type IndexSplitPageConsumer } from './git-first-gate.ts';
import { readPendingHead, type IndexReceipt, type PendingHead } from './git-first.ts';
import { importManagedFile } from './import-mutations.ts';
import { acquireWorktreeWaiting, getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { headBlob, isAncestor, landedCommit } from './pending-import.ts';
import { opError } from '../ops/contract.ts';
import { declarePersistenceProtocol } from './protocol.ts';
import type { WriteRequest } from './model.ts';
import { recordAgentPageLowering } from '../trust/page-write.ts';
import type { TrustTier } from '../trust/tier.ts';

/** @internal How often a running index job renews its claim (the lease); tests shorten it, and `afterChecks` runs between the committed-file checks and the import. */
export const _indexLeaseTiming: { renewMs: number; afterChecks?: (file: string) => void } = { renewMs: 30_000 };
/** How long the index step waits for the source writer lock before it retries later. */
const INDEX_LOCK_WAIT_MS = 30_000;

interface IndexEffectData {
  slug: string; commit: string; head_oid: string; path: string; pending_revision: string;
  /** The writing request's operation and the page's tier and revision before it (git-first.ts queueIndexFromGit). */
  lowering?: { operation: WriteRequest['operation']; tier: TrustTier; revision: string | null };
}

async function fileSha256(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return { sha256: hash.digest('hex'), bytes };
}

/** Ends the claimed effect with the index object, and an indexing request `committed` with it; a request no longer indexing is left as it is. */
async function finishIndex(engine: BrainEngine, effect: PersistenceEffect, index: IndexReceipt, searchable?: unknown): Promise<void> {
  await completeEffect(engine, effect, { index });
  await engine.executeRaw(`UPDATE persistence_requests SET state = 'committed', updated_at = now(),
      outcome = COALESCE(outcome, '{}'::jsonb) || jsonb_build_object('index', $2::text::jsonb)
        || CASE WHEN $3::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('searchable', $3::text::jsonb) END
    WHERE id = $1::uuid AND state = 'indexing'`, [effect.request_id, JSON.stringify(index), searchable === undefined ? null : JSON.stringify(searchable)]);
}

/** The claim this job holds must still be its own (a lost claim's holder settles nothing); locks the effect row. */
async function assertOwnClaim(tx: BrainEngine, effect: PersistenceEffect): Promise<void> {
  const [own] = await tx.executeRaw('SELECT 1 FROM persistence_effects WHERE id = $1 AND execution_token IS NOT DISTINCT FROM $2::uuid FOR UPDATE', [effect.id, effect.execution_token ?? null]);
  if (!own) throw opError('write_claim_lost', 'The index effect claim changed.', `Another worker took over the index step of request ${effect.request_id}; it settles the request.`);
}

/**
 * Settles a request whose committed file cannot be indexed as it stands, under the pending head's row lock: a head that
 * moved to another request supersedes it; a later commit of the path supersedes it and removes its head (the page is
 * derived from that commit by whoever wrote it, or by the next sync); a content cause holds it, keeping the head for the
 * repair verbs.
 */
async function settleUnindexable(engine: BrainEngine, effect: PersistenceEffect, data: IndexEffectData, verdict: { hold: string } | { laterCommit: string }): Promise<void> {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await assertOwnClaim(tx, effect);
    const current = await readPendingHead(tx, effect.source_id, data.slug, { lock: true });
    if (!current || current.request_id !== effect.request_id || current.revision !== data.pending_revision) {
      return finishIndex(tx, effect, { state: 'superseded', commit: data.commit, ...(current ? { superseded_by: current.request_id } : {}) });
    }
    if ('laterCommit' in verdict) {
      await tx.executeRaw('DELETE FROM page_pending_heads WHERE source_id = $1 AND slug = $2 AND request_id = $3::uuid', [effect.source_id, data.slug, effect.request_id]);
      return finishIndex(tx, effect, { state: 'superseded', commit: data.commit, superseded_by_commit: verdict.laterCommit });
    }
    await tx.executeRaw('UPDATE page_pending_heads SET hold_code = $3 WHERE source_id = $1 AND slug = $2 AND request_id = $4::uuid', [effect.source_id, data.slug, verdict.hold, effect.request_id]);
    await finishIndex(tx, effect, { state: 'held', commit: data.commit, hold_code: verdict.hold });
  });
}

/**
 * Under the source's writer lock (a door holds it from writing the file through its commit, so no publication is half
 * done here): HEAD's blob and the file against the head. A later commit of the path that replaced the committed blob
 * supersedes it; a blob Git no longer has at HEAD otherwise, or a file that is not the committed bytes, is a content cause.
 */
async function checkCommitted(engine: BrainEngine, binding: WorktreeBinding, file: string, data: IndexEffectData, head: PendingHead): Promise<'ok' | { hold: string } | { laterCommit: string }> {
  const lock = await acquireWorktreeWaiting(binding, engine, INDEX_LOCK_WAIT_MS);
  if (!lock) throw opError('writer_busy', 'The source writer lock is busy.', `The index step of request ${head.request_id} retries once the writer of source ${binding.source_id} is free.`);
  try {
    if (await headBlob(binding.local_path!, file) !== data.head_oid) {
      const later = await landedCommit(binding.local_path!, data.commit, file);
      return later && await isAncestor(binding.local_path!, data.commit) ? { laterCommit: later } : { hold: 'git_object_missing' };
    }
    const onDisk = existsSync(file) ? await fileSha256(file) : null;
    return !onDisk || onDisk.sha256 !== head.body_sha256 || onDisk.bytes !== head.body_bytes ? { hold: 'hash_mismatch' } : 'ok';
  } finally { await lock.release(); }
}

export const indexSplitPage: IndexSplitPageConsumer = {
  async run(engine: BrainEngine, _config: GBrainConfig, effect: PersistenceEffect, hostId: string): Promise<void> {
    const keep = effectClaimKeeper(engine, effect, _indexLeaseTiming.renewMs);
    let lost: unknown = null, renewing = false;
    const timer = setInterval(() => {
      if (renewing || lost) return;
      renewing = true;
      keep().catch(error => { lost = error; }).finally(() => { renewing = false; });
    }, Math.max(1, _indexLeaseTiming.renewMs));
    try { await indexCommitted(engine, effect, hostId, () => { if (lost) throw lost; }); }
    finally { clearInterval(timer); }
  },
};

async function indexCommitted(engine: BrainEngine, effect: PersistenceEffect, hostId: string, holdsLease: () => void): Promise<void> {
  const data = effect.data as unknown as IndexEffectData;
  const head = await readPendingHead(engine, effect.source_id, data.slug);
  if (!head || head.request_id !== effect.request_id || head.revision !== data.pending_revision) {
    return engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await finishIndex(tx, effect, { state: 'superseded', commit: data.commit, ...(head ? { superseded_by: head.request_id } : {}) });
    });
  }
  const binding = await getWorktreeBinding(engine, effect.source_id, hostId);
  if (!binding?.local_path) throw new Error(`Source ${effect.source_id} has no canonical checkout on this host; the index effect stays queued for its owner.`);
  const file = join(binding.local_path, data.path);
  const verdict = await checkCommitted(engine, binding, file, data, head);
  holdsLease();
  if (verdict !== 'ok') return settleUnindexable(engine, effect, data, verdict);
  _indexLeaseTiming.afterChecks?.(file);
  const imported = await importManagedFile(engine, file, data.path, { sourceId: effect.source_id, expectInputHash: head.body_sha256 });
  holdsLease();
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await assertOwnClaim(tx, effect);
    const current = await readPendingHead(tx, effect.source_id, data.slug, { lock: true });
    if (!current || current.request_id !== effect.request_id || current.revision !== data.pending_revision) {
      await finishIndex(tx, effect, { state: 'superseded', commit: data.commit, ...(current ? { superseded_by: current.request_id } : {}) });
      return;
    }
    await tx.executeRaw('DELETE FROM page_pending_heads WHERE source_id = $1 AND slug = $2 AND request_id = $3::uuid', [effect.source_id, data.slug, effect.request_id]);
    await tx.executeRaw('UPDATE pages SET indexed_commit = $3 WHERE source_id = $1 AND slug = $2', [effect.source_id, data.slug, data.commit]);
    // 1I review M3 (CEO-12): the deferred write's apply never ran, so a lowering is filed here, against the derived rows.
    if (data.lowering) await recordAgentPageLowering(tx, { operation: data.lowering.operation, source_id: effect.source_id, slug: data.slug },
      { tier: data.lowering.tier, revision: data.lowering.revision });
    await finishIndex(tx, effect, { state: 'indexed', commit: data.commit }, imported.searchable ?? true);
  });
}

registerBuiltInIndexSplitPageConsumer(indexSplitPage);
