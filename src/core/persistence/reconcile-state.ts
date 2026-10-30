import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { loadConfig, loadConfigFileOnly, loadConfigWithEngine, type GBrainConfig } from '../config.ts';
import { loadOperatorLiterals } from '../content-sanity-literals.ts';
import { parseMarkdown } from '../markdown.ts';
import { alignWithStored } from './align-stored.ts';
import { parseDataFrontmatter } from '../data-frontmatter.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { recordedPathFromFileUri, scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { absentCanonicalPath, findLiveFileClaimants, recordedReconcilePath, type FileClaimTarget } from './file-claims.ts';
import { wholeBodySnapshot } from './segmented-apply.ts';
import { sharedOriginExit } from './sync-origin.ts';
import { originTwinsPreviewArgv } from './origin-twins.ts';
export { fileClaimCandidatesQuery } from './file-claims.ts';
import { localHostId } from './identity.ts';
import { isDatabaseOnlyPage, recordsNoFileOrigin, slugDerivedOrigin } from './unbound-pages.ts';
import { isUnboundSourcePage } from './unbound-source.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { digest, gitBlobOid, requireUuid, sha256, stableJson } from './digest.ts';
import { SYNC_ORIGIN_DELETED_OP } from './sync-pass-row.ts';
import { reconcileCanonical, strictReconcileKeys, validateReconcileJson, type ReconcileConflict, type ReconcileDecision } from './reconcile-merge.ts';
import type { ParsedPage } from '../import-file.ts';
import type { AutoDecision } from './reconcile-additive.ts';
import { publishesDatabaseOnly, readCanonicalAsImported } from './page-prepare.ts';
import { isMirrorOnlyPage, staleMirrorPage } from './mirror-read-only.ts';
import { hardenedGitSync } from '../hardened-git.ts';

export interface ReconcilePins {
  brain_id: string; source_id: string; source_incarnation: string; slug: string; page_id: number;
  worktree_id: string; binding_digest: string; owner_epoch: string; revision: string;
  raw_file_hash: string; relative_path: string; policy_digest: string; withdrawals_digest: string; assessment_at: string;
}
export interface ReconcileArtifact {
  /** 2 when the preview carries #5974 automatic decisions. */
  format_version: 1 | 2; preview_id: string; preconditions: ReconcilePins;
  preimages: { file_base64: string; database: PageSnapshot; stored_page: Record<string, unknown> };
  decisions: ReconcileDecision[]; conflicts: ReconcileConflict[]; result: ParsedPage; result_digest: string;
  status: 'needs_resolution' | 'ready';
  auto_decisions?: AutoDecision[];
}
export interface ReconcileState {
  binding: WorktreeBinding; root: string; path: string; raw: Buffer; snapshot: PageSnapshot;
  /** The path the importer reads the file under (`scannerSourcePath`), for path inference (#6605). */
  importPath: string;
  storedPage: Record<string, unknown>; file: ParsedPage; pins: ReconcilePins;
  /** `slug_derived`: a database-only page matched to the canonical file at its slug path. */
  origin: 'recorded' | 'slug_derived';
  /** The `source_path` apply records for a `slug_derived` origin. */
  originSourcePath: string | null;
}
/**
 * Cycle bookkeeping that `cycle.ts` stamps into `sources.config` after every
 * successful source cycle. It is not reconcile policy, so it stays out of the
 * policy digest: otherwise an autopilot cycle between preview and apply made
 * every reconcile preview stale.
 */
const CYCLE_STAMP_KEYS = ['last_source_cycle_at', 'last_full_cycle_at'];

/**
 * #7506: the file and environment side of the policy digest, as every consumer on the owner host resolves it: the config
 * file, with the content-sanity overrides the environment sets (the import gate's env > file > DB). Any consumer on that
 * host may prepare and publish an admitted reconcile, each with its own environment, so the rest of the environment
 * (credentials, connection targets, model and gateway choices) stays out: none of it changes what a reconcile writes, and
 * a consumer whose environment differed from the previewing process's read every preview stale.
 */
