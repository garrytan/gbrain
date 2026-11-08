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
 *
 * #8755 hardening: the quiet wait is capped at the foreground preparation budget (30 s), since the caller's running claim
 * holds its worktree's queue meanwhile; a file over PAGE_MAX_BYTES (checked before it is read) or a page stored in
 * segments keeps the refusal; so do an unmerged path or a merge, cherry-pick, revert or rebase in progress, a file equal to
 * an earlier stored revision, and one missing a Facts or timeline row the last revision added (a stale editor buffer
 * saved over gbrain's write). The repo-less test walks up for `.git` (a source in a subdirectory of its repository). A
 * publication that failed after the adoption's commit landed is requeued by recovery and published again (its validate
 * accepts HEAD holding the adopted blob; the commit is then named, not repeated). An adoption another task is
 * publishing is waited on, never left to commit after its caller was refused. The adoption names its caller's claim and
 * publishes nothing once that claim is gone (a crash between admission and settling); its own claim carries the owner
 * stamp like any other. A caller whose claim was lost meanwhile is reported as such, never as released.
 *
 * #8824/#8767: the caller check runs only until the adoption's own commit lands. A replay that finds HEAD holding it
 * (`landedAdoptionCommit`) publishes it whatever became of the caller, a requeued one is never cancelled, and recovery
 * names the commit on the receipt (`landed_before_row`) whether the adoption then commits or ends without committing.
 * #8826: a bisect or an uncommitted squash merge also keeps the refusal (`operationMarkerPaths`).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError, opError, type OperationContext } from '../ops/contract.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { assertInlineBody, isSegmentedPage } from '../page-body/page-shape.ts';
import { parseMarkdown } from '../markdown.ts';
import type { PageSnapshot } from '../page-state/types.ts';
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
import { blobAt, blobText, commitMessage, commitParent, headBlob, headCommit, landedCommit, operationMarkerPaths, unmergedPath } from './pending-import.ts';
import { ledgerLocation, messageDigest, readLedger } from '../git/commit-ledger.ts';
import { adoptedBy, localEditAdoptionCommit, type GitCommitNote } from './effect-model.ts';
import { claimOwner } from './claim-phase.ts';
import type { PreparedMutation } from './coordinator.ts';

export const ADOPTED_CHANGE_REASON = 'adopted_local_edit';
export const ADOPT_QUIET_KEY = 'persistence.adopt_quiet_ms';
const ADOPT_QUIET_DEFAULT_MS = 5_000;
/** A file is waited on for at most this many quiet windows. */
const QUIET_WINDOWS = 3;
/** #8755: the inline quiet wait never passes the foreground preparation budget: the caller's claim holds its worktree queue. */
const ADOPT_WAIT_MAX_MS = 30_000;
/** How long the adoption retries a worktree lock another owner task holds. */
const LOCK_RETRY_MS = 10_000;
/** #8755: how long an adoption another task is publishing is waited on past LOCK_RETRY_MS before the caller keeps its refusal. */
const PUBLISHING_WAIT_MS = 120_000;
/** Earlier stored revisions a stale editor save is compared with. */
const STALE_REVISIONS = 50;
const ADOPTING_OPERATIONS: readonly string[] = ['remember', 'capture', 'add_timeline_entry'];

/** Test seams: `beforePublish` runs between the adoption's preparation and its publication, with the file's path; `maxWaitMs` lowers the quiet-wait cap. */
export const localEditAdoptionSeams: { beforePublish?: (path: string) => void | Promise<void>; maxWaitMs?: number } = {};

/** The drifted file a `file_database_drift` refusal carries (page-prepare.ts compareFileTarget). */
interface LocalEditTarget { root: string; path: string }
export interface AdoptedLocalEdit { path: string; blob: string; replaced_revision: string }

