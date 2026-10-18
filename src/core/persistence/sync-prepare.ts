import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { sizeStateField } from '../page-embedding-budget.ts';
import { enterClaimStep, type ClaimPhaseClock } from './claim-phase.ts';
import { boundedReads } from './bounded-reads.ts';
import { basename, dirname, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page } from '../types.ts';
import { OperationError, opError, type OpErrorOpts } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import { readFix } from '../ops/op-fix.ts';
import type { RegistryCode } from '../error-registry.ts';
import { ownerGateInput, ownerImportTrust, ownerPageTrust } from '../trust/channel.ts';
import { matchTrustAllowRule, type TrustAllowRule } from '../trust/allow-rules.ts';
import { importFromContent, importCodeFile, verifyPageReadable } from '../import-file.ts';
import { screenImportContent, screenNormalized, type ContentRefusal, type ImportScreenResult, type ImportSanityConfig } from '../import-screen.ts';
import { ContentSanityBlockError } from '../content-sanity.ts';
import { parseMarkdown, resolveParsedSubtype, serializePageToMarkdown, type ParseOpts } from '../markdown.ts';
import { resolveSlugForPath, slugifyPath, isCodeFilePath, isImageFilePath } from '../sync.ts';
import { prepareManagedSyncImage } from './sync-image.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../source-config-sql.ts';
import { sameCanonicalImport } from '../page-state/import-guard.ts';
import { assertPageRevision } from '../page-state/types.ts';
import { sealImportedPage, sealPageTextProjection } from '../page-state/projections.ts';
import { abortSegmentedStaging, materializedSnapshot, sealSegmentedPage } from './segmented-apply.ts';
import { prepareManagedSyncStreamed, type SyncBodyRef } from './sync-streamed.ts';
import { fenceBody, withoutBody } from '../page-body/page-shape.ts';
import { pipelined, transactionMemo } from '../page-state/transactions.ts';
import { prepareCanonicalProjections } from './canonical-projections.ts';
import { withoutSafetyAssessments } from './reconcile-safety.ts';
import { digest, sha256 } from './digest.ts';
import { preserveProtectedTakes } from './protected-takes.ts';
import { getWorktreeBinding } from './ownership.ts';
import { sourceMirrorReadOnly } from './mirror-read-only.ts';
import { assertConfiguredSyncRoot, assertSyncEntryOrigin, readSyncFile, syncGit, syncRawHash, type SyncRename } from './sync-discovery.ts';
import { assertSyncPageOrigin, sameSyncOrigin, syncOriginPath, syncOriginScope, type SyncOriginScope } from './sync-origin.ts';
import { assertManagedSyncActive, validateSyncAuthority, type SyncAuthority, type SyncProcessingOptions } from './sync-authority.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { loadActivePackForEngine, checkApprovedSchemaForEngine } from '../schema-pack/engine-resolution.ts';
import type { CompanyBrainPlan } from '../company-brain/types.ts';
import { companyBrainProfile } from '../company-brain/profile.ts';
import { companyBrainPolicyFingerprint } from '../company-brain/policy.ts';
import { isUnboundSourcePage, UNBOUND_COLLISION_MESSAGE } from './unbound-source.ts';
import { checkpointRetryCommand, findIncompleteSyncReceipt, type SyncSettledIndexes } from './checkpoint-validation.ts';
import { CURSOR_CHANGED_REFUSAL_MESSAGE, SYNC_CURSOR_FENCE_ORIGIN } from './sync-knock-on.ts';
import { checkpointCursorReplaced } from './sync-checkpoint-replaced.ts';
import { recordSyncTail } from './sync-tail-record.ts';
import { frontmatterSlugConflictMessage } from './verb-errors.ts';
import { chunkerStamp } from '../chunkers/code.ts';
import { clearGitHold, countGitHolds, recordSyncImportProvenance, syncDiskProvenance, syncImportParser, syncImportParserFor, type SyncImportProvenanceBase } from './sync-holds.ts';
import { clearSyncSlice, writeSyncSlice, type SyncSliceState } from './sync-slices.ts';
import { CHECKPOINT_MOVED_MESSAGE, emptySyncScope, pinnedSlugModeMismatch, slugModeMismatchCause } from './sync-slug-mode.ts';
import { readPagePurgeTombstones } from './page-purge.ts';
import { fenceWhere } from '../fence-repair/refusal.ts';
import { fencesNormalizeEnabled } from '../fence-repair/config.ts';
import { describeFixes } from '../fence-repair/report.ts';
import { fenceFixesWire } from '../fence-repair/tier1.ts';
import type { FenceFix } from '../fence-repair/types.ts';
import { VERSION } from '../../version.ts';
import { bindOrigin } from './origin-guard.ts';

/** The options that select a managed sync cursor (its key), recorded so a refusal can print the exact retry. */
export interface SyncCursorOptions { full: boolean; workingTree: boolean; srcSubpath: string | null; exclude: string[]; includeHidden: string[]; strategy: string | null }
export interface SyncIntent extends Record<string, unknown> {
  companyApproval?: { schema: NonNullable<CompanyBrainPlan['schema']>; planDigest: string; extractorVersion: string; policyFingerprint: string };
  kind: 'managed_sync_import' | 'managed_sync_delete' | 'managed_sync_checkpoint';
  expected_revision: string | null; sourcePath: string | null; path: string | null;
  rawHash: string | null; content: string | null; ownerEpoch: string;
  /** Wave B: a Markdown file over the single-string ceiling, frozen by reference (`content` is null); the owner streams it. */
  body_ref?: SyncBodyRef;
  lineEndingOnly?: boolean;
  /** #5565: the deleted file is no page's origin; publication only re-proves that and commits a no-op. */
  unownedDeletion?: boolean;
  working?: boolean;
  renameFrom?: SyncRename;
  processingOptions?: SyncProcessingOptions;
  syncOptions?: SyncCursorOptions;
  /** The `--repo` base a relative `--src-subpath` resolved against, for the printed retry. */
  repoPath?: string;
  /** #5522: another cursor of this source imported entries of this run, so the source may already sit at the target. */
  overtaken?: boolean;
  /** #6349 (P4.4) checkpoint only: this run was one path slice of its target; `last_commit` advances only with `done`. */
  slice?: SyncSliceState;
  /** #5988: the run's discovery time; committing this entry clears the path's hold unless a newer run wrote it. */
  holdObservedAt?: string;
  /** #6696: the run that froze this entry deferred embedding at runtime (cost gate); the cursor's `noEmbed` may still be false. */
  embedDeferred?: boolean;
  /** #5988 checkpoint only: held paths that left the source (excluded); their holds clear when the run checkpoints. */
  releasedHolds?: string[];
  /** #5988: the pinned Git blob of the imported content, recorded as import provenance. */
  blobOid?: string;
  /** #5988 checkpoint only: failed content-refusal requests of this run converted in place; they no longer block the checkpoint. */
  supersededRequests?: string[];
  /** #6643 checkpoint only: the indexes the cursor passed without a commit (waived or held), from the index it began recording them. */
  settled?: SyncSettledIndexes;
  syncAuthority: SyncAuthority; cursorKey: string; runId: string; index: number;
  from: string | null; target: string; total: number; slugMode: 'git-root' | 'source-root';
}
/**
 * #5984: the source-wide part of sync validation (managed mode, configured
 * root, cursor, owner epoch) runs once per transaction; a bulk group's
 * members share it. Its rows stay locked FOR SHARE until the transaction ends.
 */
/**
 * #5984: the requests the managed-sync cursor holds: its head (`pending`), the bulk `group` and the groups
 * admitted ahead (`window`). FOR KEY SHARE keeps the cursor row in place without blocking the drain's
 * cursor saves, so the next group is admitted while this one publishes.
 */