function reconcilePolicyBase(): GBrainConfig | null {
  const file = loadConfigFileOnly();
  const sanity = loadConfig()?.content_sanity;
  return sanity ? { ...(file ?? { engine: 'postgres' }), content_sanity: sanity } : file;
}

export async function reconcilePolicyDigest(engine: BrainEngine, sourceId: string): Promise<string> {
  const config = await loadConfigWithEngine(engine, reconcilePolicyBase());
  const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT config,contextual_retrieval_mode,trust_frontmatter_overrides FROM sources WHERE id=$1', [sourceId]);
  let sourceConfig = row?.config;
  if (typeof sourceConfig === 'string') {
    try { sourceConfig = JSON.parse(sourceConfig); } catch { /* digest the raw text */ }
  }
  if (sourceConfig && typeof sourceConfig === 'object' && !Array.isArray(sourceConfig)) {
    sourceConfig = Object.fromEntries(Object.entries(sourceConfig).filter(([key]) => !CYCLE_STAMP_KEYS.includes(key)));
  }
  const source = row ? { ...row, config: sourceConfig } : row;
  return digest({ version: 1, config, source, literals: loadOperatorLiterals(), disabled: process.env.GBRAIN_NO_SANITY ?? null });
}
/**
 * #6712 wave: the `raw_file_hash` pin of a preview that observed the canonical file absent (`readReconcileState` with
 * `fileGone`). No file's sha256 is all zeros, so a file that reappears before apply never matches it.
 */
export const ABSENT_FILE_HASH = '0'.repeat(64);
/** The read options a stored preview implies: its slug-path adoption, and whether it observed the file absent. */
export function reconcileReadOptions(artifact: Pick<ReconcileArtifact, 'preimages' | 'preconditions'>): { adoptSlugPath: boolean; fileGone: boolean } {
  return { adoptSlugPath: reconcilePreviewAdopts(artifact), fileGone: artifact.preconditions.raw_file_hash === ABSENT_FILE_HASH };
}
/**
 * #6712 wave: where a missing canonical file's deletion stands in Git. `in_head`: still committed at HEAD (deleted only in
 * the worktree, staged or not); `gone`: not in HEAD's tree, or the checkout has no commit or no Git; `unknown`: Git
 * could not say. Filter-free plumbing only, each call bounded (hardened-git.ts).
 */
export function canonicalDeletionState(root: string, path: string): 'in_head' | 'gone' | 'unknown' {
  const limits = { timeoutMs: 10_000, maxBytes: 1024 * 1024 };
  const top = hardenedGitSync(root, ['rev-parse', '--show-toplevel'], limits);
  if (!top.ok) return insideGitCheckout(root) ? 'unknown' : 'gone';
  const head = hardenedGitSync(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], limits);
  if (!head.ok) return head.reason === 'exit' && head.status === 1 ? 'gone' : 'unknown';
  let repoPath: string;
  try { repoPath = relative(realpathSync(top.stdout.toString('utf8').trim()), absentCanonicalPath(path)).split(sep).join('/'); } catch { return 'unknown'; }
  if (!repoPath || repoPath.startsWith('..')) return 'unknown';
  const listed = hardenedGitSync(root, ['ls-tree', '-z', '--full-tree', 'HEAD', '--', repoPath], limits);
  if (!listed.ok) return 'unknown';
  return listed.stdout.toString('utf8').split('\0').some(entry => entry.split('\t')[1] === repoPath) ? 'in_head' : 'gone';
}
/**
 * #6712 PR 4b: the deleted side of a held `file_drift` file that is present (design v3.2 §4, classifier row 9). A deleted page
 * still at the origin is `tombstone_edited` (the newest one; `pageId` names the held one when it is still there); with no
 * page row left, a `deleted` marker at the origin (`sync-origin-deleted`) is `purged_differs`. The result pins what a
 * resolution is bound to: the file's bytes, the tombstone's id and revision, the marker's value.
 */