export async function adoptLocalEditsOn(engine: BrainEngine, sourceId: string): Promise<boolean> {
  const value = await engine.getConfig(`persistence.adopt_local_edits.source.${sourceId}`).catch(() => null);
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}
async function quietMs(engine: BrainEngine): Promise<number> {
  const raw = String(await engine.getConfig(ADOPT_QUIET_KEY).catch(() => null) ?? '').trim();
  const value = raw ? Number(raw) : ADOPT_QUIET_DEFAULT_MS;
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 60_000) : ADOPT_QUIET_DEFAULT_MS;
}
/** #8755: whether a `.git` entry sits at `root` or above it (reconcile-state.ts insideGitCheckout): only a brain with none is repo-less. */
function insideGitCheckout(root: string): boolean {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true;
    if (dirname(dir) === dir) return false;
  }
}
const logAdoption = (row: WriteRequest, reason: string, error: unknown) => process.stderr.write(`[persistence] phase=adoption reason=${reason} source=${row.source_id} request=${row.request_id} `
  + `message="${String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 300)}"; the write keeps its file_database_drift refusal\n`);
/** The adoption's request id, derived from the caller's write so a write adopts at most once. */
function adoptionRequestId(row: Pick<WriteRequest, 'id'>): string {
  const h = sha256(`gbrain:adopt-local-edit:${row.id}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 + (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Waits until `path` has not changed for the quiet window; false when it is still changing after QUIET_WINDOWS windows or the cap. */
async function settled(path: string, quiet: number): Promise<boolean> {
  const deadline = Date.now() + Math.min(quiet * QUIET_WINDOWS, localEditAdoptionSeams.maxWaitMs ?? ADOPT_WAIT_MAX_MS);
  for (;;) {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age >= quiet) return true;
    if (Date.now() + quiet - age > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, quiet - age));
  }
}

/** The whitespace JS `trim` strips; the SQL side trims the same set, so an earlier revision matches whatever its edges hold. */
const EDGE_WHITESPACE = ' \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const edgeTrim = (text: string | null | undefined) => (text ?? '').trim();
/** Body lines that are Facts or timeline fence rows (list items and table rows, not a table's separator line). */
function fenceRows(...texts: Array<string | null | undefined>): Set<string> {
  return new Set(texts.flatMap(text => (text ?? '').split('\n')).map(line => line.trim()).filter(line => /^(- |\|)/.test(line) && !/^\|[\s:|-]*\|?$/.test(line)));
}
/**
 * #8755: a stale editor save: the file equals one of the last STALE_REVISIONS stored revisions' bodies (matched by hash in
 * SQL, no version body is loaded), or lacks a Facts or timeline row the last revision added (rows the page holds that its
 * newest archived version, the revision before, did not). Inline pages only: adoptionIntent refuses a segmented page first.
 */
async function staleEditorSave(engine: BrainEngine, slug: string, text: string, snapshot: PageSnapshot, activePack: unknown): Promise<boolean> {
  assertInlineBody(snapshot.page, 'staleEditorSave');
  const file = parseMarkdown(text, slug, { activePack } as never);
  const [compiled, timeline] = [edgeTrim(file.compiled_truth), edgeTrim(file.timeline)];
  if (compiled !== edgeTrim(snapshot.page.compiled_truth) || timeline !== edgeTrim(snapshot.page.timeline)) {
    const [earlier] = await engine.executeRaw<{ same: boolean }>(`SELECT EXISTS (SELECT 1 FROM (SELECT compiled_truth, timeline FROM page_versions
        WHERE page_id=$1 AND compiled_truth IS NOT NULL ORDER BY id DESC LIMIT $2) v
      WHERE md5(btrim(v.compiled_truth, $5))=md5($3) AND md5(btrim(COALESCE(v.timeline, ''), $5))=md5($4)) AS same`,
    [snapshot.page.id, STALE_REVISIONS, compiled, timeline, EDGE_WHITESPACE]);
    if (earlier?.same) return true;
  }
  const [previous] = await engine.executeRaw<{ compiled_truth: string; timeline: string | null }>(
    'SELECT compiled_truth, timeline FROM page_versions WHERE page_id=$1 AND compiled_truth IS NOT NULL ORDER BY id DESC LIMIT 1', [snapshot.page.id]);
  if (!previous) return false;
  const before = fenceRows(previous.compiled_truth, previous.timeline);
  const kept = fenceRows(file.compiled_truth, file.timeline);
  return [...fenceRows(snapshot.page.compiled_truth, snapshot.page.timeline)].some(line => !before.has(line) && !kept.has(line));
}

/** What adopting the edit to `target` admits, or null when the edit is not one-sided and safe. */
async function adoptionIntent(engine: BrainEngine, row: WriteRequest, target: LocalEditTarget, binding: WorktreeBinding) {
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  const sourcePath = snapshot?.page.source_path;
  if (!snapshot || !sourcePath || snapshot.page.deleted_at || isSegmentedPage(snapshot.page)) return null;
  if (statSync(target.path).size > PAGE_MAX_BYTES) return null;
  const bytes = readFileSync(target.path);
  const text = bytes.toString('utf8');
  // An edit whose bytes do not decode losslessly would be rewritten by its own adoption, so it keeps the refusal.
  if (!Buffer.from(text, 'utf8').equals(bytes)) return null;
  const commit = await headCommit(target.root);
  // A checkout whose HEAD git cannot read keeps the refusal; only a brain with no repository has no HEAD to ask.
  if (!commit && insideGitCheckout(binding.local_path!)) return null;
  const head = commit ? await headBlob(target.root, target.path) : undefined;
  if (head === null) return null;
  if (commit && await conflictOrOperation(target.root, target.path)) return null;
  const { prepareRepairPublication, repairScreenConfig } = await import('./file-repair.ts');
  const screen = await repairScreenConfig(engine, row.source_id);
  // A checkout whose HEAD holds the database's copy: only the worktree file moved. A repo-less brain has no HEAD to ask.
  const committed = head ? await blobText(target.root, head) : null;
  if (head && (committed === null || !await fileMatchesSnapshot(engine, row.slug, committed, snapshot, sourcePath, screen.activePack))) return null;
  if (await protectedLocalEdit(engine, row.slug, text, snapshot, screen.activePack)) return null;
  if (await staleEditorSave(engine, row.slug, text, snapshot, screen.activePack)) return null;
  const path = relative(target.root, target.path).split(sep).join('/');
  const publication = await prepareRepairPublication(engine, { sourceId: row.source_id, slug: row.slug, sourcePath, path, root: target.root,
    content: text, snapshot, base: snapshot, ...screen });
  if (publication.status !== 'ready') return null;
  const adopted: AdoptedLocalEdit = { path, blob: gitBlobOid(bytes, head?.length === 64 ? 'sha256' : 'sha1'), replaced_revision: snapshot.revision };
  return { adopted, params: { kind: 'managed_file_repair', slug: row.slug, path, sourcePath, content: text, beforeHash: sha256(bytes),
    resultDigest: publication.digest, ownerEpoch: String(binding.owner_epoch), expected_revision: snapshot.revision, noEmbed: true,
    adoptLocalEdit: { blob: adopted.blob, replaced_revision: adopted.replaced_revision, head: head ?? null, caller: { id: row.id, token: row.execution_token } },
    source_id: row.source_id, request_id: adoptionRequestId(row) } };
}

/**
 * Conflict markers from a merge, stash pop, cherry-pick or rebase are never adopted (`git add` would mark them resolved):
 * true when `path` has unmerged stages or an operation is in progress, or when git cannot tell. Checked at admission and
 * again in the publication transaction, since either can start in between.
 */
export async function conflictOrOperation(root: string, path: string): Promise<boolean> {
  return await unmergedPath(root, path) !== false || (await operationMarkerPaths(root))?.every(marker => !existsSync(marker)) !== true;
}

/** Whether the caller still holds the claim its refusal is being answered under (a cancelled caller adopts nothing). */
async function callerHolds(engine: BrainEngine, caller: WriteRequest): Promise<boolean> {
  return (await engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE id=$1::uuid AND state='running' AND execution_token=$2::uuid`,
    [caller.id, caller.execution_token])).length > 0;
}

