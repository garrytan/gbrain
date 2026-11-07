/**
 * GST-1601 part 2: a remember, capture or add_timeline_entry refused `source_changed` / `file_database_drift` because its
 * page's canonical file holds a one-sided local edit (git HEAD still holds the database's copy, only the worktree file
 * moved) adopts that edit, then applies on top. Per source and off by default: `persistence.adopt_local_edits.source.<id>`.
 *
 * The owner publishes the edit first as its own write: a `managed_file_repair` (file-repair.ts) carrying `adoptLocalEdit`,
 * admitted under this installation's CLI writer (never the caller's principal) with a request id derived from the
 * caller's, so a write adopts at most once. It imports the file's exact bytes under the hash it read (an edit landing
 * before publication ends `raw_file_changed` and nothing is written; a commit that moved HEAD or a cancelled caller
 * adopts nothing), archives the replaced revision with change_reason
 * `adopted_local_edit`, and, on a Git-durable checkout, commits only that file before its row commits: subject
 * `gbrain: adopt local edit to <path>`, trailers `gbrain-adopted:` and `gbrain-author: unknown`, a commit-ledger line
 * (`adopted`). A repo-less brain records the adoption in the database alone. The caller's claim is then released and its
 * write prepared again from scratch; its receipt names `adopted: { path, blob, replaced_revision }`.
 *
 * Everything else keeps the refusal: another operation, a batch, the flag off, a held file, a two-sided edit (HEAD holds
 * neither the database's copy nor any entry), a file that does not import cleanly, and an edit to the title, the type or
 * a protected frontmatter key (page-prepare.ts protectedLocalEdit). A file still changing is adopted only once it has
 * been quiet for `persistence.adopt_quiet_ms` (default 5000); one that is not quiet within three windows keeps the refusal.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { gitBlobOid, sha256 } from './digest.ts';
import { commitGitTargets } from './effect-git.ts';
import { sourceCanonicalGit } from './git-door.ts';
import { gitDurabilityPolicy } from './git-durability-policy.ts';
import { withRegisteredLocalWriter } from './identity.ts';
import { admitWrite, getWriteRequest, getWriteRequestById, publicationGroupKey, releaseUnpublishedClaim } from './journal.ts';
import { isTerminal, requestPrincipal, type WriteRequest } from './model.ts';
import { declarePersistenceProtocol } from './protocol.ts';
import type { WorktreeBinding } from './ownership.ts';
import { getWorktreeBinding } from './ownership.ts';
import { fileMatchesSnapshot, protectedLocalEdit } from './page-prepare.ts';
import { blobText, headBlob, headCommit } from './pending-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { GitCommitNote } from './effect-model.ts';

export const ADOPTED_CHANGE_REASON = 'adopted_local_edit';
export const ADOPT_QUIET_KEY = 'persistence.adopt_quiet_ms';
const ADOPT_QUIET_DEFAULT_MS = 5_000;
/** A file is waited on for at most this many quiet windows. */
const QUIET_WINDOWS = 3;
/** How long the adoption retries a worktree lock another owner task holds. */
const LOCK_RETRY_MS = 10_000;
const ADOPTING_OPERATIONS: readonly string[] = ['remember', 'capture', 'add_timeline_entry'];

/** Test seam: runs between the adoption's preparation and its publication, with the file's path. */
export const localEditAdoptionSeams: { beforePublish?: (path: string) => void } = {};

/** The drifted file a `file_database_drift` refusal carries (page-prepare.ts compareFileTarget). */
interface LocalEditTarget { root: string; path: string }
export interface AdoptedLocalEdit { path: string; blob: string; replaced_revision: string }