export interface SyncCursorFence { run_id: string; request_id: string | null; group: string[] | null; index: string | number | null }
async function readSyncCursorFence(tx: BrainEngine, cursorKey: string): Promise<SyncCursorFence | undefined> {
  const [held] = await tx.executeRaw<SyncCursorFence>(
    `SELECT completed_keys->0->>'runId' AS run_id,completed_keys->0->'pending'->>'requestId' AS request_id,completed_keys->0->>'index' AS index,
      (SELECT jsonb_agg(m->>'requestId') FROM (SELECT m FROM jsonb_array_elements(COALESCE(completed_keys->0->'group','[]'::jsonb)) m
        UNION ALL SELECT m FROM jsonb_array_elements(COALESCE(completed_keys->0->'window','[]'::jsonb)) g, jsonb_array_elements(g) m) members) AS group
     FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1 FOR KEY SHARE`, [cursorKey]);
  return held;
}
const sharedValidations = new WeakMap<object, Map<string, Promise<SyncCursorFence | null>>>();
function sharedSyncValidation(tx: BrainEngine, key: string, run: () => Promise<SyncCursorFence | null>) {
  if ((tx as { _pageTransaction?: boolean })._pageTransaction !== true) return run();
  let byKey = sharedValidations.get(tx);
  if (!byKey) { byKey = new Map(); sharedValidations.set(tx, byKey); }
  let shared = byKey.get(key);
  if (!shared) { shared = run(); byKey.set(key, shared); }
  return shared;
}
/**
 * #5984: the source-wide part of sync validation as one pipeline: coordinator switch, configured root,
 * cursor and owner epoch, each checked in that order. The rows stay locked FOR SHARE. #6712: a page no longer
 * waits on its window predecessor's fate (one page, one fate).
 */
async function sourceSyncChecks(tx: BrainEngine, row: WriteRequest, p: SyncIntent, root: string) {
  const [, , held] = await pipelined(tx, [
    () => assertManagedSyncActive(tx, true),
    async () => {
      const [configuredSource] = await tx.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1 FOR SHARE', [row.source_id]);
      assertConfiguredSyncRoot(root, configuredSource?.local_path ?? null);
    },
    () => readSyncCursorFence(tx, p.cursorKey),
    async () => {
      const current = await getWorktreeBinding(tx, row.source_id);
      if (!current || String(current.owner_epoch) !== p.ownerEpoch) throw syncPublicationRefusal('owner_unavailable', 'The accepted sync owner epoch changed.', row, p,
        `The owner epoch of ${row.source_id} changed after this sync was admitted. Do not claim or transfer the source to repair content.`, true);
    },
  ]) as [unknown, unknown, Awaited<ReturnType<typeof readSyncCursorFence>>];
  return held ?? null;
}
/**
 * Read-only: the receipt itself for the local CLI writer's own request;
 * another principal's request is inspected on the owner instead.
 */