/**
 * Publication's recheck (file-repair.ts validate): HEAD still holds the blob the adoption read, so no newer commit is
 * overwritten; or the adopted blob itself (#8755: this adoption's own commit landed before a publication that failed
 * after it, and recovery requeued it).
 */
export async function adoptedHeadHolds(binding: WorktreeBinding, root: string, path: string, head: string | null, blob?: string): Promise<boolean> {
  if (head === null) return !insideGitCheckout(binding.local_path!);
  const current = await headBlob(root, path);
  return current === head || (blob !== undefined && current === blob);
}

/**
 * #8755: the claim an adoption is made under (`adoptLocalEdit.caller`) still holds, checked as the adoption prepares: an
 * adoption whose caller is gone (cancelled, finished, or reclaimed after a crash between admission and settling)
 * publishes nothing. In the publication transaction (`lock`) the caller row is held FOR SHARE, so a cancel waits until it ends.
 */
export async function assertAdoptionCaller(engine: BrainEngine, row: WriteRequest, caller: { id?: unknown; token?: unknown } | undefined, lock = false): Promise<void> {
  if (!caller) return;
  const [held] = typeof caller.id === 'string' && typeof caller.token === 'string' ? await engine.executeRaw(
    `SELECT 1 FROM persistence_requests WHERE id=$1::uuid AND state='running' AND execution_token=$2::uuid${lock ? ' FOR SHARE' : ''}`, [caller.id, caller.token]) : [];
  if (held) return;
  throw opError('write_claim_lost', 'The write this local edit adoption was made for no longer waits on it.',
    `Adoption request ${row.request_id} in source ${row.source_id} belongs to a write whose claim ended (it was cancelled, finished, or reclaimed after its process stopped), so the local edit was not adopted and nothing was written.`);
}