export async function adoptLocalEditsOn(engine: BrainEngine, sourceId: string): Promise<boolean> {
  const value = await engine.getConfig(`persistence.adopt_local_edits.source.${sourceId}`).catch(() => null);
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}
async function quietMs(engine: BrainEngine): Promise<number> {
  const value = Number(await engine.getConfig(ADOPT_QUIET_KEY).catch(() => null) ?? ADOPT_QUIET_DEFAULT_MS);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 60_000) : ADOPT_QUIET_DEFAULT_MS;
}
/** The adoption's request id, derived from the caller's write so a write adopts at most once. */
function adoptionRequestId(row: Pick<WriteRequest, 'id'>): string {
  const h = sha256(`gbrain:adopt-local-edit:${row.id}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 + (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Waits until `path` has not changed for the quiet window; false when it is still changing after QUIET_WINDOWS windows. */
async function settled(path: string, quiet: number): Promise<boolean> {
  const deadline = Date.now() + quiet * QUIET_WINDOWS;
  for (;;) {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age >= quiet) return true;
    if (Date.now() + quiet - age > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, quiet - age));
  }
}

/** What adopting the edit to `target` admits, or null when the edit is not one-sided and safe. */
async function adoptionIntent(engine: BrainEngine, row: WriteRequest, target: LocalEditTarget, binding: WorktreeBinding) {
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  const sourcePath = snapshot?.page.source_path;
  if (!snapshot || !sourcePath || snapshot.page.deleted_at) return null;
  const bytes = readFileSync(target.path);
  const text = bytes.toString('utf8');
  // An edit whose bytes do not decode losslessly would be rewritten by its own adoption, so it keeps the refusal.
  if (!Buffer.from(text, 'utf8').equals(bytes)) return null;
  const commit = await headCommit(target.root);
  // A checkout whose HEAD git cannot read keeps the refusal; only a brain with no repository has no HEAD to ask.
  if (!commit && existsSync(join(binding.local_path!, '.git'))) return null;
  const head = commit ? await headBlob(target.root, target.path) : undefined;
  if (head === null) return null;
  // A checkout whose HEAD holds the database's copy: only the worktree file moved. A repo-less brain has no HEAD to ask.
  const committed = head ? await blobText(target.root, head) : null;
  if (head && (committed === null || !await fileMatchesSnapshot(engine, row.slug, committed, snapshot, sourcePath))) return null;
  const { prepareRepairPublication, repairScreenConfig } = await import('./file-repair.ts');
  const screen = await repairScreenConfig(engine, row.source_id);
  if (await protectedLocalEdit(engine, row.slug, text, snapshot, screen.activePack)) return null;
  const path = relative(target.root, target.path).split(sep).join('/');
  const publication = await prepareRepairPublication(engine, { sourceId: row.source_id, slug: row.slug, sourcePath, path, root: target.root,
    content: text, snapshot, base: snapshot, ...screen });
  if (publication.status !== 'ready') return null;
  const adopted: AdoptedLocalEdit = { path, blob: gitBlobOid(bytes, head?.length === 64 ? 'sha256' : 'sha1'), replaced_revision: snapshot.revision };
  return { adopted, params: { kind: 'managed_file_repair', slug: row.slug, path, sourcePath, content: text, beforeHash: sha256(bytes),
    resultDigest: publication.digest, ownerEpoch: String(binding.owner_epoch), expected_revision: snapshot.revision, noEmbed: true,
    adoptLocalEdit: { blob: adopted.blob, replaced_revision: adopted.replaced_revision, head: head ?? null }, source_id: row.source_id, request_id: adoptionRequestId(row) } };
}

/** Whether the caller still holds the claim its refusal is being answered under (a cancelled caller adopts nothing). */
async function callerHolds(engine: BrainEngine, caller: WriteRequest): Promise<boolean> {
  return (await engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE id=$1::uuid AND state='running' AND execution_token=$2::uuid`,
    [caller.id, caller.execution_token])).length > 0;
}

/** Publication's recheck (file-repair.ts validate): HEAD still holds the blob the adoption read, so no newer commit is overwritten. */
export async function adoptedHeadHolds(binding: WorktreeBinding, root: string, path: string, head: string | null): Promise<boolean> {
  return head === null ? !existsSync(join(binding.local_path!, '.git')) : await headBlob(root, path) === head;
}