function syncInspectFix(row: WriteRequest, requestId: string, owner: boolean): Action {
  return owner || row.principal_kind !== 'local_cli'
    ? { argv: ['gbrain', 'sources', 'writer', 'status', '--source', row.source_id, '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Shows the source\'s owner, cursor and every pending, failed or recovering receipt without changing anything.' }
    : { argv: ['gbrain', 'write-request', '--', requestId], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'The receipt records whether this sync write published anything; nothing is resubmitted until it is final.' };
}

/**
 * Publishing an accepted managed-sync request was refused. The coordinator
 * keeps only code and message, so the suggestion stands alone: inspect the
 * request, then rerun the exact failed-run command once the cause is fixed.
 */
function syncPublicationRefusal(code: RegistryCode, message: string, row: WriteRequest, p: SyncIntent | null, cause: string, inspectOwner = false, extra: OpErrorOpts = {}): OperationError {
  const fix = syncInspectFix(row, row.request_id, inspectOwner);
  const rerun = checkpointRetryCommand({ sourceId: row.source_id, processingOptions: p?.processingOptions, syncOptions: p?.syncOptions, repoPath: p?.repoPath });
  return opError(code, message, `${cause} Request ${row.request_id} in ${row.source_id} was refused; inspect it first (${fix.argv!.join(' ')}) and do not resubmit it. `
    + `Once it is final and the cause is fixed, run: ${rerun}`, { fix, ...extra });
}

/**
 * #6643: the refusal of a request whose run another run replaced: not a failure of its page. Its next step is the
 * status read, never a retry: the replacing run covers the page.
 */
function supersededRefusal(message: string, row: WriteRequest, cause: string): OperationError {
  const status = ['gbrain', 'sync', 'status', '--source', row.source_id, '--json'];
  return opError('revision_conflict', message,
    `${cause} Request ${row.request_id} in ${row.source_id} published nothing; the run that replaced its cursor covers its page, and ${status.join(' ')} shows that run. Do not resubmit it.`,
    { fix: readFix('Shows the sync cursor, the root cause of this refusal and the next step, read-only.', { argv: status }) });
}

/** #6643: attaches the owner-side classification the coordinator stores as the receipt's `error_detail`. */
function withSyncRefusal(error: OperationError, detail: object): OperationError {
  error.syncRefusal = { ...detail };
  return error;
}

/**
 * #6643: "The accepted sync cursor changed before publication." has two causes, recorded with a fence snapshot
 * (#6712 retired the third, `window_dropped`, with the window cancel that produced it):
 * - `run_replaced`: another run of the source replaced the cursor; this request's run is superseded, not failed.
 * - `outside_fence`: anything else (a duplicate admission, a request ahead of the cursor): a coordination fault, a root.
 */
export function cursorFenceRefusal(row: WriteRequest, p: SyncIntent, cursor: SyncCursorFence): OperationError {
  const cursorIndex = cursor.index == null ? null : Number(cursor.index);
  const cause = cursor.run_id !== p.runId ? 'run_replaced' : 'outside_fence';
  const fence = { run_id: cursor.run_id, expected_run_id: p.runId, request_id: cursor.request_id, members: cursor.group?.length ?? 0, index: cursorIndex, request_index: p.index };
  const error = cause === 'run_replaced'
    ? supersededRefusal(CURSOR_CHANGED_REFUSAL_MESSAGE, row, `Another sync run of ${row.source_id} replaced the cursor this request belongs to.`)
    : syncPublicationRefusal('revision_conflict', CURSOR_CHANGED_REFUSAL_MESSAGE, row, p,
      `Request ${row.request_id} is not the entry the cursor of ${row.source_id} holds (cursor at index ${cursorIndex ?? 'unknown'}, request ${cursor.request_id ?? 'none'}), so it must not publish.`);
  return withSyncRefusal(error, { origin: SYNC_CURSOR_FENCE_ORIGIN, cause, fence });
}

/**
 * #5988: a deterministic content refusal at publication. The wire `error`
 * stays `invalid_params` (what older receipts stored), so the stored code and
 * message keep matching `isContentRefusal`; `code` is the typed one.
 */
/** `legacy`: the wire `error` stays `invalid_params` for refusals older clients knew by it; a streamed (Wave B) refusal keeps its own code, which the run holds by. */
function syncContentRefusal(refusal: ContentRefusal, row: WriteRequest, p: SyncIntent, legacy = true): OperationError {
  const where = refusal.line !== undefined ? `line ${refusal.line}${refusal.key ? ` (key "${refusal.key}")` : ''} of ${p.sourcePath}` : p.sourcePath;
  const cause = refusal.code === 'invalid_fence' ? `Edit ${fenceWhere(refusal.fence)} in ${p.sourcePath} as the message says and commit the change${p.companyApproval ? ' to the repository (a company-brain source never rewrites repository files and never holds a file)' : ''}.`
    : refusal.code === 'frontmatter_slug_conflict' ? 'Correct the frontmatter `slug:` in the file and commit the change.'
    : refusal.code === 'file_too_large' ? `${p.sourcePath} is over the page size limit; add it to sync.exclude, or split it into files under the limit and commit.`
    : refusal.code === 'content_rejected' ? `The content-sanity gate rejects ${p.sourcePath} under junk_disposition=reject; remove the matched junk and commit.`
    : refusal.code === 'purged_content' ? `${p.sourcePath} still carries purged content; delete or edit the file and commit, or the owner clears the tombstone with gbrain pages unpurge.`
    : refusal.code === 'write_gate_rejected' ? `The write gate refuses ${p.sourcePath}: external instruction-like content under write_gate.external_mode=reject. Tell the user; changing that setting or the file is their decision.`
    : `Fix ${where} (one line per key, the whole value quoted) and commit the change; gbrain repair frontmatter --source ${row.source_id} previews the exact line fix and writes it only after the preview hash is approved.`;
  const error = syncPublicationRefusal(refusal.code, refusal.message, row, p, cause, false, {
    ...(!legacy || refusal.code === 'content_rejected' || refusal.code === 'write_gate_rejected' ? {} : { legacy_error: 'invalid_params' }),
    ...(refusal.reason ? { reason: refusal.reason } : {}),
    ...(refusal.key || refusal.line !== undefined ? { detail: [refusal.key ? `key ${refusal.key}` : '', refusal.line !== undefined ? `line ${refusal.line}` : ''].filter(Boolean).join(', ') } : {}),
  });
  if (refusal.fence) error.fence = { ...refusal.fence };
  if (refusal.fence_issues?.length) error.fenceIssues = refusal.fence_issues.map(issue => ({ ...issue }));
  return error;
}

type Snapshot = Awaited<ReturnType<BrainEngine['readPageSnapshot']>>;
export interface SyncImportScreenInput {
  content: string; rawHash: string | null; lineEndingOnly: boolean; slug: string; sourcePath: string; path: string; root: string;
  /** The page at the entry's slug, and the page the import is prepared against (the rename source for a renamed page). */
  snapshot: Snapshot; base: Snapshot; renamed: boolean;
  activePack?: ParseOpts['activePack']; companyApproval?: boolean; sanity?: ImportSanityConfig;
  /** #6188: `fences.normalize`; false holds a fixable fence like any other. Default true. */
  normalize?: boolean;
  /** #5575: page purge tombstones of the source; a matching file is held as `purged_content`. */
  purgedPages?: ReadonlyMap<string, string>;
  /**
   * #6712 PR 2: the source's config and trust allow rules. With them the screen applies the write gate as preparation
   * does (the tier is the source default lowered by the file's trust markers; an owner allow rule for the source and the
   * file's path admits it), so a file `write_gate.external_mode=reject` refuses is held as `write_gate_rejected` instead
   * of failing its receipt and blocking the run.
   */
  writeGateSource?: { sourceId: string; config: Record<string, unknown> | null; allowRules: readonly TrustAllowRule[] };
}

/**
 * #5988: the one content screen a managed sync Markdown import gets, shared by
 * the freeze-time hold screen and publication, so a file is held exactly when
 * publication would refuse it. The already-published working-tree exemption
 * runs before any content refusal. #6188: fences are screened `coordinated`,
 * so a fence the canonical projection refuses is held, not admitted.
 */
export function screenSyncImport(input: SyncImportScreenInput): { screen: ImportScreenResult; parsedInput: ReturnType<typeof parseMarkdown>; newerWorkingTree: boolean } {
  const { content, slug, sourcePath, snapshot, base, activePack } = input;
  if (isCodeFilePath(sourcePath)) return { screen: screenImportContent({ content, path: sourcePath }), parsedInput: parseMarkdown('', `${slug}.md`), newerWorkingTree: false };
  // row.slug is already resolved; parseMarkdown expects a filename, as in importFromContent.
  const parsedInput = parseMarkdown(content, `${slug}.md`, { activePack });
  resolveParsedSubtype(parsedInput, base?.page);
  // The pinned commit can simply trail the coordinator: a committed page write reaches the
  // working tree before its Git effect lands. When the newer working-tree bytes are the
  // current page itself, there is nothing to import and nothing to protect; the commit that
  // carries them is imported as a no-op by a later run. This is checked before any content
  // refusal, so a file already repaired and published is never refused for its pinned bytes.
  // The checkpoint may advance past the pinned commit's bytes because the working tree wins, as for any local edit.
  const newerWorkingTree = !input.companyApproval && !!base && !input.lineEndingOnly && input.rawHash !== sha256(content) && !sameCanonicalImport(base, parsedInput);
  const gateSource = input.writeGateSource;
  const gateTrust = gateSource ? ownerPageTrust({ frontmatter: parsedInput.frontmatter, sourceConfig: gateSource.config, channel: 'managed_sync_import', sourceUri: sourcePath }) : null;
  const screen = screenImportContent({ content, path: `${slug}.md`, activePack, expectedSlug: resolveSlugForPath(sourcePath), fences: 'coordinated',
    ...(input.normalize === false ? { normalize: false } : {}),
    slugExempt: declared => snapshot?.page.source_path != null && syncOriginPath(snapshot.page.source_path) === syncOriginPath(sourcePath) && declared === snapshot.page.slug,
    slugConflictMessage: (found, expected) => frontmatterSlugConflictMessage(sourcePath, found, expected),
    ...(input.sanity ? { sanity: input.sanity } : {}),
    ...(input.purgedPages ? { purgedPages: input.purgedPages } : {}),
    ...(gateSource ? { writeGate: { tier: gateTrust!.tier, origin: { channel: gateTrust!.origin?.channel ?? null, source_uri: gateTrust!.origin?.source_uri ?? null } },
      gateAllowed: gate => !gate.detectorError
        && !!matchTrustAllowRule(gateSource.allowRules, { sourceId: gateSource.sourceId, sourceUri: gateTrust!.origin?.source_uri ?? null, families: gate.families as never }) } : {}),
    ...(newerWorkingTree ? { published: () => {
      const working = input.renamed ? null : readSyncFile(input.root, input.path);
      return !!working && sha256(working) === input.rawHash && sameCanonicalImport(base!, parseMarkdown(working.toString('utf8'), `${slug}.md`, { activePack }));
    } } : {}) });
  return { screen, parsedInput, newerWorkingTree };
}

/** #6188: the prepare screen with `fences.normalize` settled; the switch is read only for a file Tier 1 would rewrite. */
async function settledSyncScreen(engine: BrainEngine, input: SyncImportScreenInput): Promise<ReturnType<typeof screenSyncImport>> {
  const screened = screenSyncImport(input);
  return screenNormalized(screened.screen) && !await fencesNormalizeEnabled(engine) ? screenSyncImport({ ...input, normalize: false }) : screened;
}

/** UC3: a company-brain source never rewrites repository files; a fence Tier 1 would normalize is named by location. */
function companyWritebackRefusal(row: WriteRequest, p: SyncIntent, fenceFixes: readonly FenceFix[]): OperationError {
  const message = fenceFixes.length ? `Canonical preparation would normalize a facts or takes fence (${describeFixes(fenceFixes)}); this profile never writes repository files.`
    : 'Canonical preparation requires a source-content correction; this profile never writes repository files.';
  return syncPublicationRefusal('source_writeback_required', message, row, p,
    fenceFixes.length ? `${p.sourcePath} has a facts or takes fence gbrain would normalize (${describeFixes(fenceFixes)}), and a company-brain source never rewrites repository files; fix the fence in the repository and commit.`
      : `The file of ${row.slug} needs a canonical correction, and a company-brain source never rewrites repository files; correct it in the repository and commit.`);
}

/**
 * The checkout's Git top level for one sync run's requests: `git rev-parse --show-toplevel` once per root and run,
 * read again whenever the top level's `.git` entry is replaced or removed or a `.git` appears between it and the root,
 * the changes that move the top level of a checkout.
 */
const gitTopLevels = new Map<string, { gitRoot: string; dotGit: string }>();
function dotGitIdentity(root: string, gitRoot: string): string | null {
  for (let dir = root; dir !== gitRoot; dir = dirname(dir)) if (dir === dirname(dir) || existsSync(join(dir, '.git'))) return null;
  try { const stat = lstatSync(join(gitRoot, '.git')); return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; } catch { return null; }
}
export function syncGitTopLevel(root: string, runId: string): string {
  const key = `${root}\0${runId}`, known = gitTopLevels.get(key);
  if (known && dotGitIdentity(root, known.gitRoot) === known.dotGit) return known.gitRoot;
  const gitRoot = realpathSync(syncGit(root, ['rev-parse', '--show-toplevel']).trim());
  const dotGit = dotGitIdentity(root, gitRoot);
  if (gitTopLevels.size >= 64) gitTopLevels.clear();
  if (dotGit === null) gitTopLevels.delete(key); else gitTopLevels.set(key, { gitRoot, dotGit });
  return gitRoot;
}

/**
 * The entry's recorded origin, checked against the checkout (`git rev-parse`, the entry's path under the root) and the
 * accepted page (its origin, and the rename source's); a checkpoint has none. `clock` names the steps (#6278).
 */
async function resolveSyncOrigin(engine: BrainEngine, row: WriteRequest, p: SyncIntent, root: string, originPageId: number | null, clock: ClaimPhaseClock | undefined):
  Promise<{ origin?: Parameters<typeof assertSyncEntryOrigin>[1]; originContext?: Parameters<typeof assertSyncEntryOrigin>[0]; originScope?: SyncOriginScope }> {
  if (p.kind === 'managed_sync_checkpoint') return {};
  if (typeof p.path !== 'string' || typeof p.sourcePath !== 'string') throw syncPublicationRefusal('storage_error', 'The accepted sync origin is missing.', row, p,
    'The stored intent has no recorded file path for this page.');
  let working = p.working;
  if (p.kind === 'managed_sync_delete' && working === undefined) {
    enterClaimStep(clock, 'manifest_entry', undefined, 'db');
    const [manifest] = await engine.executeRaw<{ entry: { path: string; sourcePath: string; action: string; working: boolean; pageId?: number | null } }>(
      "SELECT completed_keys->$2::integer AS entry FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [p.runId, p.index]);
    const entry = manifest?.entry;
    if (!entry || entry.path !== p.path || entry.sourcePath !== p.sourcePath || entry.action !== 'delete' ||
        typeof entry.working !== 'boolean' || (entry.pageId ?? null) !== row.page_id) {
      throw new OperationError('page_identity_changed', 'The legacy deletion has no matching immutable origin manifest.',
        'Inspect the source identity and explicitly retry failed sync discovery; the accepted request has not been rewritten.');
    }
    working = entry.working;
  }
  const origin = { path: p.path, sourcePath: p.sourcePath, action: p.kind === 'managed_sync_delete' ? 'delete' as const : 'import' as const, working };
  enterClaimStep(clock, 'git_rev_parse', undefined, 'git');
  const originContext = { root, gitRoot: syncGitTopLevel(root, p.runId), target: p.target, slugMode: p.slugMode };
  assertSyncEntryOrigin(originContext, origin);
  const originScope = syncOriginScope({ ...originContext, sourceId: row.source_id });
  enterClaimStep(clock, 'origin_check', undefined, 'db');
  await assertSyncPageOrigin(engine, row.source_id, p.sourcePath, originPageId, p.kind === 'managed_sync_delete', originScope);
  if (p.renameFrom) await assertSyncPageOrigin(engine, row.source_id, p.renameFrom.sourcePath, p.renameFrom.pageId, true, originScope);
  return { origin, originContext, originScope };
}

/**
 * `clock` (#6278): the claim's phase clock. Each await boundary below names its step and what it waits on
 * (`enterClaimStep`), which also throws the preparation's abort reason once its budget cut it off. No
 * statement here takes the member's signal: the reads a group memoizes (preparationReads) must stay shared,
 * and the step boundaries are where cancellation lands. The preparation's raw reads run through
 * `boundedReads`: a relation lock held elsewhere ends the statement on the server at the budget (plan 1.4),
 * so the member is released without a zombie statement pinning a connection until the ceiling.
 */
/**
 * `screening.unsaved`: a waiver screen of a frozen entry the cursor does not yet name (a waiver run's head and followers).
 * Its validation also accepts this run's cursor with nothing pending; the waiver transaction then requires exactly that
 * cursor (run, index, nothing pending) under its lock.
 */
/**
 * #6349 (P4.4): a slice short of its target's end leaves `last_commit` where it was (the caller binds `from` back) and
 * records where the next slice starts, in the checkpoint's transaction; the last slice clears the record.
 */
async function recordSliceCursor(tx: BrainEngine, row: WriteRequest, p: { syncOptions?: SyncCursorOptions; slice?: SyncSliceState }, settled: boolean): Promise<void> {
  if (!p.syncOptions) return;
  if (settled) await clearSyncSlice(tx, row.source_id, row.source_incarnation, p.syncOptions);
  else await writeSyncSlice(tx, row.source_id, row.source_incarnation, p.syncOptions, p.slice!);
}

/** The code-file branch of `prepareManagedSyncMutation`: `importCodeFile` with `prepare`, text embedding deferred to `embed --stale` (the image branch is `sync-image.ts`). */
async function prepareManagedSyncCode(engine: BrainEngine, row: WriteRequest, p: { content: string; sourcePath: string; rawHash: string | null; lineEndingOnly?: boolean; companyApproval: boolean },
  ctx: { snapshot: Snapshot | null; validate: (tx: BrainEngine) => Promise<void>; releaseHold: (tx: BrainEngine) => Promise<void>; recordProvenance: (tx: BrainEngine) => Promise<void>; clock?: ClaimPhaseClock;
    refuse: (code: RegistryCode, message: string, cause: string) => OperationError; contentRefusal: (refusal: ContentRefusal) => OperationError }): Promise<PreparedMutation> {
  const { snapshot, validate, releaseHold, clock, refuse } = ctx;
  if (p.companyApproval) throw refuse('profile_incompatible', 'Company source approval permits only committed Markdown content.',
    `A company-brain source imports only committed Markdown, and ${row.slug} is a code file; remove it from the approved revision.`);
  if (snapshot && !p.lineEndingOnly && p.rawHash !== sha256(p.content) && snapshot.page.compiled_truth !== p.content) {
    throw refuse('source_changed', 'Newer code file bytes disagree with the pinned import.',
      `The working tree holds newer bytes for ${row.slug} than the pinned import; sync did not overwrite them. Preserve the local edit and commit it.`);
  }
  const codeScreen = screenImportContent({ content: p.content, path: p.sourcePath });
  if (codeScreen.status === 'refused') throw ctx.contentRefusal(codeScreen.refusal);
  let prepared: PreparedContentImport | undefined;
  enterClaimStep(clock, 'code_import', undefined, 'db');
  const result = await importCodeFile(engine, p.sourcePath, p.content, { sourceId: row.source_id, noEmbed: true,
    prepare: async value => { prepared = value; return value.result; } });
  if (!prepared || prepared.slug !== row.slug) throw refuse('invalid_params', result.error ?? 'The code file identity could not be prepared.',
    `The code file could not be prepared as page ${row.slug}.`);
  const ready = prepared;
  if (ready.observedRevision !== (snapshot?.revision ?? null)) throw refuse('revision_conflict', 'The code page changed during preparation.',
    `Page ${row.slug} changed while this sync was being prepared.`);
  return { observedRevision: ready.observedRevision, trust: await ownerImportTrust(engine, row, null, p.sourcePath),
    validate: async tx => { await validate(tx); await ready.validate(tx); },
    noop: ready.noop, deferEmbedding: true, apply: async tx => {
    await ready.apply(tx);
    await releaseHold(tx);
    await ctx.recordProvenance(tx);
    return { status: ready.noop ? 'skipped' : snapshot ? 'updated' : 'created', slug: row.slug, source_id: row.source_id,
      chunks: result.chunks, noop: ready.noop, imported_file: true };
  } };
}

/**
 * #6712 PR 1: the import provenance a code or image publication records in its transaction, as a Markdown import records
 * its own: the page's revision after the write, the bytes on disk (the file: neither writes one back) and the parser.
 */
function syncFileProvenance(row: WriteRequest, p: SyncIntent, root: string, rawSha256: string): (tx: BrainEngine) => Promise<void> {
  return async tx => {
    const final = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
    if (!final || final.page.deleted_at != null) return;
    await recordSyncImportProvenance(tx, { source_id: row.source_id, incarnation: row.source_incarnation, page_id: Number(final.page.id), origin: p.sourcePath!,
      raw_sha256: rawSha256, ...(p.blobOid ? { blob_oid: p.blobOid } : {}), working: p.working === true, gbrain_version: VERSION, revision: final.revision,
      parser: syncImportParserFor(p.sourcePath!, null), ...syncDiskProvenance(syncDiskBytes(root, p.path!, p.content!, p.rawHash), p.target) });
  };
}

/**
 * The no-op of an entry whose newer working-tree bytes are the current page (`published`): it records, as its import
 * provenance, those working-tree bytes at the page's current revision (#6712 PR 1), so the commit that later carries
 * them is prescreened; the pinned bytes it did not import are not recorded.
 */
function publishedSyncNoop(row: WriteRequest, p: SyncIntent, root: string, snapshot: Snapshot | null, schemaPack: string | null,
  validate: (tx: BrainEngine) => Promise<void>, releaseHold: (tx: BrainEngine) => Promise<void>): SyncPreparedMutation {
  const importProvenance: SyncImportProvenanceBase = { source_id: row.source_id, incarnation: row.source_incarnation, origin: p.sourcePath!, raw_sha256: p.rawHash!,
    working: true, gbrain_version: VERSION, parser: syncImportParser(schemaPack) };
  return { observedRevision: snapshot?.revision ?? null, noop: true, contentUnchanged: true, validate, importProvenance,
    apply: async tx => {
      await releaseHold(tx);
      const current = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
      if (current && current.page.deleted_at == null && current.revision === snapshot?.revision) {
        await recordSyncImportProvenance(tx, { ...importProvenance, page_id: Number(current.page.id), revision: current.revision, ...syncDiskProvenance(readSyncFile(root, p.path!), p.target) });
      }
      return { status: 'skipped', slug: row.slug, source_id: row.source_id, chunks: 0, noop: true, imported_file: true };
    } };
}

/** The bytes on disk of an import that writes no file back: its frozen content when that is the file (raw hash), else the file read now (null: absent). */
export function syncDiskBytes(root: string, path: string, content: string, rawHash: string | null): Uint8Array | null {
  return rawHash !== null && rawHash === sha256(content) ? Buffer.from(content) : readSyncFile(root, path);
}

/** The checkpoint request's publication: the whole run committed, so `last_commit` (and the slug-root pin) advance under the guard. */
async function applyManagedSyncCheckpoint(tx: BrainEngine, row: WriteRequest, p: SyncIntent, root: string, releaseHold: (tx: BrainEngine, path: string | null) => Promise<void>): Promise<Record<string, unknown>> {
  const [cursor] = await tx.executeRaw<{ completed_keys: [{ runId: string; index: number; total: number }] }>(
    "SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1 FOR UPDATE", [p.cursorKey]);
  // #6513: validation passed under this run; a replacement that landed since is the same supersession, not an index lag.
  const replaced = checkpointCursorReplaced(p, cursor?.completed_keys[0]?.runId, row.source_id);
  if (replaced) throw syncPublicationRefusal(replaced.code, replaced.message, row, p, replaced.cause);
  if (!cursor || cursor.completed_keys[0].runId !== p.runId || cursor.completed_keys[0].index !== p.total || cursor.completed_keys[0].total !== p.total) {
    throw syncPublicationRefusal('revision_conflict', 'The sync cursor is not fully committed.', row, p,
      `Not every page write of this sync run has committed, so the checkpoint of ${row.source_id} did not advance.`);
  }
  const [manifest] = await tx.executeRaw<{ count: number }>("SELECT jsonb_array_length(completed_keys) AS count FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [p.runId]);
  if (!manifest || Number(manifest.count) !== p.total) throw syncPublicationRefusal('storage_error', 'The immutable sync manifest is incomplete.', row, p,
    `The immutable manifest of this sync run is incomplete, so the checkpoint of ${row.source_id} did not advance.`);
  const incomplete = await findIncompleteSyncReceipt(tx, row.worktree_id!, p.runId, p.supersededRequests ?? [], p.settled ?? null);
  if (incomplete) throw opError('recovery_required', `An incomplete page receipt (request ${incomplete}) still blocks the sync checkpoint.`,
    `Page request ${incomplete} of this sync run is still open or needs recovery, so checkpoint request ${row.request_id} of ${row.source_id} did not commit. `
      + `Inspect request ${incomplete} and let it finish; do not resubmit it. Then run: ${checkpointRetryCommand({ sourceId: row.source_id, processingOptions: p.processingOptions, syncOptions: p.syncOptions, repoPath: p.repoPath })}`,
    { fix: syncInspectFix(row, incomplete, false) });
  const settled = !p.slice || p.slice.done;
  // #5522: an overtaken run accepts a source another cursor already checkpointed at this exact target.
  // #6694: at the repository root both slug modes give the same slugs, so the checkpoint keeps whichever mode the source pins.
  const emptyScope = emptySyncScope(root, syncGitTopLevel(root, p.runId));
  const changed = await tx.executeRaw(`UPDATE sources SET last_commit=$3,last_sync_at=now(),
    config=jsonb_set(${SOURCE_CONFIG_OBJECT_SQL},'{slug_root_mode}',to_jsonb(CASE WHEN $7::boolean THEN COALESCE(config->>'slug_root_mode',$5::text) ELSE $5::text END)),
    newest_content_at=(SELECT MAX(updated_at) FROM pages WHERE source_id=$1 AND deleted_at IS NULL)
    WHERE id=$1 AND incarnation=$2::uuid AND (last_commit IS NOT DISTINCT FROM $4 OR ($6::boolean AND last_commit=$3))
    AND ($7::boolean OR config->>'slug_root_mode' IS NULL OR config->>'slug_root_mode'=$5) RETURNING id`,
  [row.source_id, row.source_incarnation, settled ? p.target : p.from, p.from, p.slugMode, p.overtaken === true, emptyScope]);
  const pinned = !changed.length && !emptyScope ? await pinnedSlugModeMismatch(tx, row.source_id, row.source_incarnation, p.slugMode) : null;
  if (pinned) throw syncPublicationRefusal('slug_root_mode_mismatch', `The source pins slug_root_mode=${pinned}, but this sync ran under ${p.slugMode}.`, row, p, slugModeMismatchCause(row.source_id, pinned, p.slugMode));
  if (!changed.length) throw syncPublicationRefusal('revision_conflict', CHECKPOINT_MOVED_MESSAGE, row, p,
    `Another sync moved the commit checkpoint of ${row.source_id} while this run published.`);
  await recordSliceCursor(tx, row, p, settled);
  // #5566: a full walk re-chunked every stale page, so acknowledge the chunker version as the legacy gate does.
  if (settled && (p.from === null || p.syncOptions?.full === true)) await tx.executeRaw('UPDATE sources SET chunker_version=$2 WHERE id=$1', [row.source_id, chunkerStamp()]);
  await tx.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,done}','true'::jsonb),updated_at=now() WHERE op='managed-sync' AND fingerprint=$1", [p.cursorKey]);
  // #6712 PR 2 (L5): the tail (statistics, links) runs after the lease is released; it is owed from this commit on.
  await recordSyncTail(tx, row.source_id, p.cursorKey, p.runId);
  for (const path of p.releasedHolds ?? []) await releaseHold(tx, path);
  return { status: 'synced', source_id: row.source_id, committed_pages: p.total };
}

/**
 * Whether the import must rewrite its file with `canonicalFile` (its sanitized form). Working-tree bytes that are the
 * pinned bytes (or differ only by line endings) take the write; bytes that already are the canonical file need none
 * (#6513: gbrain's own writeback, published before the request that carried it settled); any other newer bytes are
 * refused, and the run holds the file `worktree_dirty` (sync-page-fault.ts `pinnedWorktreeConflict`).
 */
function canonicalWritebackNeeded(row: WriteRequest, p: SyncIntent, pinned: string, canonicalFile: string | null): canonicalFile is string {
  if (canonicalFile === null) return false;
  if (p.lineEndingOnly || p.rawHash === sha256(pinned)) return true;
  if (p.rawHash === sha256(canonicalFile)) return false;
  throw syncPublicationRefusal('source_changed', 'Canonical sanitization cannot overwrite newer working-tree bytes.', row, p,
    `The canonical correction for ${row.slug} would overwrite newer working-tree bytes; preserve the local edit and commit it.`);
}

/** A managed-sync preparation; a Markdown import also carries the provenance its publication records, which a no-op waiver records instead. */
export type SyncPreparedMutation = PreparedMutation & { importProvenance?: SyncImportProvenanceBase;
  /** The import leaves the page as it is (only a canonical writeback of the file may remain); #6712 drift baseline check in sync-run.ts. */
  pageUnchanged?: boolean };

export async function prepareManagedSyncMutation(unbounded: BrainEngine, row: WriteRequest, _config: GBrainConfig, clock?: ClaimPhaseClock,
  screening?: { unsaved: true }): Promise<SyncPreparedMutation> {
  const engine = boundedReads(unbounded, clock);
  const p = row.intent as SyncIntent | null;
  if (!p || !['managed_sync_import', 'managed_sync_delete', 'managed_sync_checkpoint'].includes(p.kind)) throw syncPublicationRefusal('invalid_params', 'Unsupported internal sync intent.', row, p,
    'The request does not carry a managed sync intent this release can publish.');
  if (p.unownedDeletion && p.kind !== 'managed_sync_delete') throw syncPublicationRefusal('invalid_params', 'Only a deletion can record an unowned path.', row, p,
    'Its intent records an unowned path on something other than a deletion.');
  const originPageId = p.unownedDeletion ? null : row.page_id;
  const releaseHold = async (tx: BrainEngine, path: string | null = p.path) => {
    if (!p.holdObservedAt || path === null) return;
    // #5984: a source without holds (one summary read per transaction) has none to clear.
    if (await transactionMemo(tx, `git-holds:${row.source_id}:${row.source_incarnation}`, () => countGitHolds(tx, row.source_id, row.source_incarnation)) === 0) return;
    await clearGitHold(tx, { sourceId: row.source_id, incarnation: row.source_incarnation, path, observedAt: p.holdObservedAt });
  };
  enterClaimStep(clock, 'managed_sync_active', undefined, 'db');
  await assertManagedSyncActive(engine);
  if (p.kind !== 'managed_sync_delete' && (!p.processingOptions ||
      ['noEmbed', 'noExtract', 'noSchemaPack'].some(key => typeof p.processingOptions?.[key as keyof SyncProcessingOptions] !== 'boolean'))) {
    throw new OperationError('invalid_params', 'The legacy sync request has no durable processing options.',
      'Inspect this unchanged request, then rerun the sync with explicit sync options: it retries the recorded failure by rediscovering. Unknown embedding and schema consent cannot be inferred from a retry.');
  }
  enterClaimStep(clock, 'authority', undefined, 'db');
  await validateSyncAuthority(engine, p.syncAuthority, row.slug);
  enterClaimStep(clock, 'worktree_binding', undefined, 'db');
  const binding = await getWorktreeBinding(engine, row.source_id);
  if (!binding?.local_path || String(binding.owner_epoch) !== p.ownerEpoch) throw syncPublicationRefusal('owner_unavailable', 'The accepted sync owner changed.', row, p,
    `The canonical owner of ${row.source_id} changed, or lost its local path, after this sync was admitted. Do not claim or transfer the source to repair content.`, true);
  const root = join(binding.local_path, binding.relative_path);
  enterClaimStep(clock, 'configured_root', undefined, 'db');
  const [configuredSource] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [row.source_id]);
  assertConfiguredSyncRoot(root, configuredSource?.local_path ?? null);
  if (p.kind !== 'managed_sync_checkpoint') {
    enterClaimStep(clock, 'knowledge_publication', undefined, 'db');
    await assertKnowledgePublicationAllowed(engine, row, p.path === null ? undefined : { root, path: join(root, p.path) });
  }
  const { origin, originContext, originScope } = await resolveSyncOrigin(engine, row, p, root, originPageId, clock);
  const moved = p.kind === 'managed_sync_import' ? p.renameFrom : undefined;
  const assertRenameSource = async (tx: BrainEngine) => {
    if (!moved || moved.slug === row.slug) return;
    const previous = await tx.readPageSnapshot(moved.slug, { sourceId: row.source_id, includeDeleted: true });
    if (previous?.page.id !== moved.pageId || previous.revision !== moved.revision || previous.page.deleted_at != null) {
      throw syncPublicationRefusal('revision_conflict', 'The renamed page changed after sync admission.', row, p,
        `Page ${moved.slug}, which this file was renamed from, changed or was deleted after the sync was admitted.`);
    }
  };
  // #5984: validation's reads are pipelined; each check runs in the order it always did, so the first failing one is reported.
  const validate = async (tx: BrainEngine) => {
    const shared = sharedSyncValidation(tx, `${row.source_id}\0${p.cursorKey}\0${p.ownerEpoch}\0${root}`, () => sourceSyncChecks(tx, row, p, root));
    await pipelined(tx, [
      () => shared,
      () => validateSyncAuthority(tx, p.syncAuthority, row.slug),
      async () => {
        const cursor = await shared;
        // #6513: a checkpoint whose cursor another run replaced is superseded, not conflicted; a page keeps `revision_conflict`.
        const replaced = checkpointCursorReplaced(p, cursor?.run_id, row.source_id);
        if (replaced) throw syncPublicationRefusal(replaced.code, replaced.message, row, p, replaced.cause);
        if (cursor && (cursor.run_id !== p.runId || (cursor.request_id !== row.request_id && !cursor.group?.includes(row.request_id) && !(screening?.unsaved && cursor.request_id == null)))) {
          throw cursorFenceRefusal(row, p, cursor);
        }
      },
      async () => { if (p.kind !== 'managed_sync_checkpoint') await assertKnowledgePublicationAllowed(tx, row, p.path === null ? undefined : { root, path: join(root, p.path) }); },
      async () => {
        if (p.path !== null && !p.body_ref && syncRawHash(root, p.path) !== p.rawHash) throw syncPublicationRefusal('source_changed', 'The imported file changed after sync admission.', row, p,
          `The file of ${row.slug} changed on disk after this sync was admitted; review the change and commit it.`);
      },
      async () => {
        if (!origin || !originContext) return;
        assertSyncEntryOrigin(originContext, origin);
        await assertSyncPageOrigin(tx, row.source_id, origin.sourcePath, originPageId, p.kind === 'managed_sync_delete', originScope);
      },
      async () => { if (origin && originContext && moved) await assertSyncPageOrigin(tx, row.source_id, moved.sourcePath, moved.pageId, true, originScope); },
      async () => { if (origin && originContext) await assertRenameSource(tx); },
    ]);
    if (p.companyApproval) {
      const [source] = await tx.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [row.source_id]);
      const policy = companyBrainProfile(source?.config);
      if (!policy || policy.planDigest !== p.companyApproval.planDigest || policy.extractorVersion !== p.companyApproval.extractorVersion || policy.approvedRevision !== p.target ||
        companyBrainPolicyFingerprint(policy, row.source_id) !== p.companyApproval.policyFingerprint) {
        throw syncPublicationRefusal('source_changed', 'The company source approval changed.', row, p,
          `The approved company-brain plan of ${row.source_id} changed after this sync was admitted, so the run needs the current approval.`);
      }
      const schema = p.companyApproval.schema;
      await checkApprovedSchemaForEngine(tx, { name: schema.name, identity: schema.identity, resolvedManifestHash: schema.resolved_digest }, { remote: false, sourceId: row.source_id });
    }
  };
  if (p.kind === 'managed_sync_checkpoint') return { sourceExclusive: true, observedRevision: null, validate, apply: tx => applyManagedSyncCheckpoint(tx, row, p, root, releaseHold) };
  const source = { sourceId: row.source_id };
  enterClaimStep(clock, 'page_snapshot', undefined, 'db');
  const read = await engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
  const snapshot = p.body_ref ? read : await materializedSnapshot(engine, read);
  assertPageRevision(snapshot, { expectedRevision: p.expected_revision }); // null asserts the admitted-absent page is still absent (#5385)
  const recordedOrigin = moved?.slug === row.slug ? moved.sourcePath : p.sourcePath!;
  const foreignOrigin = snapshot?.page.source_path != null && !sameSyncOrigin(snapshot.page.source_path, recordedOrigin, originScope, snapshot.page.slug);
  if ((snapshot?.page.id ?? null) !== row.page_id || (p.unownedDeletion ? !foreignOrigin : foreignOrigin)) {
    throw syncPublicationRefusal('page_identity_changed', 'The imported path no longer names the accepted page.', row, p,
      `Page ${row.slug} was recreated, or its recorded origin moved, after this sync was admitted.`);
  }
  if (p.unownedDeletion) return { observedRevision: snapshot!.revision, noop: true, validate,
    apply: async tx => { await releaseHold(tx); return { status: 'skipped', slug: row.slug, source_id: row.source_id, noop: true, reason: 'unowned_deleted_path' }; } };
  enterClaimStep(clock, 'unbound_source_check', undefined, 'db');
  if (snapshot && snapshot.page.source_path == null && await isUnboundSourcePage(engine, row.source_id, row.slug)) {
    throw syncPublicationRefusal('source_changed', UNBOUND_COLLISION_MESSAGE, row, p,
      `A canonical file now occupies the path of page ${row.slug}, written while ${row.source_id} was unbound; neither copy was overwritten. Rename or remove the file and commit, or copy what you need into the page first.`);
  }
  if (p.kind === 'managed_sync_delete') return { observedRevision: snapshot?.revision ?? null, noop: !snapshot || snapshot.page.deleted_at != null,
    trust: await ownerImportTrust(engine, row, snapshot?.page.frontmatter, p.sourcePath), validate, apply: async (tx, preimage) => {
      if (snapshot && snapshot.page.deleted_at == null) { await tx.createVersion(row.slug, preimage ? { ...source, preimage } : source); await tx.softDeletePage(row.slug, source); }
      await releaseHold(tx);
      return { status: 'soft_deleted', slug: row.slug, source_id: row.source_id, noop: !snapshot || snapshot.page.deleted_at != null };
    } };
  // Wave B: a Markdown file over the single-string ceiling (never a company-brain or image entry) streams; its body is never read here.
  if (p.body_ref && typeof p.sourcePath === 'string' && typeof p.path === 'string') {
    enterClaimStep(clock, 'schema_pack', undefined, 'db');
    const pack = p.processingOptions?.noSchemaPack ? undefined : await loadActivePackForEngine(engine, { remote: row.authority.remote, sourceId: row.source_id }).catch(() => null);
    const renamed = moved && moved.slug !== row.slug ? moved : undefined;
    const base = renamed ? await engine.readPageSnapshot(renamed.slug, { ...source, includeDeleted: true }) : snapshot;
    if (renamed && (base?.page.id !== renamed.pageId || base.revision !== renamed.revision || base.page.deleted_at != null)) {
      throw syncPublicationRefusal('revision_conflict', 'The renamed page changed after sync admission.', row, p,
        `Page ${renamed.slug}, which this file was renamed from, changed or was deleted after the sync was admitted.`);
    }
    return prepareManagedSyncStreamed(engine, row, { ...p, body_ref: p.body_ref, sourcePath: p.sourcePath, path: p.path }, { root, snapshot, base, ...(renamed ? { renamed } : {}),
      ...(pack?.manifest ? { activePack: pack.manifest } : {}), validate, releaseHold, clock, screening: !!screening,
      importProvenance: { source_id: row.source_id, incarnation: row.source_incarnation, origin: p.sourcePath, raw_sha256: p.body_ref.sha256,
        ...(p.blobOid ? { blob_oid: p.blobOid } : {}), working: p.working === true, gbrain_version: VERSION, parser: syncImportParser(pack?.identity ?? null) },
      refuse: (code, message, cause) => syncPublicationRefusal(code, message, row, p, cause), contentRefusal: refusal => syncContentRefusal(refusal, row, p, false) });
  }
  if (typeof p.content !== 'string' || typeof p.sourcePath !== 'string' || typeof p.path !== 'string') throw syncPublicationRefusal('storage_error', 'The frozen import content is missing.', row, p,
    'The stored intent has no frozen file content to import.');
  // #6529: an image entry (frozen as base64 bytes) takes the coordinated image importer; its text embedding waits for embed --stale.
  if (isImageFilePath(p.sourcePath)) {
    return prepareManagedSyncImage(engine, row, { content: p.content, sourcePath: p.sourcePath, path: p.path, rawHash: p.rawHash, lineEndingOnly: p.lineEndingOnly },
      { root, snapshot, ...(moved && moved.slug !== row.slug ? { renamedFrom: { slug: moved.slug } } : {}), noEmbed: p.processingOptions?.noEmbed === true || p.embedDeferred === true, companyApproval: !!p.companyApproval, validate, releaseHold, clock, screening: !!screening,
        recordProvenance: syncFileProvenance(row, p, root, sha256(Buffer.from(p.content, 'base64'))),
        refuse: (code, message, cause) => syncPublicationRefusal(code, message, row, p, cause) });
  }
  if (isCodeFilePath(p.sourcePath)) return prepareManagedSyncCode(engine, row, { content: p.content, sourcePath: p.sourcePath, rawHash: p.rawHash, lineEndingOnly: p.lineEndingOnly, companyApproval: !!p.companyApproval },
    { snapshot, validate, releaseHold, recordProvenance: syncFileProvenance(row, p, root, sha256(p.content)), clock, refuse: (code, message, cause) => syncPublicationRefusal(code, message, row, p, cause), contentRefusal: refusal => syncContentRefusal(refusal, row, p) });
  const schema = p.companyApproval?.schema;
  if (schema && p.processingOptions?.noSchemaPack) throw syncPublicationRefusal('profile_incompatible', 'Company source approval requires its pinned schema pack.', row,
    { ...p, processingOptions: { ...p.processingOptions!, noSchemaPack: false } },
    `A company-brain source imports with its pinned schema pack, so ${row.source_id} cannot sync with --no-schema-pack.`);
  enterClaimStep(clock, 'schema_pack', undefined, 'db');
  const pack = p.processingOptions?.noSchemaPack ? undefined : schema ? (await checkApprovedSchemaForEngine(engine, { name: schema.name, identity: schema.identity, resolvedManifestHash: schema.resolved_digest },
    { remote: false, sourceId: row.source_id })).pack : await loadActivePackForEngine(engine, { remote: row.authority.remote, sourceId: row.source_id }).catch(() => null), activePack = pack?.manifest;
  // A renamed page is prepared where it stands; publication moves it, then re-prepares at the new slug (reusing an unchanged segmented staging).
  const renamed = moved && moved.slug !== row.slug ? moved : undefined;
  if (renamed) enterClaimStep(clock, 'rename_source', undefined, 'db');
  const base = renamed ? await materializedSnapshot(engine, await engine.readPageSnapshot(renamed.slug, { ...source, includeDeleted: true })) : snapshot;
  if (renamed && (base?.page.id !== renamed.pageId || base.revision !== renamed.revision || base.page.deleted_at != null)) {
    throw syncPublicationRefusal('revision_conflict', 'The renamed page changed after sync admission.', row, p,
      `Page ${renamed.slug}, which this file was renamed from, changed or was deleted after the sync was admitted.`);
  }
  // The screen hashes the frozen bytes and, for a newer working tree, reads the file (raw hash).
  enterClaimStep(clock, 'import_screen', undefined, 'fs');
  const { screen, parsedInput, newerWorkingTree } = await settledSyncScreen(engine, { content: p.content, rawHash: p.rawHash, lineEndingOnly: p.lineEndingOnly === true,
    slug: row.slug, sourcePath: p.sourcePath, path: p.path, root, snapshot, base, renamed: !!renamed, activePack, companyApproval: !!p.companyApproval,
    purgedPages: await readPagePurgeTombstones(engine, row.source_id) });
  if (screen.status === 'published') return publishedSyncNoop(row, p, root, snapshot, pack?.identity ?? null, validate, releaseHold);
  if (screen.status === 'refused') throw syncContentRefusal(screen.refusal, row, p);
  const recovery = screen.parsed?.errors?.find(error => error.code === 'YAML_PARSE' && error.recoverable)?.recovery;
  const commentValue = screen.parsed?.warnings?.some(warning => warning.code === 'FRONTMATTER_COMMENT_VALUE') === true;
  if (newerWorkingTree) {
    throw syncPublicationRefusal('source_changed', 'Newer working-tree bytes and the current page disagree with this pinned Git import.', row, p,
      `The working tree holds newer bytes for ${row.slug} that match neither the pinned import nor the current page; sync did not overwrite them. Preserve the local edit and commit it.`);
  }
  let importContent = p.content;
  if (row.authority.remote) {
    const stored = base ? fenceBody(base.page) : null;
    const compiled_truth = preserveProtectedTakes(parsedInput.compiled_truth, stored?.compiled_truth ?? '');
    const timeline = preserveProtectedTakes(parsedInput.timeline ?? '', stored?.timeline ?? '');
    if (compiled_truth !== parsedInput.compiled_truth || timeline !== (parsedInput.timeline ?? '')) {
      importContent = serializePageToMarkdown({ ...(base ? withoutBody(base.page) : { id: 0, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }),
        ...parsedInput, compiled_truth, timeline } as Page, parsedInput.tags);
    }
  }
  let prepared: PreparedContentImport | undefined;
  enterClaimStep(clock, 'import_content', undefined, 'db');
  // #6188: the import reuses this screen's fence verdict for the same bytes (one fence scan per file at prepare).
  const importOptions = { ...source, noEmbed: true, remote: row.authority.remote, preserveGateMarkers: true, activePack, coordinated: true, fences: 'coordinated' as const, writeGate: await ownerGateInput(engine, row, parsedInput.frontmatter, p.sourcePath),
    ...(importContent === p.content && screen.status === 'importable' ? { fenceScreen: screen.fences ?? null } : {}),
    filename: basename(p.sourcePath).replace(/\.mdx?$/i, ''), sourcePath: p.sourcePath, allowEmptyOverwrite: true,
    segmentedOwner: { kind: 'sync' as const, principalKind: row.principal_kind, principalId: row.principal_id, baseRevision: base?.revision ?? null } };
  const result = await importFromContent(engine, renamed?.slug ?? row.slug, importContent, { ...importOptions,
    prepare: async value => { prepared = value; return value.result; } }).catch(error => {
    if (!(error instanceof ContentSanityBlockError)) throw error;
    throw syncContentRefusal({ code: 'content_rejected', message: error.message }, row, p);
  });
  if (!prepared) throw result.refusal ? syncContentRefusal(result.refusal, row, p) : syncPublicationRefusal('invalid_params', result.error ?? 'The sync file could not be prepared.', row, p,
    `The file could not be prepared as page ${row.slug}.`);
  const ready = prepared;
  if (ready.observedRevision !== (base?.revision ?? null)) throw syncPublicationRefusal('revision_conflict', 'The page changed during sync preparation.', row, p,
    `Page ${renamed?.slug ?? row.slug} changed while this sync was being prepared.`);
  if (ready.slug !== (renamed?.slug ?? row.slug)) {
    // Cross-slug dedup must never advance the origin's checkpoint without a
    // guarded proof about the other identity. Keep the cursor explicitly blocked.
    throw syncPublicationRefusal('revision_conflict', 'A different page already owns this file identity; resolve the duplicate before syncing.', row, p,
      `Page ${ready.slug} already holds the content identity of ${renamed?.slug ?? row.slug}; resolve the duplicate pages first.`);
  }
  const parsed = parseMarkdown(p.content, `${row.slug}.md`, { activePack });
  resolveParsedSubtype(parsed, base?.page);
  const tags = [...new Set([...(base?.tags ?? []), ...ready.parsedPage.tags])].sort();
  const renderedPage = { ...(base ? withoutBody(base.page) : { id: 0, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }), ...ready.parsedPage } as Page;
  if (renamed && parsedInput.typeExplicit !== true) renderedPage.type = parsedInput.type;
  const canonical = (page: Pick<typeof parsed, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>, tags: string[]) => ({ type: page.type, title: page.title, body: page.compiled_truth,
    timeline: page.timeline ?? '', frontmatter: withoutSafetyAssessments(page.frontmatter), tags: [...new Set(tags)].sort() });
  // A move re-infers an implicit type from the new location, as a fresh import there would.
  const renamedType = renamed && parsedInput.typeExplicit !== true ? parsedInput.type : undefined;
  const overlay = digest(canonical(parsed, parsed.tags)) !== digest(canonical({ ...ready.parsedPage, type: renamedType ?? ready.parsedPage.type }, tags));
  const fenceFixes = ready.result.fences_normalized ?? [];
  if (overlay && p.companyApproval) throw companyWritebackRefusal(row, p, fenceFixes);
  // #5409: a read-only mirror keeps its canonical metadata in the database only; its checkout stays the remote's bytes.
  enterClaimStep(clock, 'mirror_check', undefined, 'db');
  const mirrorReadOnly = overlay && await sourceMirrorReadOnly(engine, row.source_id);
  const canonicalFile = overlay && !mirrorReadOnly ? serializePageToMarkdown(renderedPage, tags) : null;
  const writeback = canonicalWritebackNeeded(row, p, p.content, canonicalFile);
  // A rename projects against the moved page (same id), so its pinned timeline rows carry over.
  enterClaimStep(clock, 'canonical_projections', undefined, 'db');
  const project = await prepareCanonicalProjections(engine, ready.parsedPage, row.slug, row.source_id, base, p.companyApproval ? 'immutable' : 'file');
  const importProvenance: SyncImportProvenanceBase = { source_id: row.source_id, incarnation: row.source_incarnation, origin: p.sourcePath!, raw_sha256: sha256(p.content!),
    ...(p.blobOid ? { blob_oid: p.blobOid } : {}), working: p.working === true, gbrain_version: VERSION, ...(recovery?.length ? { recovery } : {}), parser: syncImportParser(pack?.identity ?? null) };
  // afterCommit follows the import that published: a rename publishes its re-preparation at the new slug.
  let published = ready;
  const preparedImport: SyncPreparedMutation = { observedRevision: snapshot?.revision ?? null, trust: await ownerImportTrust(engine, row, ready.parsedPage.frontmatter, p.sourcePath), importProvenance,
    // Tells the #5470 screen the content is unchanged; publication still queues its effects.
    contentUnchanged: ready.noop && !moved && !writeback,
    pageUnchanged: ready.noop && !moved,
    ...(renamed ? { additionalPageKeys: [{ sourceId: row.source_id, slug: renamed.slug }] } : {}),
    validate: async tx => { await validate(tx); await ready.validate(tx); },
    deferEmbedding: p.processingOptions?.noEmbed || p.embedDeferred === true,
    ...(ready.afterCommit || renamed ? { afterCommit: async (target: BrainEngine) => { await published.afterCommit?.(target); } } : {}),
    ...(writeback ? { file: { root, path: join(root, p.path), content: canonicalFile, expectedBeforeHash: p.rawHash } } : {}),
    ...(mirrorReadOnly ? { databaseOnlyReason: 'mirror_read_only' as const } : {}),
    apply: async (tx, preimage) => {
      let applied = ready;
      if (renamed) {
        // The page moves first, keeping its id, inbound links and history and leaving
        // `old -> new` in slug_aliases; the file content is then prepared against it.
        if (await tx.updateSlug(renamed.slug, row.slug, source) !== 1) throw syncPublicationRefusal('page_identity_changed', 'The renamed page could not move to its new slug.', row, p,
          `Page ${renamed.slug} could not move to ${row.slug}.`);
        if (renamedType) await tx.executeRaw('UPDATE pages SET type=$3 WHERE source_id=$1 AND slug=$2', [row.source_id, row.slug, renamedType]);
        let movedImport: PreparedContentImport | undefined;
        await importFromContent(tx, row.slug, importContent, { ...importOptions, reuseSegments: ready.segmented,
          prepare: async value => { movedImport = value; return value.result; } });
        if (!movedImport || movedImport.slug !== row.slug) throw syncPublicationRefusal('page_identity_changed', 'The renamed page could not be prepared at its new slug.', row, p,
          `Page ${renamed.slug} could not be prepared at ${row.slug}.`);
        if (movedImport.segmented?.prepared !== ready.segmented?.prepared) await abortSegmentedStaging(tx, ready.segmented?.prepared);
        await movedImport.validate(tx);
        applied = movedImport;
      }
      published = applied;
      // A moved page is versioned from its own (rename source) read.
      const installed = await applied.apply(tx, renamed ? undefined : preimage);
      // Hash no-ops still repair a missing physical origin under the same guard (a page write records it itself).
      if (applied.noop && p.sourcePath) await bindOrigin(tx, { sourceId: row.source_id, slug: row.slug, sourcePath: p.sourcePath, scope: originScope });
      // #6536: the page now records this file as its origin, so it is no longer a #5254 database-only page.
      await tx.executeRaw("UPDATE pages SET database_only_reason=NULL WHERE source_id=$1 AND slug=$2 AND database_only_reason='unbound_source'", [row.source_id, row.slug]);
      // #5984: the one read of the page after its last page write (the projections
      // below and the seal leave its revision unchanged): read-back check, projection
      // target, seal input, receipt revision and effects.
      const final = await tx.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
      const live = final && final.page.deleted_at == null ? final : null;
      if (!applied.noop) await verifyPageReadable(tx, row.slug, applied.contentHash!, row.source_id, 'managed sync', live?.page ?? null);
      // The projections, the text seal, the hold and the provenance touch separate rows; their pipelines run together.
      await pipelined(tx, [
        async () => { if (!applied.noop || p.companyApproval) await project(tx, final?.page.id); },
        async () => {
          if (applied.noop) return;
          if (installed?.segmented) { if (installed.segmented.complete && live) await sealSegmentedPage(tx, Number(live.page.id)); }
          else if (installed?.chunkerSeal !== undefined) await sealImportedPage(tx, row.slug, row.source_id, live, installed.chunkerSeal, installed.pageId);
          else if (live) await sealPageTextProjection(tx, row.slug, row.source_id, live);
        },
        () => releaseHold(tx),
        async () => { if (final) await recordSyncImportProvenance(tx, { ...importProvenance, page_id: Number(final.page.id), revision: final.revision,
          ...syncDiskProvenance(writeback ? Buffer.from(canonicalFile) : syncDiskBytes(root, p.path!, p.content!, p.rawHash), p.target) }); },
      ]);
      preparedImport.postimage = final;
      // #6722: a large or embed_skip page says what this write left its embedding in.
      const sizeState = applied.noop ? {} : await sizeStateField(tx, row.source_id, row.slug, live?.page);
      return { status: moved ? 'renamed' : applied.noop ? 'skipped' : snapshot ? 'updated' : 'created', slug: row.slug, source_id: row.source_id,
        chunks: applied.result.chunks, noop: applied.noop && !moved, imported_file: true, ...(moved ? { renamed_from: moved.slug } : {}), ...sizeState,
        ...(recovery?.length ? { recovered_frontmatter: true } : {}), ...(commentValue ? { comment_value: true } : {}),
        ...(fenceFixes.length ? { fences_normalized: fenceFixesWire(fenceFixes) } : {}) };
    } };
  return preparedImport;
}