/**
 * #8824: the commit of this adoption when HEAD already holds it: the newest commit on the path is `gbrain: adopt local edit
 * to <path>` carrying this adoption's `gbrain-adopted:` trailer and commit-ledger line, its parent held the pre-adoption
 * blob, and HEAD holds the adopted blob. The ledger's commit line is best-effort (written after `git commit`), so the
 * intent line written before it also proves the commit when its `head_before` is the commit's parent and its message
 * digest is the commit's. Null otherwise, on a repo-less brain, or when Git or the ledger cannot be read.
 * A replay that finds it publishes whatever became of its caller (the commit is durable), and its receipt names it.
 */
export async function landedAdoptionCommit(root: string, target: string, adopted: { path: string; blob: string; replaced_revision: string; head: string | null }): Promise<string | null> {
  if (adopted.head === null || await headBlob(root, target) !== adopted.blob) return null;
  const commit = await landedCommit(root, null, target);
  if (!commit || await blobAt(root, `${commit}^`, target) !== adopted.head) return null;
  const note = localEditAdoptionCommit(adopted.path, adopted.blob, adopted.replaced_revision);
  const message = await commitMessage(root, commit);
  const lines = message?.split('\n') ?? [];
  if (lines[0] !== note.subject || !note.trailers?.every(trailer => lines.includes(trailer))) return null;
  const [trailer] = adoptedBy(note.trailers);
  const location = ledgerLocation(root);
  let records: ReturnType<typeof readLedger>;
  try { records = location ? readLedger(location.common) : []; } catch { return null; }
  if (records.some(record => record.e === 'commit' && record.sha === commit && record.adopted?.includes(trailer!))) return commit;
  const parent = await commitParent(root, commit), digest = messageDigest(message!);
  return parent && records.some(record => record.e === 'intent' && record.head_before === parent && record.msg_sha256 === digest) ? commit : null;
}