/** Claims, prepares and publishes the admitted adoption, retrying while another owner task holds the worktree lock. */
async function publishAdoption(engine: BrainEngine, caller: WriteRequest, admitted: WriteRequest, path: string): Promise<WriteRequest> {
  const { finishUnpublishedFailure, publishMutation } = await import('./coordinator.ts');
  const { prepareManagedFileRepairMutation } = await import('./file-repair.ts');
  const deadline = Date.now() + LOCK_RETRY_MS;
  let row = admitted;
  for (;;) {
    if (!await callerHolds(engine, caller)) return (await getWriteRequestById(engine, row.id))!;
    const [claimed] = await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      return tx.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='running',execution_token=$2::uuid,
        claim_expires_at=now()+interval '60 seconds',updated_at=now(),blocked_reason=NULL WHERE id=$1::uuid AND state='queued' RETURNING *`, [row.id, randomUUID()]);
    });
    if (!claimed) return (await getWriteRequestById(engine, row.id))!;
    try {
      const prepared = await prepareManagedFileRepairMutation(engine, claimed, { engine: engine.kind } as GBrainConfig);
      localEditAdoptionSeams.beforePublish?.(path);
      row = await publishMutation(engine, claimed, prepared);
    } catch (error) { row = await finishUnpublishedFailure(engine, claimed, error, 'preparation'); }
    if (isTerminal(row) || Date.now() > deadline || !['writer_busy', 'writer_pool_capacity'].includes(row.blocked_reason ?? '')) return row;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * An adoption `publishAdoption` left unfinished (still blocked on the worktree lock, or claimed by the resident consumer
 * before its publication started) is cancelled, so a caller that keeps its refusal never has its local edit adopted later.
 */
async function settleAdoption(engine: BrainEngine, row: WriteRequest): Promise<WriteRequest> {
  if (isTerminal(row)) return row;
  const { cancelWriteRequest } = await import('./control.ts');
  const deadline = Date.now() + LOCK_RETRY_MS;
  for (;;) {
    const current = await cancelWriteRequest(engine, requestPrincipal(row), row.request_id) ?? row;
    if (isTerminal(current) || Date.now() > deadline) return current;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * The owner's answer to a drift refusal of `row` (coordinator.ts finishUnpublishedFailure): `released` once the local edit
 * is adopted and the write queued to prepare again, `error` when the adoption found the file changed under it (the
 * write ends with that refusal), null when the write keeps its own refusal.
 */
export async function adoptLocalEdit(engine: BrainEngine, row: WriteRequest, error: unknown): Promise<{ released: WriteRequest } | { error: OperationError } | null> {
  const target = (error as { localEdit?: LocalEditTarget } | null)?.localEdit;
  if (!target || !(error instanceof OperationError) || error.code !== 'source_changed' || error.detail !== 'file_database_drift' || error.reason
    || !ADOPTING_OPERATIONS.includes(row.operation) || (row.target_kind ?? 'page') !== 'page' || !row.worktree_id || row.intent?.adopted_local_edit
    || publicationGroupKey(row) !== null || !await adoptLocalEditsOn(engine, row.source_id)) return null;
  const binding = await getWorktreeBinding(engine, row.source_id);
  if (!binding?.local_path) return null;
  let admission: Awaited<ReturnType<typeof adoptionIntent>>;
  let admitted: WriteRequest | null;
  try {
    if (!await settled(target.path, await quietMs(engine)) || !await callerHolds(engine, row)) return null;
    admission = await adoptionIntent(engine, row, target, binding);
    if (!admission) return null;
    const params = admission.params;
    const ctx = { engine, sourceId: row.source_id, remote: false, dryRun: false, config: { engine: engine.kind } as GBrainConfig,
      logger: { info() {}, warn() {}, error() {} } } as OperationContext;
    admitted = await withRegisteredLocalWriter(engine, 'cli', async writer => {
      if (await getWriteRequest(engine, writer.principal, params.request_id)) return null;
      const { preparePageAdmission } = await import('./page-mutations.ts');
      const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params, managedFileImport: true });
      return prepared.prior ? null : admitWrite(engine, prepared.admission);
    });
  } catch { return null; }
  if (!admitted) return null;
  const done = await settleAdoption(engine, await publishAdoption(engine, row, admitted, target.path));
  if (done.state === 'committed') {
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw(`UPDATE persistence_requests SET intent=intent||$3::text::jsonb WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running'`,
        [row.id, row.execution_token, JSON.stringify({ adopted_local_edit: admission.adopted })]);
      await releaseUnpublishedClaim(tx, row, 'local_edit_adopted');
    });
    return { released: (await getWriteRequestById(engine, row.id))! };
  }
  if (done.error_code === 'source_changed' && (done.error_detail as { origin?: string } | null)?.origin === 'raw_file_changed') {
    return { error: new OperationError('source_changed', done.error_message ?? 'The canonical file changed after preparation.',
      `The canonical file of ${row.slug} in source ${row.source_id} changed again while gbrain adopted its local edit, so nothing was written. Read the file, then submit the write again with a new request_id.`) };
  }
  return null;
}

/**
 * The adoption's Git commit, made in its publication transaction before the row commits (file-repair.ts afterEffects):
 * only the adopted file, with the adoption's note, on a Git-durable checkout. A strict source's door already committed
 * it; a repo-less brain has nothing to commit. A commit that fails rolls the adoption back.
 */
export async function commitAdoptedLocalEdit(tx: BrainEngine, sourceId: string, binding: WorktreeBinding, path: string, note: GitCommitNote, outcome: Record<string, unknown>): Promise<void> {
  const root = binding.local_path!;
  if (await sourceCanonicalGit(tx, sourceId) || !await headCommit(root) || !(await gitDurabilityPolicy(binding, root)).durable) return;
  const rel = relative(root, path).split(sep).join('/');
  const result = (await commitGitTargets(root, [rel], undefined, new Map([[rel, note]]))).get(rel);
  if (result instanceof OperationError) throw result;
  if (result?.git === 'committed') Object.assign(outcome.persistence as object, { git_state: 'committed', git_commit: await headCommit(root) });
}

/** A write prepared again after its local edit was adopted names the adoption on its receipt (`adopted`). */
export function withAdoptedLocalEdit(row: WriteRequest, prepared: PreparedMutation): PreparedMutation {
  const adopted = row.intent?.adopted_local_edit as AdoptedLocalEdit | undefined;
  if (!adopted) return prepared;
  const apply = prepared.apply.bind(prepared);
  prepared.apply = async (tx, preimage) => ({ ...await apply(tx, preimage) as Record<string, unknown>, adopted });
  return prepared;
}
