/**
 * #6340: a page that moved under a managed catch-up holds the page, not the run.
 *
 * On a live checkout (agents commit to the brain repo every few minutes while a
 * multi-hour catch-up drains a frozen manifest) four codes used to end the whole
 * run, each recoverable with a plain retry: `revision_conflict` and
 * `page_identity_changed` at freeze time (the database page changed after the
 * manifest was enumerated), and `source_changed [pinned_git_worktree_conflict]`
 * at publication (the working tree holds other bytes than the pinned commit).
 * Each relaunch then re-froze the manifest. This module is the one place that
 * decides what such an entry becomes instead:
 *
 * - bytes committed at HEAD past the pinned target are imported as HEAD has them
 *   (`headCommittedBytes`): a commit is not an uncoordinated local edit, and the
 *   later pin..HEAD diff re-imports the same bytes as a no-op (idea and first
 *   test from PR #6323 by @garrytan-agents);
 * - a database page that changed after enumeration but still holds what the
 *   entry would import is re-bound to its current revision (the caller's waiver
 *   screen then passes it as unchanged);
 * - anything else is a hold: `concurrent_write` when the database side moved
 *   (#6194's code and reconcile route, with the competing request when the
 *   proof finds one, else the observed revision alone), `worktree_dirty` when
 *   the file side moved (uncommitted bytes that match neither the pin nor the
 *   page). The cursor advances past the hold and the receipt lists it.
 *
 * Holds carry `meta.attempts`, incremented each time the same path is held
 * again (`writeGitHold` on update), so an operator contract can say
 * `needs_human` for a page that keeps moving. Only a systemic failure (the
 * preparation breaker, authority or binding loss) still ends a run.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { RECOVERY_VERSION } from '../markdown.ts';
import { sha256 } from './digest.ts';
import type { WriteRequest } from './model.ts';
import { readSyncFile, syncGitPath, type SyncDiscovery, type SyncEntry, type SyncRename } from './sync-discovery.ts';
import { readTreeBlobs } from './sync-blobs.ts';
import type { SyncIntent } from './sync-prepare.ts';
import type { HeldEntry } from './sync-screen.ts';
import type { GitHoldMeta } from './sync-holds.ts';
import { concurrentWriteHold, concurrentWriteProof } from './sync-concurrent-write.ts';

export { HOLD_ATTEMPTS_NEEDS_HUMAN } from './sync-fault-class.ts';

type HoldEntry = Pick<SyncEntry, 'path' | 'sourcePath' | 'working' | 'renameFrom' | 'renameHeld' | 'action'>;

/** Git's blob id of `bytes` in the object format HEAD uses (sha1, or sha256 when HEAD's ids are 64 hex digits). */
function blobOid(bytes: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * The working-tree bytes of `path` when they are exactly what HEAD commits for it (their blob id equals
 * `HEAD:<path>`), with that blob id; null when the file is absent, differs from HEAD, or Git cannot answer.
 * A read failure is the caller's ordinary refusal path, never a substitution.
 */
export function headCommittedBytes(context: Pick<SyncDiscovery, 'root' | 'gitRoot'>, path: string): { content: string; oid: string; rawHash: string } | null {
  let bytes: Buffer | null;
  try { bytes = readSyncFile(context.root, path); } catch { return null; }
  if (!bytes) return null;
  const gitPath = syncGitPath(context, path);
  let head: { oid: string } | undefined;
  try { head = readTreeBlobs(context.gitRoot, 'HEAD', [gitPath]).get(gitPath); } catch { return null; }
  if (!head) return null;
  const oid = blobOid(bytes, head.oid.length === 64 ? 'sha256' : 'sha1');
  return oid === head.oid ? { content: bytes.toString('utf8'), oid, rawHash: sha256(bytes) } : null;
}

export interface PageChangeProof { request_id: string; operation: string; revision: string }

/**
 * #6194's proof, usable at freeze time as well as from a receipt: the page's live revision differs from the one the entry
 * was frozen against, and `pages.revision_write_request_id` names a committed non-sync request of the same source
 * incarnation and page id. Null when the race is not proven (the page may still have changed).
 */
export async function pageChangeProof(engine: Pick<BrainEngine, 'executeRaw'>, input: { sourceId: string; incarnation: string; pageId: number | null; expectedRevision: string | null }): Promise<PageChangeProof | null> {
  if (input.pageId === null) return null;
  const [page] = await engine.executeRaw<{ revision: string | null; writer: string | null }>(
    'SELECT knowledge_revision::text AS revision, revision_write_request_id::text AS writer FROM pages WHERE id=$1 AND source_id=$2', [input.pageId, input.sourceId]);
  if (!page?.revision || !page.writer || page.revision === String(input.expectedRevision ?? '')) return null;
  const [writer] = await engine.executeRaw<{ request_id: string; operation: string; kind: string | null; state: string; incarnation: string; page_id: number | null }>(
    `SELECT request_id::text, operation, intent->>'kind' AS kind, state, source_incarnation::text AS incarnation, page_id FROM persistence_requests WHERE id=$1::uuid`, [page.writer]);
  if (!writer || writer.state !== 'committed' || String(writer.kind ?? '').startsWith('managed_sync_')
    || writer.incarnation !== input.incarnation || Number(writer.page_id) !== input.pageId) return null;
  return { request_id: writer.request_id, operation: writer.operation, revision: page.revision };
}

/**
 * The page's current revision, soft-deleted pages included (a deletion advances the revision, and a new-file entry whose slug
 * a page now occupies has moved too); null when no row exists. For a hold that records what it observed.
 */
export async function liveRevision(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, page: { pageId: number | null; slug: string }): Promise<string | null> {
  const [row] = page.pageId === null
    ? await engine.executeRaw<{ revision: string | null }>('SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, page.slug])
    : await engine.executeRaw<{ revision: string | null }>('SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1 AND source_id=$2', [page.pageId, sourceId]);
  return row?.revision ?? null;
}

function base(entry: HoldEntry, slug: string, pageId: number | null, code: 'concurrent_write' | 'worktree_dirty',
  message: string, content: string | null, blobOid: string | null | undefined, meta: Partial<GitHoldMeta>): HeldEntry {
  const rename: SyncRename | undefined = entry.renameFrom ?? entry.renameHeld;
  return { path: entry.path, source_path: entry.sourcePath, slug, page_id: pageId, code, message, upstream_version: content === null ? null : sha256(content),
    meta: { recovery_version: RECOVERY_VERSION, ...(blobOid ? { blob_oid: blobOid } : {}), ...(entry.working ? { working: true } : {}),
      ...(rename ? { rename_from: rename } : {}), ...(entry.action === 'delete' ? { deleted: true as const } : {}), ...meta } };
}

/**
 * The `concurrent_write` hold for a page that changed in the database after this entry was enumerated (or after its
 * import was admitted). `why` names the change as the caller saw it; identifiers and revisions only, never content.
 */
export function pageChangedHold(entry: HoldEntry, slug: string, pageId: number | null, intent: Pick<SyncIntent, 'content' | 'blobOid' | 'expected_revision'>,
  observed: { proof: PageChangeProof | null; revision: string | null; why: string }): HeldEntry {
  const what = entry.action === 'delete' ? 'deletion' : 'import';
  const by = observed.proof ? `${observed.proof.operation} request ${observed.proof.request_id} wrote page ${slug} straight to the database` : observed.why;
  return base(entry, slug, pageId, 'concurrent_write',
    `${entry.path}: ${by} after this sync enumerated it, so its ${what} is held and the rest of the source synced; neither version was overwritten.`,
    typeof intent.content === 'string' ? intent.content : null, typeof intent.blobOid === 'string' ? intent.blobOid : null,
    { ...(observed.proof ? { competing_request_id: observed.proof.request_id, competing_operation: observed.proof.operation } : {}),
      ...(observed.revision ?? observed.proof?.revision ? { page_revision: observed.revision ?? observed.proof!.revision } : {}),
      ...(intent.expected_revision ? { expected_revision: String(intent.expected_revision) } : {}) });
}

/**
 * The `worktree_dirty` hold for a file whose working-tree bytes match neither the pinned commit nor the current page
 * and are not committed at HEAD: an uncoordinated local edit sync must not overwrite. `blobOid` is the pinned blob,
 * so discovery re-screens the hold when a later commit changes the file, and `sources retry-held` re-screens it once
 * the edit is committed.
 */
export function worktreeDirtyHold(entry: HoldEntry, slug: string, pageId: number | null, intent: Pick<SyncIntent, 'content' | 'blobOid' | 'rawHash'>): HeldEntry {
  return base(entry, slug, pageId, 'worktree_dirty',
    `${entry.path} has uncommitted working-tree bytes that match neither the pinned commit nor the current page, so its import is held and the rest of the source synced; the local edit was not overwritten. Commit the file (or restore it) and the next sync imports it.`,
    typeof intent.content === 'string' ? intent.content : null, typeof intent.blobOid === 'string' ? intent.blobOid : null,
    { ...(intent.rawHash ? { working_hash: intent.rawHash } : {}) });
}

/** The receipt of a `managed_sync_import` that publication refused as `pinned_git_worktree_conflict` (sync-prepare.ts `newerWorkingTree`). */
export function pinnedWorktreeConflict(done: Pick<WriteRequest, 'state' | 'error_code' | 'error_message'>): boolean {
  return done.state !== 'committed' && done.error_code === 'source_changed'
    && ['Newer working-tree bytes and the current page disagree with this pinned Git import.', 'Newer code file bytes disagree with the pinned import.'].includes(done.error_message ?? '');
}

/** The receipt of an import whose file bytes changed between admission and publication (`raw_file_changed` in verb-errors.ts). */
export function fileChangedAfterAdmission(done: Pick<WriteRequest, 'state' | 'error_code' | 'error_message'>): boolean {
  return done.state !== 'committed' && done.error_code === 'source_changed'
    && ['The imported file changed after sync admission.', 'The canonical file changed after preparation.', 'The canonical file changed during preparation.'].includes(done.error_message ?? '');
}

/** A `revision_conflict` receipt whose page really moved (its live revision differs from the frozen one); run-level conflicts stay blocking. */
export async function pageMovedSinceAdmission(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, pending: { slug: string; pageId: number | null; intent: Pick<SyncIntent, 'expected_revision'> },
  done: Pick<WriteRequest, 'state' | 'error_code'>): Promise<{ revision: string | null } | null> {
  if (done.state === 'committed' || done.error_code !== 'revision_conflict') return null;
  const revision = await liveRevision(engine, sourceId, pending);
  return revision === (pending.intent.expected_revision === null || pending.intent.expected_revision === undefined ? null : String(pending.intent.expected_revision)) ? null : { revision };
}

/**
 * The hold a terminal receipt of a page request earns when its page moved under the sync, or null when the receipt is
 * not such a fault: #6194's proven race (`concurrent_write` with the competing request), a `revision_conflict` whose page
 * really moved (`concurrent_write` by revision), or a `pinned_git_worktree_conflict` (`worktree_dirty`). Shared by the
 * run's receipt branch and the start-of-run conversion of an older release's blocked cursor.
 */
export async function receiptPageFaultHold(engine: Pick<BrainEngine, 'executeRaw'>, input: { sourceId: string; incarnation: string; entry: HoldEntry;
  pending: { slug: string; pageId: number | null; intent: SyncIntent }; done: Pick<WriteRequest, 'state' | 'error_code' | 'error_message'> }): Promise<HeldEntry | null> {
  const { entry, pending, done } = input;
  const page = pending.intent.kind === 'managed_sync_import' && typeof pending.intent.content === 'string';
  const proof = page ? await concurrentWriteProof(engine, { sourceId: input.sourceId, incarnation: input.incarnation, pending, done }) : null;
  if (proof) return concurrentWriteHold(entry, pending.slug, pending.pageId!, pending.intent, proof);
  const moved = await pageMovedSinceAdmission(engine, input.sourceId, pending, done);
  if (moved) return pageChangedHold(entry, pending.slug, pending.pageId, pending.intent, { proof: null, revision: moved.revision, why: `page ${pending.slug} changed in the database` });
  return page && pinnedWorktreeConflict(done) ? worktreeDirtyHold(entry, pending.slug, pending.pageId, pending.intent) : null;
}

/**
 * The `concurrent_write` hold for an entry whose recorded origin no longer identifies the page this sync enumerated
 * (`assertSyncPageOrigin` refused at freeze time: the page at that origin was deleted, re-bound or replaced in the database).
 */
export async function originFaultHold(engine: Pick<BrainEngine, 'executeRaw'>, input: { sourceId: string; incarnation: string; entry: HoldEntry & Pick<SyncEntry, 'slug' | 'pageId' | 'revision'>;
  observed: { page: { id: number }; revision: string | null } | null; message: string }): Promise<HeldEntry> {
  const { entry } = input;
  const proof = await pageChangeProof(engine, { sourceId: input.sourceId, incarnation: input.incarnation, pageId: entry.pageId ?? null, expectedRevision: entry.revision ?? null });
  return pageChangedHold(entry, entry.slug!, input.observed?.page.id ?? entry.pageId ?? null, { content: null, blobOid: undefined, expected_revision: entry.revision ?? null },
    { proof, revision: input.observed?.revision ?? null, why: `the page recorded at ${entry.sourcePath} no longer identifies the one this sync enumerated (${input.message})` });
}