/** #8824/#8767: `landedAdoptionCommit` for an adoption request `row` (any other request answers null), read on `binding`'s checkout. */
export async function adoptionCommitLanded(engine: BrainEngine, row: WriteRequest, binding?: WorktreeBinding | null): Promise<string | null> {
  const intent = row.intent as { kind?: unknown; path?: unknown; adoptLocalEdit?: { blob?: unknown; replaced_revision?: unknown; head?: unknown } } | null;
  const adopted = intent?.adoptLocalEdit;
  if (intent?.kind !== 'managed_file_repair' || typeof intent.path !== 'string' || typeof adopted?.blob !== 'string'
    || typeof adopted.replaced_revision !== 'string' || typeof adopted.head !== 'string') return null;
  const bound = binding === undefined ? await getWorktreeBinding(engine, row.source_id) : binding;
  if (!bound?.local_path) return null;
  const root = join(bound.local_path, bound.relative_path);
  return landedAdoptionCommit(root, join(root, intent.path), { path: intent.path, blob: adopted.blob, replaced_revision: adopted.replaced_revision, head: adopted.head });
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
        claim_expires_at=now()+interval '60 seconds',updated_at=now(),blocked_reason=NULL,
        claim_phase=jsonb_build_object('token',$2::text,'owner',$3::text::jsonb,'claimed_at',to_jsonb(now())) WHERE id=$1::uuid AND state='queued' RETURNING *`, [row.id, randomUUID(), JSON.stringify(claimOwner())]);
    });
    if (!claimed) return (await getWriteRequestById(engine, row.id))!;
    try {
      const prepared = await prepareManagedFileRepairMutation(engine, claimed, { engine: engine.kind } as GBrainConfig);
      await localEditAdoptionSeams.beforePublish?.(path);
      row = await publishMutation(engine, claimed, prepared);
    } catch (error) { row = await finishUnpublishedFailure(engine, claimed, error, 'preparation'); }
    // #8755: any release is retried, a publication recovery requeued after the adoption's commit landed included.
    if (isTerminal(row) || Date.now() > deadline || row.state !== 'queued') return row;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * An adoption `publishAdoption` left unfinished (still blocked on the worktree lock, or claimed by the resident consumer
 * before its publication started) is cancelled, so a caller that keeps its refusal never has its local edit adopted later.
 * #8755: one whose publication another task already started (or a recovery record holds) cannot be cancelled; it is
 * waited on for PUBLISHING_WAIT_MS more, so it does not commit after its caller was refused.
 */
async function settleAdoption(engine: BrainEngine, row: WriteRequest): Promise<WriteRequest> {
  if (isTerminal(row)) return row;
  const { cancelWriteRequest } = await import('./control.ts');
  const deadline = Date.now() + LOCK_RETRY_MS;
  for (;;) {
    // #8824: a requeued adoption whose commit already landed is left for the consumer, which publishes it naming that
    // commit; cancelling it would orphan the commit.
    const latest = (await getWriteRequestById(engine, row.id)) ?? row;
    if (latest.state === 'queued' && await adoptionCommitLanded(engine, latest)) return latest;
    const current = await cancelWriteRequest(engine, requestPrincipal(row), row.request_id) ?? row;
    if (isTerminal(current)) return current;
    const publishing = current.publication_started || current.recovery != null;
    if (Date.now() > deadline + (publishing ? PUBLISHING_WAIT_MS : 0)) return current;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * The owner's answer to a drift refusal of `row` (coordinator.ts finishUnpublishedFailure): `released` once the local edit
 * is adopted and the write queued to prepare again, `error` when the adoption found the file changed under it (the
 * write ends with that refusal), null when the write keeps its own refusal.
 */
export async function adoptLocalEdit(engine: BrainEngine, row: WriteRequest, error: unknown): Promise<{ released: WriteRequest } | { claimLost: WriteRequest } | { error: OperationError } | null> {
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
  } catch (failure) { logAdoption(row, 'admission_failed', failure); return null; }
  if (!admitted) return null;
  const done = await settleAdoption(engine, await publishAdoption(engine, row, admitted, target.path));
  if (done.state === 'committed') {
    // #8755: the release is fenced on the caller's token; a claim lost meanwhile is reported as lost, never as released.
    const kept = await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      const [held] = await tx.executeRaw(`UPDATE persistence_requests SET intent=intent||$3::text::jsonb WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' RETURNING id`,
        [row.id, row.execution_token, JSON.stringify({ adopted_local_edit: admission.adopted })]);
      if (held) await releaseUnpublishedClaim(tx, row, 'local_edit_adopted');
      return !!held;
    });
    const current = (await getWriteRequestById(engine, row.id))!;
    return kept ? { released: current } : { claimLost: current };
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
  // #8755: a replay after the commit landed (validate accepted HEAD holding the adopted blob) names that commit.
  else if (result?.git === 'unchanged') {
    const landed = await landedCommit(root, null, path);
    if (landed) Object.assign(outcome.persistence as object, { git_state: 'committed', git_commit: landed, landed_before_row: true });
  }
}

/** A write prepared again after its local edit was adopted names the adoption on its receipt (`adopted`). */
export function withAdoptedLocalEdit(row: WriteRequest, prepared: PreparedMutation): PreparedMutation {
  const adopted = row.intent?.adopted_local_edit as AdoptedLocalEdit | undefined;
  if (!adopted) return prepared;
  const apply = prepared.apply.bind(prepared);
  prepared.apply = async (tx, preimage) => ({ ...await apply(tx, preimage) as Record<string, unknown>, adopted });
  return prepared;
}