export interface DeletedDriftTarget {
  state: 'tombstone_edited' | 'purged_differs';
  root: string;
  /** Absolute path of the file, and its source-relative spelling. */
  path: string;
  relative_path: string;
  source_path: string;
  raw: Buffer;
  raw_file_hash: string;
  tombstone: { page_id: number; slug: string; revision: string } | null;
  marker_digest: string | null;
}
/** Why a held path no longer has a deleted side to resolve; a fresh sync re-classifies it. */
export type DeletedDriftChange = 'file_gone' | 'live_page' | 'no_deletion' | 'deleted_same';
export async function readDeletedDriftTarget(engine: BrainEngine, sourceId: string, input: { path: string; sourcePath: string; pageId?: number | null }):
  Promise<DeletedDriftTarget | { changed: DeletedDriftChange }> {
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!binding?.local_path || binding.owner_host_id !== localHostId() || binding.state !== 'active') {
    throw new OperationError('owner_unavailable', 'Reconciliation requires the existing active owner on this host.', 'Run repair on the current owner; repair never claims or activates a source.');
  }
  const root = realpathSync(join(binding.local_path, binding.relative_path));
  const path = join(root, ...input.path.split('/'));
  if (!isWriteTargetContained(path, root)) throw opError('source_changed', 'The held file is outside its registered source.',
    `Nothing changed. ${input.path} resolves outside source '${sourceId}''s checkout (a symlinked directory or a moved checkout); inspect the owner before previewing again.`);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw opError('source_changed', 'The held file is not an ordinary file; repair does not replace it.',
      `Nothing changed. Make ${input.path} in '${sourceId}' a regular file (not a symlink, directory or hard link), then preview again.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { changed: 'file_gone' };
    throw error;
  }
  const raw = readFileSync(path);
  const pin = { root, path, relative_path: input.path, source_path: input.sourcePath, raw, raw_file_hash: sha256(raw) };
  const claims = await engine.executeRaw<{ id: number; slug: string; deleted: boolean }>(
    `SELECT id, slug, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND source_path=$2 ORDER BY deleted_at DESC NULLS FIRST, id DESC`, [sourceId, input.sourcePath]);
  if (claims.some(row => !row.deleted)) return { changed: 'live_page' };
  const tombstone = claims.find(row => Number(row.id) === input.pageId) ?? claims[0];
  if (tombstone) {
    const snapshot = await engine.readPageSnapshot(tombstone.slug, { sourceId, includeDeleted: true });
    if (!snapshot || Number(snapshot.page.id) !== Number(tombstone.id) || !snapshot.page.deleted_at) staleReconcile('the deleted page changed during the preview');
    return { state: 'tombstone_edited', ...pin, tombstone: { page_id: Number(tombstone.id), slug: tombstone.slug, revision: snapshot.revision }, marker_digest: null };
  }
  const [marker] = await engine.executeRaw<{ value: { kind?: string; blob_oids?: unknown } | null }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [SYNC_ORIGIN_DELETED_OP, `${sourceId}:${binding.source_incarnation}:${input.sourcePath}`]);
  if (!marker?.value || marker.value.kind === 'legacy') return { changed: 'no_deletion' };
  const held = Array.isArray(marker.value.blob_oids) ? marker.value.blob_oids : [];
  if (held.includes(gitBlobOid(raw, 'sha1')) || held.includes(gitBlobOid(raw, 'sha256'))) return { changed: 'deleted_same' };
  return { state: 'purged_differs', ...pin, tombstone: null, marker_digest: digest(marker.value) };
}
/** Whether `root` or an ancestor holds a `.git` entry (a checkout Git should answer for). */
function insideGitCheckout(root: string): boolean {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true;
    if (dirname(dir) === dir) return false;
  }
}
/**
 * #6712 wave: the route for a page whose canonical file `rel` (source-relative) is missing, by where its deletion stands
 * in Git: still committed at HEAD goes to committing the deletion or `repair ghost-pages`; gone from HEAD goes to
 * `repair file-drift`.
 */
export function missingFileRoute(sourceId: string, slug: string, rel: string, state: ReturnType<typeof canonicalDeletionState>): string {
  const fileDrift = `gbrain repair file-drift --source ${sourceId} --slug ${slug} --prefer database`;
  const ghosts = `gbrain repair ghost-pages --source ${sourceId}`;
  if (state === 'in_head') return `${rel} is deleted in the worktree but still committed, so this is not file drift: commit the deletion (sync then imports it), or remove the page with ${ghosts}; to keep the page, restore the file from Git (git checkout -- ${rel}) and sync.`;
  if (state === 'gone') return `${rel} is gone from the last commit. Preview the resolution with ${fileDrift} (recreates the file from the page) or with --prefer file (soft-deletes the page), then apply the printed command after the user decides.`;
  return `Git could not say whether the deletion of ${rel} is committed. If it is (gone from HEAD), preview ${fileDrift} or --prefer file; if it is deleted only in the worktree, commit the deletion or remove the page with ${ghosts}.`;
}
/** The refusal for a canonical file that is gone, routed by where its deletion stands in Git (#6712 wave). */
function missingCanonicalFile(sourceId: string, slug: string, root: string, path: string): OperationError {
  const rel = relative(root, path).split(sep).join('/');
  return opError('source_changed', 'The recorded canonical file is missing.',
    `Nothing changed. The canonical file of ${slug} in '${sourceId}' is missing. ${missingFileRoute(sourceId, slug, rel, canonicalDeletionState(root, path))}`,
    { detail: 'canonical_file_missing' });
}
export function staleReconcile(what: string): never {
  throw new OperationError('source_changed', `Reconciliation preview is stale: ${what}.`, 'Generate a fresh preview; submit a corrected intent with a new request ID.');
}
/**
 * Refuses when another live page of the source records the reconciled file as its own
 * (`findLiveFileClaimants`, file-claims.ts: the paged same-name census, realpath deciding).
 * #6517: the refusal names the exit, a soft delete of the page that should not own the file.
 */
async function assertSoleFileClaim(engine: BrainEngine, target: FileClaimTarget): Promise<void> {
  const [claimant] = await findLiveFileClaimants(engine, target);
  if (claimant) throw opError('source_changed', 'Several pages claim the recorded canonical file.',
    `Nothing changed. Pages ${target.slug} and ${claimant.slug} in '${target.sourceId}' both record the same file, so reconcile cannot tell which owns it; decide with the user which page owns the file before reconciling either. `
    + sharedOriginExit(target.sourceId, [target.slug, claimant.slug]) + ' Then preview again.',
    // #6948 (B-15): the read-only group listing names the page that keeps the file and the exact command for each other one.
    { detail: 'shared_origin', fix: readFix(`Lists the duplicate-origin group of ${target.slug} and ${claimant.slug} with the page its path names and the command that resolves each other page; writes nothing.`,
      { argv: originTwinsPreviewArgv(target.sourceId) }) });
}
/**
 * #6394: `adoptSlugPath` lets a live page with no recorded origin and no database-only marker reconcile against the file
 * at its slug path (mode-aware, as discovery names it). A page that publishes database-only by design (a declared db_only
 * slug, a never-filed derive-phase page) or a mirror-only page never adopts one.
 */
export async function readReconcileState(engine: BrainEngine, sourceId: string, slug: string, assessmentAt = new Date().toISOString(),
  opts: { adoptSlugPath?: boolean; fileGone?: boolean } = {}): Promise<ReconcileState> {
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!binding?.local_path || binding.owner_host_id !== localHostId() || binding.state !== 'active') {
    throw new OperationError('owner_unavailable', 'Reconciliation requires the existing active owner on this host.', 'Run repair on the current owner; repair never claims or activates a source.');
  }
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  // Wave B: a page stored in segments is compared and merged as strings up to 24 MiB; a larger one refuses.
  const snapshot = await wholeBodySnapshot(engine, await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }), 'sources reconcile');
  if (!snapshot || snapshot.page.deleted_at) throw opError('page_not_found', 'Reconciliation requires an existing live page; use the separate restore workflow for deleted pages.',
    `Page ${slug} in '${sourceId}' is deleted or missing; nothing changed. If it was deleted by mistake, restore it (gbrain restore, within the 72-hour window) and then preview it again.`,
    { fix: readFix('Shows whether the page exists or is soft-deleted in this source.', { argv: ['gbrain', 'get', '--source', sourceId, '--include-deleted', '--', slug] }) });
  if (binding.source_incarnation !== snapshot.sourceIncarnation) staleReconcile('source binding incarnation');
  const [storedPage] = await engine.executeRaw<Record<string, unknown>>(`SELECT id,source_id,slug,type,title,compiled_truth,timeline,frontmatter,
    content_hash,source_path,source_kind,source_uri,ingested_via,ingested_at,knowledge_revision,deleted_at FROM pages WHERE id=$1 AND source_id=$2`, [snapshot.page.id, sourceId]);
  const root = realpathSync(join(binding.local_path, binding.relative_path));
  const recorded = recordedPathFromFileUri(snapshot.page.source_uri, root);
  const mode = await scannerSlugRootMode(engine, sourceId, root);
  const recordedPath = recordedReconcilePath(root, snapshot.page, mode);
  const marked = !recordedPath && (isDatabaseOnlyPage({ ...snapshot.page,
    database_only_reason: await isUnboundSourcePage(engine, sourceId, slug) ? 'unbound_source' : null }) || await staleMirrorPage(engine, sourceId, snapshot.page));
  const adoptable = !recordedPath && !marked && opts.adoptSlugPath === true && recordsNoFileOrigin(snapshot.page)
    && !publishesDatabaseOnly(root, slug, snapshot) && !await isMirrorOnlyPage(engine, sourceId, slug);
  const derived = marked || adoptable ? slugDerivedOrigin(root, slug, mode) : null;
  const origin = derived ? 'slug_derived' : 'recorded';
  const path = recordedPath ?? derived?.path ?? null;
  if (!path || !isWriteTargetContained(path, root)) throw opError('source_changed', 'The page has no unambiguous confined recorded Markdown origin.',
    `Page ${slug} in '${sourceId}' records no Markdown file inside the source checkout, so there is nothing to reconcile it against; nothing changed. ${!recordedPath && !marked && recordsNoFileOrigin(snapshot.page) && opts.adoptSlugPath !== true
      ? `If the file at its slug path is this page's canonical file, preview again with --adopt-slug-path (gbrain sources reconcile ${sourceId} ${slug} --preview --adopt-slug-path) to adopt it; otherwise check its recorded source path with the command in fix.` : 'Check its recorded source path with the command in fix.'}`,
    { fix: readFix('Shows the page and its recorded source path.', { argv: ['gbrain', 'get', '--source', sourceId, '--', slug] }) });
  let size: number;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('not an ordinary file');
    size = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw opError('source_changed', 'The recorded canonical file is not an ordinary file; repair does not replace it.',
      `Nothing changed. Make the canonical file of ${slug} in '${sourceId}' a regular file (not a symlink, directory or hard link), then preview the page again.`);
    if (!opts.fileGone || origin !== 'recorded') throw missingCanonicalFile(sourceId, slug, root, path);
    // #6712 wave: `repair file-drift --prefer database` recreates the file from the page; the preview pins the observed absence.
    const canonicalPath = absentCanonicalPath(path);
    await assertSoleFileClaim(engine, { sourceId, slug, pageId: snapshot.page.id, root, mode, path, canonicalPath,
      recordedUri: recorded ? snapshot.page.source_uri ?? null : null, absent: true });
    return { binding, root, path, importPath: scannerSourcePath(root, path, mode), raw: Buffer.alloc(0), snapshot, storedPage,
      file: reconcileCanonical(snapshot.page, snapshot.tags), origin, originSourcePath: null,
      pins: await reconcilePins(engine, { brain_id: brain.brain_id, sourceId, binding, snapshot, slug, assessmentAt, root, path, canonicalPath, rawFileHash: ABSENT_FILE_HASH }) };
  }
  const { readJournalLimits } = await import('./limits.ts');
  const limits = await readJournalLimits(engine);
  if (size > Math.min(limits.principalIntentBytes, limits.brainIntentBytes, limits.worktreeRecoveryBytes)) {
    throw opError('request_too_large', 'The canonical file exceeds reconciliation capacity.',
      `Nothing changed. The canonical file of ${slug} in '${sourceId}' is larger than the journal's request and recovery limits; tell the user the page needs a manual edit of that file.`);
  }
  const canonicalPath = realpathSync(path);
  await assertSoleFileClaim(engine, { sourceId, slug, pageId: snapshot.page.id, root, mode, path, canonicalPath,
    recordedUri: recorded ? snapshot.page.source_uri ?? null : null });
  const raw = readFileSync(path), text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) throw opError('invalid_params', 'The canonical file must contain valid UTF-8.',
    `Nothing changed. Re-save the canonical file of ${slug} in '${sourceId}' as UTF-8, then preview the page again.`);
  try { parseDataFrontmatter(text); }
  catch {
    throw opError('invalid_params', 'Canonical file metadata cannot be parsed losslessly; repair its syntax before previewing.',
      `Nothing changed. Fix the frontmatter of the canonical file of ${slug} in '${sourceId}' (quote values containing ': ', close the --- block), then preview the page again.`);
  }
  // Preserve a terminal .md in the page key while parsing the canonical Markdown.
  const importPath = scannerSourcePath(root, path, mode);
  const reading = reconcileFileReading(text, importPath, snapshot.page);
  const parsed = parseMarkdown(reading.content, `${slug}.md`, { validate: true, expectedSlug: slug });
  alignWithStored(parsed, snapshot.page, reading.inferred);
  const errors = parsed.errors?.filter(e => !['MISSING_OPEN', 'MISSING_CLOSE', 'EMPTY_FRONTMATTER'].includes(e.code)) ?? [];
  if (!errors.length && !parsed.errors?.some(e => e.code === 'MISSING_CLOSE') && parsed.slug !== slug) {
    // #5966 (W14 P1.7): a well-formed file whose path derives another slug is a legacy render of a slug the
    // path cannot derive, written before renders stamped `slug:`; the frontmatter repair proposes the stamp.
    throw opError('source_changed', 'The canonical file carries no slug stamp, so its path derives a different slug.',
      `Nothing changed. The file of ${slug} in '${sourceId}' reads as ${parsed.slug} from its path. Preview the stamp with gbrain repair frontmatter --source ${sourceId} --only ${relative(root, path)} (a safe repair), apply it, then preview the page again.`,
      { detail: 'slug_rule_mismatch' });
  }
  if (errors.length || parsed.errors?.some(e => e.code === 'MISSING_CLOSE') || parsed.slug !== slug) {
    throw opError('invalid_params', 'Canonical file metadata cannot be parsed losslessly; repair its syntax before previewing.',
      `Nothing changed. Fix the frontmatter of the canonical file of ${slug} in '${sourceId}' (close the --- block, keep its slug), then preview the page again.`);
  }
  const pins = await reconcilePins(engine, { brain_id: brain.brain_id, sourceId, binding, snapshot, slug, assessmentAt, root, path, canonicalPath, rawFileHash: sha256(raw) });
  return { binding, root, path, importPath, raw, snapshot, storedPage, file: reconcileCanonical(parsed, parsed.tags), pins, origin, originSourcePath: derived?.sourcePath ?? null };
}
async function reconcilePins(engine: BrainEngine, input: { brain_id: string; sourceId: string; binding: WorktreeBinding; snapshot: PageSnapshot; slug: string; assessmentAt: string;
  root: string; path: string; canonicalPath: string; rawFileHash: string }): Promise<ReconcilePins> {
  const { binding, snapshot, root, path } = input;
  return { brain_id: input.brain_id, source_id: input.sourceId, source_incarnation: snapshot.sourceIncarnation, slug: input.slug,
    page_id: snapshot.page.id, worktree_id: binding.worktree_id, binding_digest: digest({ binding, root, path: input.canonicalPath }), owner_epoch: String(binding.owner_epoch),
    revision: snapshot.revision, raw_file_hash: input.rawFileHash, relative_path: relative(root, path),
    policy_digest: await reconcilePolicyDigest(engine, input.sourceId), withdrawals_digest: digest({ withdrawals: snapshot.withdrawals, global_purges: snapshot.globalPurges ?? null }), assessment_at: input.assessmentAt };
}
/** #6394: a preview made with --adopt-slug-path recorded a page with no origin; apply and publication adopt the same pinned file. */
export function reconcilePreviewAdopts(artifact: Pick<ReconcileArtifact, 'preimages'>): boolean {
  const stored = (artifact.preimages as { stored_page?: { source_path?: unknown; source_uri?: unknown } | null } | null)?.stored_page;
  return stored != null && stored.source_path == null && recordsNoFileOrigin({ source_uri: typeof stored.source_uri === 'string' ? stored.source_uri : null });
}
export function assertReconcilePins(expected: ReconcilePins, actual: ReconcilePins): void {
  for (const key of Object.keys(expected) as Array<keyof ReconcilePins>) if (expected[key] !== actual[key]) staleReconcile(key);
}
export function validateReconcileArtifact(value: unknown): ReconcileArtifact {
  validateReconcileJson(value);
  const v2 = (value as Record<string, unknown> | null)?.format_version === 2;
  strictReconcileKeys(value, ['format_version', 'preview_id', 'preconditions', 'preimages', 'decisions', 'conflicts', 'result', 'result_digest', 'status',
    ...(v2 ? ['auto_decisions'] : [])], ['format_version', 'preview_id', 'preconditions', 'preimages', 'decisions', 'conflicts', 'result', 'result_digest', 'status',
    ...(v2 ? ['auto_decisions'] : [])]);
  if (v2) {
    if (!Array.isArray(value.auto_decisions) || !value.auto_decisions.length || value.auto_decisions.length > 1000) throw opError('invalid_params', 'Malformed automatic reconciliation decisions.',
      'Re-run the same reconcile preview with --auto-additive to recreate the file instead of editing it by hand.');
    for (const entry of value.auto_decisions as unknown[]) {
      strictReconcileKeys(entry, ['path', 'rule', 'rule_version', 'evidence_digest']);
      if (typeof entry.path !== 'string' || typeof entry.rule !== 'string' || !Number.isSafeInteger(entry.rule_version)
        || typeof entry.evidence_digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.evidence_digest)) {
        throw opError('invalid_params', 'Malformed automatic reconciliation decisions.',
      'Re-run the same reconcile preview with --auto-additive to recreate the file instead of editing it by hand.');
      }
    }
  }
  strictReconcileKeys(value.preconditions, ['brain_id', 'source_id', 'source_incarnation', 'slug', 'page_id', 'worktree_id', 'binding_digest',
    'owner_epoch', 'revision', 'raw_file_hash', 'relative_path', 'policy_digest', 'withdrawals_digest', 'assessment_at']);
  strictReconcileKeys(value.preimages, ['file_base64', 'database', 'stored_page']);
  // globalPurges is optional here so an artifact written before the '*' purge marker validates and then reads stale (assertPreimages).
  strictReconcileKeys(value.preimages.database, ['page', 'tags', 'revision', 'sourceIncarnation', 'withdrawals', 'globalPurges'],
    ['page', 'tags', 'revision', 'sourceIncarnation', 'withdrawals']);
  if (value.preimages.database.globalPurges !== undefined) strictReconcileKeys(value.preimages.database.globalPurges, ['count', 'latest', 'world_only']);
  strictReconcileKeys(value.preimages.database.page, ['id', 'slug', 'source_id', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter',
    'content_hash', 'source_path', 'knowledge_revision', 'text_projection_revision', 'emotional_weight', 'created_at', 'updated_at', 'updated_at_iso',
    'deleted_at', 'effective_date', 'effective_date_source', 'import_filename', 'salience_touched_at', 'source_kind', 'source_uri', 'ingested_via',
    'ingested_at', 'contextual_retrieval_mode', 'corpus_generation', 'withheld_source_path'], ['id', 'slug', 'source_id', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter']);
  strictReconcileKeys(value.preimages.stored_page, ['id', 'source_id', 'slug', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter',
    'content_hash', 'source_path', 'source_kind', 'source_uri', 'ingested_via', 'ingested_at', 'knowledge_revision', 'deleted_at']);
  strictReconcileKeys(value.result, ['type', 'title', 'compiled_truth', 'timeline', 'frontmatter', 'tags']);
  const result = value.result;
  if (value.format_version !== 1 && !v2 || typeof value.preview_id !== 'string' || !['ready', 'needs_resolution'].includes(String(value.status)) ||
    !Array.isArray(value.conflicts) || !Array.isArray(value.decisions) || !Array.isArray(value.preimages.database.tags) ||
    !Array.isArray(value.preimages.database.withdrawals) || !Array.isArray(value.result.tags) || value.result.tags.some(v => typeof v !== 'string') ||
    ['type', 'title', 'compiled_truth', 'timeline'].some(key => typeof result[key] !== 'string') ||
    value.result.frontmatter === null || typeof value.result.frontmatter !== 'object' || Array.isArray(value.result.frontmatter) ||
    typeof value.preimages.file_base64 !== 'string' ||
    digest(value.result) !== value.result_digest || typeof value.preconditions.assessment_at !== 'string' ||
    !Number.isFinite(Date.parse(value.preconditions.assessment_at)) || !Number.isSafeInteger(value.preconditions.page_id) ||
    Object.entries(value.preconditions).some(([key, v]) => key !== 'page_id' && typeof v !== 'string')) {
    throw opError('invalid_params', 'Malformed or modified reconciliation artifact.',
      'Pass the preview file exactly as reconcile wrote it with --out; change it only through --decisions. If it was edited, make a fresh preview.');
  }
  for (const key of ['brain_id', 'source_incarnation', 'worktree_id', 'revision']) requireUuid(value.preconditions[key] as string);
  requireUuid(value.preview_id as string);
  for (const key of ['binding_digest', 'raw_file_hash', 'policy_digest', 'withdrawals_digest']) {
    if (!/^[a-f0-9]{64}$/.test(value.preconditions[key] as string)) {
      throw opError('invalid_params', 'Invalid reconciliation fingerprint.',
        'Pass the preview file exactly as reconcile wrote it with --out; if it was edited, make a fresh preview.');
    }
  }
  for (const conflict of value.conflicts as unknown[]) strictReconcileKeys(conflict, ['path', 'file', 'database']);
  for (const withdrawal of value.preimages.database.withdrawals as unknown[]) strictReconcileKeys(withdrawal, ['visibility', 'fact_hash', 'withdrawn_at', 'purged'], ['visibility', 'fact_hash', 'withdrawn_at']);
  return JSON.parse(stableJson(value)) as ReconcileArtifact;
}

/**
 * #6605: the file side of a reconciliation, read the way the importer stored it. A frontmatter-less file under a
 * directory-inference rule was imported with the frontmatter its path infers, so its raw bytes would show every
 * inferred key as a difference. The inferred reading is used when the stored row carries every key it adds (an
 * inferring import wrote the row); a row imported without inference (`gbrain reindex` on an unmanaged brain) is
 * compared with the raw bytes. An inferred `type:` is not one the file declared: the caller keeps the stored type.
 */
/** GBRA-133: a canonical file's text as `readReconcileState` reads it (the reconcile canonical form of the page it imports). */
export function readCanonicalFileText(state: Pick<ReconcileState, 'importPath' | 'snapshot'>, slug: string, text: string): ParsedPage {
  const reading = reconcileFileReading(text, state.importPath, state.snapshot.page);
  const parsed = parseMarkdown(reading.content, `${slug}.md`, { validate: true, expectedSlug: slug });
  alignWithStored(parsed, state.snapshot.page, reading.inferred);
  return reconcileCanonical(parsed, parsed.tags);
}
export function reconcileFileReading(text: string, sourcePath: string, stored: { frontmatter?: Record<string, unknown> | null }): { content: string; inferred: boolean } {
  const reading = readCanonicalAsImported(text, sourcePath);
  if (!reading.inferred) return reading;
  const keys = Object.keys(parseMarkdown(reading.content, sourcePath).frontmatter);
  return keys.every(key => Object.hasOwn(stored.frontmatter ?? {}, key)) ? reading : { content: text, inferred: false };
}
