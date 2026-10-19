import { isEmbedSkipped } from '../embed-skip.ts';
import { appendPurgeCommitted } from '../belief/purge-mirror.ts';
import { sizeStateField } from '../page-embedding-budget.ts';
import { enterClaimStep, type ClaimPhaseClock } from './claim-phase.ts';
import { boundedReads } from './bounded-reads.ts';
import { isQuarantined, quarantineOutcome } from '../quarantine.ts';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { matchesAnyGlob } from '../sync.ts';
import { syncExcludePatterns } from './sync-discovery.ts';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page, PageVersion } from '../types.ts';
import { importFromContent, verifyPageReadable, type ParsedPage } from '../import-file.ts';
import { comparableFrontmatter, frontmatterHoldMessageWithoutKeys, parseMarkdown, resolveParsedSubtype, serializePageToMarkdown, resolveSourceLocalFilePath, type ParsedMarkdown, type ParseOpts } from '../markdown.ts';
import { assertLargePageReplacement } from './large-page-guard.ts';
import { applyInference } from '../frontmatter-inference.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { CANONICAL_FILE_MISSING } from './publication-failure.ts';
import { committedPendingImport, pendingImportRefusal, SYNC_HELD } from './pending-import.ts';
import { readFix } from '../ops/op-fix.ts';
import { isOpPageSlug } from '../ops/context.ts';
import { shellQuote, type Action } from '../agent-output.ts';
import type { RegistryCode } from '../error-registry.ts';
import { pageIdentityError } from './page-identity.ts';
import { contentRefusalError, PAGE_OVER_LIMIT_SUGGESTION } from '../import-screen.ts';
import { ContentSanityBlockError } from '../content-sanity.ts';
import { assertPageRevision, type PageSnapshot } from '../page-state/types.ts';
import { gitHoldFix, readGitHold } from './sync-holds.ts';
import { hostOperatorFix, recordRoute } from './held-reads.ts';
import { heldFileMessage } from './verb-errors.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { recordedPathFromFileUri, scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { engineMutationPrecondition, parseMutationPrecondition } from './preconditions.ts';
import { assertPurgeParams } from './purge-params.ts';
import { authorizeWrite, slugDisclosable } from './authority.ts';
import { findLiveFileClaimants, type FileClaimant, type FileClaimTarget } from './file-claims.ts';
import { digest, sha256 } from './digest.ts';
import { replaceableFile } from '../facts/file-body-guard.ts';
import { getWorktreeBinding } from './ownership.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { SqlEngine, WriteRequest } from './model.ts';
import { isUnboundSourcePage } from './unbound-source.ts';
import { isOriginTwinPage } from './origin-twins.ts';
import { sealImportedPage, sealPageTextProjection } from '../page-state/projections.ts';
import { materializedSnapshot, sealSegmentedPage } from './segmented-apply.ts';
import { pipelined } from '../page-state/transactions.ts';
import { overlayCanonicalBodies } from '../page-state/snapshot.ts';
import { segmentedRevertRefusal } from '../page-state/versions.ts';
import { bodyUnread, isSegmentedPage, pageBodySegmentedError, withoutBody } from '../page-body/page-shape.ts';
import { fileBodyDigests, overlaidFileBodyDigests, storedBodyDigests, type ByteSource, type FileReading, type RegionDigests } from '../page-body/body-digests.ts';
import { ledgerApplies, type BodyLedger } from '../page-body/segment-ledger.ts';
import { inferredHeadPrefix } from '../page-body/streamed-import.ts';
import { fenceTooLargeError } from '../page-body/read-range.ts';
import { FRONTMATTER_HEAD_MAX_BYTES } from '../page-body/limits.ts';
import { occurrencesWithoutChunks, readSegmentedBody } from '../page-body/ingest.ts';
import { ContentHashStream } from '../page-body/content-hash-stream.ts';
import { buildSegmentedProjection, hasStaleChunks } from '../page-body/projection.ts';
import { segmentedExportMarkdown } from '../export-snapshot.ts';
import { loadImportSanityConfig } from '../import-screen.ts';
import { DEFAULT_WRITE_GATE_CONFIG, writeGateApplies } from '../write-gate.ts';
import { materializeTimeline, prepareCanonicalProjections, type TimelineRowsRemoved } from './canonical-projections.ts';
import { assertTimelineNotOmitted, timelineWritePolicy } from './timeline-omission.ts';
import { preserveProtectedTakes } from './protected-takes.ts';
import { isAutoLinkEnabled } from '../link-extraction.ts';
import { prepareAutomaticLinks } from './links-preparation.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { preparePageAdvisories, remoteLinkHint, pageNoopAdvisories, timelineRowsRemovedAdvisory } from './page-advisories.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { colonSlugWindowsRefusal, isWindowsColonTarget, nativeFileTarget } from './native-file-target.ts';
import { isSourceDbOnlySlug } from './source-storage.ts';
import { isMirrorOnlyPage, sourceMirrorReadOnly } from './mirror-read-only.ts';
import { DERIVE_PHASE_DB_ONLY_DEFAULTS } from '../storage-config.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../source-config-sql.ts';
import { readSlugRootMode } from '../sync-anchor.ts';
import { applyPageEdits, editDiff, parsePageEdits } from './page-edit.ts';
import { carryCoreMarking, prepareCoreGuard } from './core-guard.ts';
import { fenceWhere } from '../fence-repair/refusal.ts';
import { pageFencesNormalized } from '../fence-repair/report.ts';
import { parseFenceRepairReceipt } from '../fence-repair/receipt.ts';
import { fenceRepairCommit } from './effect-model.ts';
import { withoutSafetyAssessments } from './reconcile-safety.ts';
import { preparePagePurge, purgePageInTransaction, type PreparedPagePurge } from './page-purge.ts';
import { withTrustKeep } from './context.ts';
import { isFenceEditWrite, pageGateTrust, pageWriteTrust, recordAgentPageLowering, stampPageTrustMarker, storedPageTier } from '../trust/page-write.ts';
import { suppliedTrustMarkerView } from '../trust/channel.ts';
import { gateField, gateInput } from '../trust/gate-outcomes.ts';
import { PUSH_SCAN_MAX_FILE_BYTES } from '../page-size-policy.ts';
import { fileContentHash, FileBytes, isStreamedContent, LARGE_FILE_MIN_BYTES, StreamedFileContent } from './large-file.ts';
import { bindOrigin } from './origin-guard.ts';


const ownerStatusFix = (sourceId: string): Action => readFix(`Shows source ${sourceId}'s canonical owner with its pending, failed and recovering requests, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
const pageFix = (sourceId: string, slug: string): Action => readFix(`Shows page ${slug} in source ${sourceId} as it is now, with its revision.`,
  { argv: ['gbrain', 'get', '--source', sourceId, '--', slug], mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId } } });

/**
 * A refused page request. The journal keeps only code and message, so the
 * suggestion stands alone: the cause and next step, then the request to
 * inspect before anything is resubmitted.
 */
function pageRefusal(code: RegistryCode, message: string, row: WriteRequest, cause: string, fix?: Action): OperationError {
  return opError(code, message,
    `${cause} Request ${row.request_id} in source ${row.source_id} was refused; inspect it before resubmitting, and use a new request_id for any corrected write.`,
    { fix: fix ?? (row.principal_kind === 'local_cli'
      ? readFix(`Reads request ${row.request_id}'s durable receipt: its state and recorded error, read-only.`, { argv: ['gbrain', 'write-request', '--', row.request_id] })
      : ownerStatusFix(row.source_id)) });
}

/**
 * The parser trims titles, so a stored title differing only in surrounding whitespace is not drift (#5635), and it
 * never carries `type`/`title`/`tags`/`slug` into the frontmatter object, so a stored copy of one (#6454: older
 * imports kept them) is compared through `comparableFrontmatter` on both sides, never as drift.
 */
function canonical(page: Pick<Page, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>, tags: string[]) {
  return { type: page.type, title: page.title.trim(), compiled_truth: page.compiled_truth, timeline: page.timeline ?? '',
    frontmatter: comparableFrontmatter(page.frontmatter), tags: [...new Set(tags)].sort() };
}
interface CanonicalProvenance { source_kind: string; ingested_via: string; ingested_at: string; }
/** Canonical stamps belong to the first write, never to a later preparation attempt. */
function putProvenance(row: WriteRequest, snapshot: PageSnapshot | null, parsed: ParsedPage): CanonicalProvenance | undefined {
  if (row.operation !== 'put_page' || !row.worktree_id) return undefined;
  const keys = ['source_kind', 'ingested_via', 'ingested_at'] as const;
  for (const key of keys) {
    delete parsed.frontmatter[key];
    if (snapshot?.page.frontmatter[key] !== undefined) parsed.frontmatter[key] = snapshot.page.frontmatter[key];
  }
  const tags = [...new Set([...(snapshot?.tags ?? []), ...parsed.tags])].sort();
  if (snapshot && !snapshot.page.deleted_at && digest(canonical(snapshot.page, snapshot.tags)) === digest(canonical(parsed, tags))) {
    return undefined;
  }
  const string = (value: unknown) => typeof value === 'string' && value ? value : undefined;
  const first = snapshot?.page;
  const via = row.authority.remote ? 'mcp:put_page' : 'put_page';
  // Historical frontmatter was caller-controlled. Only trusted provenance
  // columns may supply a prior channel or timestamp for the first-write record.
  const stamp: CanonicalProvenance = {
    source_kind: string(first?.source_kind) ?? string(row.intent?.source_kind) ?? via,
    ingested_via: string(first?.ingested_via) ?? string(row.intent?.ingested_via) ?? via,
    ingested_at: new Date(first?.ingested_at ?? row.created_at).toISOString(),
  };
  Object.assign(parsed.frontmatter, stamp);
  return stamp;
}
/** A derive-phase page (DERIVE_PHASE_DB_ONLY_DEFAULTS) that never recorded a canonical file. */
function isNeverFiledDerivedPage(slug: string, page: { source_path?: string | null; source_uri?: string | null }): boolean {
  return !page.source_path && !page.source_uri && DERIVE_PHASE_DB_ONLY_DEFAULTS.some(prefix => slug.startsWith(prefix));
}
/**
 * A live page whose canonical file is absent publishes to the database only
 * when its slug is a declared db_only path or a never-filed derive-phase page.
 */
export function publishesDatabaseOnly(root: string, slug: string, snapshot: { page: Pick<PageSnapshot['page'], 'deleted_at' | 'source_path' | 'source_uri'> } | null): boolean {
  if (!snapshot || snapshot.page.deleted_at) return false;
  return isSourceDbOnlySlug(root, slug, 'refuse') || isNeverFiledDerivedPage(slug, snapshot.page);
}
/**
 * #6605: a canonical file read the way the importer reads it. A file with no frontmatter under a
 * directory-inference rule is imported with the frontmatter and tags inferred from its path
 * (`applyInference` after stripping a BOM: import-prepare.ts, import-file.ts), so comparing its raw bytes
 * with the stored row reads every untouched file as drift. `sourcePath` is the path the importer infers
 * from (`scannerSourcePath`). Inference is deterministic, so this reproduces what the import stored;
 * `inferred` is false when no rule applies (the bytes are read as they are).
 */
export function readCanonicalAsImported(bytes: string, sourcePath: string): { content: string; inferred: boolean } {
  const inference = applyInference(sourcePath, bytes.replace(/^\uFEFF/, ''));
  return inference.inferred.skipped === true ? { content: bytes, inferred: false } : { content: inference.content, inferred: true };
}

/**
 * Whether file bytes hold the snapshot's page: the canonical (format-insensitive)
 * comparison prepareFileTarget applies before replacing a canonical file. Lint
 * uses it to bind a repair to the revision it read before reading the file.
 * `sourcePath` (the importer's path for the file, or a resolver for it) lets a
 * frontmatter-less file match the row an inferring import stored (#6605); the
 * raw reading still matches a row imported without inference (`gbrain reindex`
 * on an unmanaged brain passes `inferFrontmatter: false`).
 */
export async function fileMatchesSnapshot(engine: BrainEngine, slug: string, bytes: string, snapshot: PageSnapshot,
  sourcePath: string | (() => Promise<string>), activePack?: ParseOpts['activePack']): Promise<boolean> {
  const expected = digest(canonical({ ...snapshot.page, frontmatter: withoutSafetyAssessments(snapshot.page.frontmatter ?? {}) }, snapshot.tags));
  const matches = async (content: string, inferred: boolean) => {
    const parsed = parseMarkdown(content, slug, { activePack });
    const type = importedFileType(parsed, snapshot.page, inferred);
    // Withdrawal overlays intentionally precede physical mirroring. The ledger
    // is applied by the import preparation and cannot be undone by this check.
    const actual = canonical({ ...parsed, frontmatter: withoutSafetyAssessments(parsed.frontmatter), type, ...await overlayCanonicalBodies(engine.executeRaw.bind(engine),
      parsed.compiled_truth, parsed.timeline ?? '', snapshot.withdrawals, { sourceId: snapshot.page.source_id, marker: snapshot.globalPurges }) }, parsed.tags);
    return digest(actual) === expected;
  };
  if (await matches(bytes, false)) return true;
  const reading = readCanonicalAsImported(bytes, typeof sourcePath === 'string' ? sourcePath : await sourcePath());
  return reading.inferred && await matches(reading.content, true);
}
/** The type a file's parse compares with (`fileMatchesSnapshot`), after aligning the parse with what its import over `page` stores. */
function importedFileType(parsed: ParsedMarkdown, page: Pick<Page, 'type' | 'frontmatter'>, inferred: boolean): Page['type'] {
  // #5521 parity for subtype (#5928): a pack rule is not part of the file's bytes, so a file
  // without an explicit `subtype:` keeps the stored subtype (or none); the import still stamps it.
  delete parsed.inferredSubtype;
  resolveParsedSubtype(parsed, page);
  // #6429: the v0.13.1 grandfather stamped `validate: false` into the database; on an unmanaged brain that path
  // never wrote the file, so the file lacks a key the database carries. The mechanical stamp authors nothing
  // (grandfather.ts): a file without a `validate:` key keeps the stored stamp, and the next coordinated write publishes it.
  if (!Object.hasOwn(parsed.frontmatter, 'validate') && page.frontmatter?.validate === false) parsed.frontmatter.validate = false;
  // #1035 parity (#5521): a file without an explicit `type:` keeps the stored type on import. An inferred
  // type is not one the file declared (#6605): inference only applies to a file with no frontmatter.
  return parsed.typeExplicit && !inferred ? parsed.type : page.type;
}
/** The withdrawal ledger readPageSnapshot overlaid the snapshot's body with, for a segmented body read under it. */
function snapshotLedger(snapshot: PageSnapshot): BodyLedger {
  return { withdrawals: snapshot.withdrawals, ...(snapshot.globalPurges ? { globalPurges: snapshot.globalPurges } : {}) };
}
/**
 * Wave B: `fileMatchesSnapshot` for a segmented page whose body was not read back (over the single-string ceiling).
 * The same comparison (the gate's safety markers stripped on both sides) with each body region replaced by its SHA-256 on both sides: the file's regions as the streamed
 * importer's scan splits them, the stored ones from the trusted stored body (body-digests.ts), one segment at a time.
 * The withdrawal overlay leaves a body without a facts fence unchanged; a file whose body has one under a ledger
 * that applies cannot be overlaid streamed, so it refuses (`page_body_segmented`) instead of reading as drift.
 */
async function segmentedFileMatches(engine: BrainEngine, slug: string, bytes: ByteSource, snapshot: PageSnapshot,
  sourcePath: () => Promise<string>, activePack?: ParseOpts['activePack'], between?: () => Promise<void>): Promise<boolean> {
  const ledger = snapshotLedger(snapshot);
  let stored: RegionDigests | undefined;
  const matches = async (reading: FileReading, inferred: boolean) => {
    const file = fileBodyDigests(bytes, reading, slug, { activePack });
    await between?.();
    if (file.kind !== 'ok') return file.reason;
    // A facts fence under a ledger that applies is compared overlaid, one complete fence block at a time; a fence longer
    // than FENCE_MAX_BYTES refuses, as the stored side's trusted read does.
    const fileDigests = file.factsFence && ledgerApplies(ledger)
      ? await overlaidFileBodyDigests(bytes, reading, file.regions, async text => (await overlayCanonicalBodies(engine.executeRaw.bind(engine), text, '',
        ledger.withdrawals, { sourceId: snapshot.page.source_id, marker: ledger.globalPurges })).compiled_truth,
      fence => fenceTooLargeError(slug, snapshot.page.source_id, fence), between)
      : file.digests;
    const parsed = { ...file.parsed, compiled_truth: fileDigests.truth, timeline: fileDigests.timeline };
    const type = importedFileType(parsed, snapshot.page, inferred);
    stored ??= await storedBodyDigests(engine, Number(snapshot.page.id), ledger, between);
    return digest(canonical({ ...parsed, frontmatter: withoutSafetyAssessments(parsed.frontmatter), type }, parsed.tags))
      === digest(canonical({ ...withoutBody(snapshot.page), frontmatter: withoutSafetyAssessments(snapshot.page.frontmatter ?? {}), compiled_truth: stored.truth, timeline: stored.timeline }, snapshot.tags));
  };
  const raw = await matches({ prefix: new Uint8Array(0), skip: 0 }, false);
  if (raw === true) return true;
  if (raw === 'invalid_utf8') return false;
  const bom = bytes.subarray(0, 3);
  const skip = bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf ? 3 : 0;
  const prefix = await inferredHeadPrefix(bytes.subarray(skip, skip + FRONTMATTER_HEAD_MAX_BYTES), await sourcePath());
  return !!prefix?.length && await matches({ prefix, skip }, true) === true;
}
export async function prepareFileTarget(engine: BrainEngine, row: Pick<WriteRequest, 'source_id' | 'worktree_id' | 'slug'> & { operation?: string }, snapshot: PageSnapshot | null,
  content: string | Uint8Array | StreamedFileContent | null, hostId?: string, options: { allowMissing?: boolean; deleting?: boolean; capture?: { path: string; hash: string }; activePack?: ParseOpts['activePack']; remote?: boolean;
    /** #6368: a tombstone purge whose file matches these sync.exclude globs (relative to the source root) owns no file. */
    excludeTombstone?: { patterns: string[]; onExcluded: (path: string) => void };
    /** #6517: a delete whose file another live page of the source records owns no file; the census target and claimants are reported. */
    sharedOrigin?: { onShared: (shared: SharedOrigin) => void };
    /** Runs between the pieces of a segmented page's file comparison (an effect's claim renewal). */
    between?: () => Promise<void> } = {}): Promise<PreparedMutation['file']> {
  if (!row.worktree_id) return undefined;
  // An in-memory canonical file over the 25 MiB push-scan cap is refused (only a page over the 24 MiB single-string
  // ceiling renders one). That page's file is streamed instead (restore_page of a page whose body was not read back,
  // large-file.ts), and the push gate scans a staged file over the cap in bounded windows (workspace-push.ts).
  if (content !== null && !isStreamedContent(content) && Buffer.byteLength(content, 'utf-8') > PUSH_SCAN_MAX_FILE_BYTES) throw opError('request_too_large', 'The canonical file would exceed the pre-push secret-scan cap.',
    `Nothing was written. The rendered file of ${row.slug} is over ${PUSH_SCAN_MAX_FILE_BYTES} bytes, which the pre-push secret scan cannot scan, so it would block every push of source ${row.source_id}. Keep the page under the 24 MiB page ceiling (docs/guides/memory-boundaries.md#large-pages).`);
  // #6212: a legacy slug (admitted only to delete or restore its existing row) never owns a file: its recorded
  // source_uri or source_path may name the file of another page, such as the one sync now slugs it to.
  if (!isOpPageSlug(row.slug)) return undefined;
  // #5409: a read-only mirror's checkout belongs to its Git remote; nothing is written or removed there.
  if (await sourceMirrorReadOnly(engine, row.source_id)) return undefined;
  if (snapshot && !snapshot.page.source_path && await isMirrorOnlyPage(engine, row.source_id, row.slug)) return undefined;
  // #5254: a page written while its source was unbound stays database-only in
  // every state (live, tombstone, restore, revert, delete, purge); any file at
  // its derived path is not its canonical file and is neither written nor removed.
  if (snapshot && !snapshot.page.source_path && await isUnboundSourcePage(engine, row.source_id, row.slug)) return undefined;
  // #6948: a page that gave its file up to a duplicate it was merged into never writes or removes a file again (restore,
  // edit, purge); any file at its slug path is another page's.
  if (snapshot && !snapshot.page.source_path && await isOriginTwinPage(engine, row.source_id, row.slug)) return undefined;
  const binding = await getWorktreeBinding(engine, row.source_id, hostId);
  if (!binding?.local_path) throw opError('owner_unavailable', 'The canonical worktree is unavailable on this host.',
    `This host does not hold source ${row.source_id}'s canonical worktree (or it has no local path), so the file of ${row.slug} was not written. Inspect the owner before resubmitting; the write publishes on the host that owns the source.`,
    { fix: ownerStatusFix(row.source_id) });
  const root = join(binding.local_path, binding.relative_path);
  // #5622: a new page captured from a file inside the source is published to that file.
  const capturedPath = !snapshot && options.capture ? options.capture.path : recordedPathFromFileUri(snapshot?.page.source_uri, root);
  const mode = snapshot?.page.source_path ? await scannerSlugRootMode(engine, row.source_id, root) : undefined;
  const candidate = resolveSourceLocalFilePath(root, snapshot?.page.source_path, row.slug, mode)
    ?? (capturedPath ? join(root, capturedPath) : join(root, `${row.slug}.md`));
  if (isWindowsColonTarget(relative(root, candidate))) {
    if (!options.allowMissing && publishesDatabaseOnly(root, row.slug, snapshot)) return undefined;
    throw colonSlugWindowsRefusal(row.slug, row.source_id);
  }
  const path = nativeFileTarget(root, candidate);
  if (!isWriteTargetContained(path, root)) throw opError('source_changed', 'The canonical file target is outside its registered source.',
    `The file of ${row.slug} resolves outside source ${row.source_id}'s registered root (a symlinked directory or a moved checkout), so nothing was written. Inspect the owner before resubmitting; how to repair the checkout is the user's decision.`,
    { fix: ownerStatusFix(row.source_id) });
  if (options.excludeTombstone && snapshot?.page.deleted_at) {
    const rel = relative(root, path).split(sep).join('/');
    if (matchesAnyGlob(rel, options.excludeTombstone.patterns)) { options.excludeTombstone.onExcluded(rel); return undefined; }
  }
  // A prior file over the single-string ceiling is read on demand in pieces (large-file.ts), never whole; so is the file
  // of a page stored in segments, or of a streamed target, at any size (its comparison reads it piecewise anyway).
  const piecewise = (snapshot && bodyUnread(snapshot.page)) || (content !== null && isStreamedContent(content));
  const before: Buffer | FileBytes | null = !existsSync(path) ? null
    : piecewise || statSync(path).size > LARGE_FILE_MIN_BYTES ? FileBytes.open(path) : readFileSync(path);
  try {
    return await compareFileTarget(engine, row, snapshot, content, options, { root, path, mode, capturedPath, before });
  } finally { if (before instanceof FileBytes) before.close(); }
}

/** prepareFileTarget's comparison of the file at `path` (`before`, its bytes or a piecewise reading) with the snapshot. */
async function compareFileTarget(engine: BrainEngine, row: Pick<WriteRequest, 'source_id' | 'worktree_id' | 'slug'>, snapshot: PageSnapshot | null,
  content: string | Uint8Array | StreamedFileContent | null, options: Parameters<typeof prepareFileTarget>[5] & object,
  target: { root: string; path: string; mode: Awaited<ReturnType<typeof scannerSlugRootMode>> | undefined; capturedPath: string | null | undefined; before: Buffer | FileBytes | null }): Promise<PreparedMutation['file']> {
  const { root, path, mode, capturedPath, before } = target;
  const beforeHash = () => before instanceof FileBytes ? before.hash() : sha256(before!);
  if (options.deleting === true && options.sharedOrigin && snapshot && before) {
    const target: FileClaimTarget = { sourceId: row.source_id, slug: row.slug, pageId: snapshot.page.id, root, path, canonicalPath: realpathSync(path),
      mode: mode ?? await scannerSlugRootMode(engine, row.source_id, root), recordedUri: capturedPath ? snapshot.page.source_uri ?? null : null };
    const claimants = await findLiveFileClaimants(engine, target);
    if (claimants.length) { options.sharedOrigin.onShared({ target, claimants }); return undefined; }
  }
  if (!before && snapshot && !snapshot.page.deleted_at && !options.allowMissing) {
    // A declared db_only page has no canonical file by design and publishes to
    // the database only. gbrain.yml is consulted only here, where the write
    // would otherwise refuse, so an invalid config can only change the refusal.
    // Derive-phase output (atoms/, concepts/, ...) is database-only by design and
    // deliberately never declared in gbrain.yml. A page there that never recorded a
    // canonical file publishes to the database only; a recorded file that went
    // missing still refuses below.
    if (publishesDatabaseOnly(root, row.slug, snapshot)) return undefined;
    if (options.deleting === true && content === null && !snapshot.page.source_path && !capturedPath) return undefined;
    // #6696 (A12): tagged, so a producer can refuse this before admission and the receipt says which refusal it was.
    throw opError('source_changed', 'The canonical file was removed outside coordinated publication.',
      'Import the local deletion or recover the canonical file before editing this page.', { detail: CANONICAL_FILE_MISSING });
  }
  // A normal edit may replace only the bytes represented by its read snapshot.
  // Unknown local edits require explicit import/recovery, even for force writes.
  if (before && snapshot) {
    const importPath = async () => scannerSourcePath(root, path, mode ?? await scannerSlugRootMode(engine, row.source_id, root));
    // An inline page's file over the push-scan cap cannot hold its body (at most 24 MiB): drift, never read whole.
    const matches = bodyUnread(snapshot.page) ? await segmentedFileMatches(engine, row.slug, before, snapshot, importPath, options.activePack, options.between)
      : before.length <= PUSH_SCAN_MAX_FILE_BYTES && await fileMatchesSnapshot(engine, row.slug, (before instanceof FileBytes ? Buffer.from(before.subarray()) : before).toString('utf8'), snapshot, importPath, options.activePack);
    // #6986: a declared db_only page or a never-filed derive-phase page (atoms/, ...) is canonical in the database, so the
    // file at its path is a cache. A cache that holds a state the database already had (the live page or a recent
    // version), left behind by a writer that skipped it, is refreshed by this write under the bytes compared; a cache
    // holding content the database never had is an uncoordinated edit and still refuses below.
    const staleCache = !matches && before instanceof Buffer && publishesDatabaseOnly(root, row.slug, snapshot)
      && await replaceableFile(engine, row.source_id, row.slug, path).then(check => check.ok && check.expectedFileBytes === before.toString('utf8'));
    if (!matches && !staleCache) {
      const held = await heldFileRefusal(engine, row, root, path, 'drift', options.remote === true);
      if (held) throw held;
      // #6394: a page that never recorded its file reconciles against the file at its slug path only when adopted explicitly.
      const adopt = !snapshot.page.source_path && !snapshot.page.source_uri ? ['--adopt-slug-path'] : [];
      // #6693: a committed Git change sync has not imported yet (another agent's commit), on a page that records its file.
      if (!adopt.length && await committedPendingImport(engine, row.source_id, root, path)) throw pendingImportRefusal(row, options.remote === true);
      throw opError('source_changed', 'The canonical file contains an uncoordinated local edit.',
        `On the brain host, run gbrain sources reconcile ${row.source_id} ${row.slug} --brain <brain id, host by default> --preview${adopt.length ? ' --adopt-slug-path (the page records no file of its own, so the preview adopts the file at its slug path)' : ''}, review and apply the resolved preview, then retry this write with a new request_id. Neither copy was overwritten.`,
        { detail: 'file_database_drift', fix: readFix(`Previews how page ${row.slug}'s canonical file and database copy reconcile; a preview never changes canonical content.`,
          { argv: ['gbrain', 'sources', 'reconcile', row.source_id, row.slug, '--brain', 'host', '--preview', ...adopt] }) });
    }
  } else if (before && !snapshot && content !== null && beforeHash() !== fileContentHash(content)
    && !(options.capture && beforeHash() === options.capture.hash)) {
    throw await heldFileRefusal(engine, row, root, path, 'occupied', options.remote === true)
      ?? new OperationError('source_changed', 'An unindexed file already occupies the canonical page path.', 'Import the file before replacing it.');
  }
  return { path, root, content, expectedBeforeHash: before ? beforeHash() : null };
}

/**
 * #5988: a drift or occupied-path refusal whose file sync holds names the hold
 * instead of reconciliation: the page stays read-only for put_page until the
 * file is repaired. Two point reads, only when the refusal already fires.
 */
async function heldFileRefusal(engine: BrainEngine, row: Pick<WriteRequest, 'source_id' | 'slug'>, root: string, path: string,
  kind: 'drift' | 'occupied', remote: boolean): Promise<OperationError | null> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [row.source_id]);
  const hold = source ? await readGitHold(engine, row.source_id, source.incarnation, relative(root, path).split(sep).join('/')) : null;
  if (!hold) return null;
  const effect = kind === 'drift' ? `page ${row.slug} keeps its last good revision and` : `page ${row.slug} does not exist yet and its path`;
  if (remote) {
    // Remote callers get the code and the host operator's command, never the held path or key.
    const error = opError('source_changed', heldFileMessage(kind, hold.code),
      `Sync holds this page's canonical file in source ${row.source_id} (${hold.code}${hold.meta.reason ? `, ${hold.meta.reason}` : ''}) because gbrain cannot import it, `
      + `so ${effect} is read-only for put_page until the brain host operator repairs the file; retrying this write refuses the same way. Relay the fix to the user, then submit the intended write with a new request_id. Neither copy was overwritten.`,
      { fix: hostOperatorFix([{ source_id: row.source_id, route: recordRoute(hold) }], `The canonical file of page ${row.slug} is held (${hold.code}): only the brain host operator can inspect and repair it.`) });
    if (kind === 'drift') error.detail = 'file_database_drift';
    error.reason = SYNC_HELD;
    return error;
  }
  const fix = gitHoldFix(hold);
  const where = [hold.meta.line !== undefined ? `line ${hold.meta.line}` : '', hold.meta.key ? `key "${hold.meta.key}"` : ''].filter(Boolean).join(', ');
  const error = opError('source_changed', heldFileMessage(kind, hold.code),
    `Sync holds ${hold.path} in source ${row.source_id} (${hold.code}${hold.meta.reason ? `, ${hold.meta.reason}` : ''}${where ? ` at ${where}` : ''}) because gbrain cannot import it, `
    + `so ${effect} is read-only for put_page until the file is repaired; retrying this write refuses the same way. `
    + `Repair the file first (${shellQuote(fix.argv ?? [])}: ${fix.why}), then submit the intended write with a new request_id. Neither copy was overwritten.`, { fix });
  if (kind === 'drift') error.detail = 'file_database_drift';
  error.reason = SYNC_HELD;
  return error;
}

/**
 * Receipt reason for a page write that publishes no file. Invariant: for a
 * bound row, prepareFileTarget returns no target only for a live declared
 * db_only page whose file is absent, a page of a read-only mirror source
 * (#5409), a page written while its source was unbound (#5254) in any state, or a page merged into its duplicate (#6948);
 * every other case returns a target or throws.
 */
export function databaseOnlyPublication(row: Pick<WriteRequest, 'worktree_id'>, file: PreparedMutation['file']): Pick<PreparedMutation, 'databaseOnlyReason'> {
  return row.worktree_id && !file ? { databaseOnlyReason: 'db_only' } : {};
}
async function pageDatabaseOnlyPublication(engine: SqlEngine, row: WriteRequest, file: PreparedMutation['file']): Promise<Pick<PreparedMutation, 'databaseOnlyReason'>> {
  const reason = databaseOnlyPublication(row, file);
  if (reason.databaseOnlyReason && (await sourceMirrorReadOnly(engine, row.source_id) || await isMirrorOnlyPage(engine, row.source_id, row.slug))) {
    return { databaseOnlyReason: 'mirror_read_only' };
  }
  if (reason.databaseOnlyReason && await isOriginTwinPage(engine, row.source_id, row.slug)) return { databaseOnlyReason: 'origin_twin' };
  return reason.databaseOnlyReason && await isUnboundSourcePage(engine, row.source_id, row.slug) ? { databaseOnlyReason: 'unbound_source' } : reason;
}

/**
 * #6368: a tombstone whose file is under sync.exclude does not own that file (sync never reads it again), so its purge is
 * database-only: the file is neither compared nor removed. `excludedPath` names that file; the apply re-checks it.
 */
async function prepareDeleteFileTarget(engine: BrainEngine, row: WriteRequest, snapshot: PageSnapshot, purge: boolean,
  options: Parameters<typeof prepareFileTarget>[5]): Promise<{ file: PreparedMutation['file']; excludedPath: string | null; shared: SharedOrigin | null }> {
  let excludedPath: string | null = null, shared: SharedOrigin | null = null;
  const exclude = purge && snapshot.page.deleted_at != null ? await syncExcludePatterns(engine) : [];
  const file = await prepareFileTarget(engine, row, snapshot, null, undefined, { ...options,
    ...(exclude.length ? { excludeTombstone: { patterns: exclude, onExcluded: (path: string) => { excludedPath = path; } } } : {}),
    sharedOrigin: { onShared: value => { shared = value; } } });
  return { file, excludedPath, shared };
}

/** #6517: the recorded-origin census of a delete's file (file-claims.ts) and the other live pages that record it. */
export interface SharedOrigin { target: FileClaimTarget; claimants: FileClaimant[] }
export const sharedOriginReceipt = (sourceId: string, survivor: string | null) => 'The selected database page is hidden; the file and the surviving page remain. This does not erase that file\'s contents. '
  + `Sync does not overwrite the surviving page with the file (#6712: a file whose page differs from it is held file_drift); import the file's current content into it with gbrain repair file-drift --source ${sourceId} --slug ${survivor ?? '<surviving-slug>'} --prefer file `
  + '(it previews and writes nothing; run the apply command it prints), then gbrain sync --source ' + sourceId + ' --no-pull. Edit the file first if it holds the deleted page\'s text.';
/**
 * #6517 [R8]: the survivor is revalidated under publication: the kept file must still resolve to the same real file and the
 * same live pages must still record it; otherwise the delete refuses and the file is never removed as a fallback.
 * [R9]: the receipt names a surviving slug only to the trusted local owner, or to a remote writer whose grant and visibility cover it.
 */
async function validateSharedOrigin(tx: BrainEngine, row: WriteRequest, shared: SharedOrigin): Promise<string> {
  let canonicalPath: string;
  try { canonicalPath = realpathSync(shared.target.path); }
  catch { throw sharedOriginChanged(row, 'the shared file was moved or removed'); }
  const claimants = await findLiveFileClaimants(tx, { ...shared.target, canonicalPath });
  if (claimants.map(page => page.id).join(',') !== shared.claimants.map(page => page.id).join(',')) throw sharedOriginChanged(row, 'the pages recording the shared file changed');
  const named: string[] = [];
  for (const page of claimants) if (await slugDisclosable(tx, row.authority, page.slug)) named.push(page.slug);
  const who = named.length ? `Another page of this source records the same file: ${named.join(', ')}.` : 'Another page of this source records the same file.';
  return `${who} ${sharedOriginReceipt(row.source_id, named.length === 1 ? named[0]! : null)}`;
}
function sharedOriginChanged(row: WriteRequest, what: string): OperationError {
  const error = pageRefusal('source_changed', `The shared canonical file changed while the delete was prepared: ${what} before it published, so nothing was written and the file was not removed. Submit the delete again with a new request_id; it re-reads the file's claimants.`, row,
    `Page ${row.slug}'s file in source ${row.source_id} was recorded by another live page when this delete was prepared.`, pageFix(row.source_id, row.slug));
  error.detail = 'shared_origin';
  return error;
}

async function assertStillSyncExcluded(tx: BrainEngine, row: WriteRequest, excludedPath: string): Promise<void> {
  if (matchesAnyGlob(excludedPath, await syncExcludePatterns(tx))) return;
  throw pageRefusal('source_changed', 'sync.exclude changed while the purge was prepared.', row,
    `${excludedPath} was excluded from sync when the purge of ${row.slug} was prepared and is not any more, so nothing was purged. Run the purge again; it re-reads the exclusion.`, pageFix(row.source_id, row.slug));
}

/** The `delete_page` preparation: soft delete, or purge with its journal sweep (#6511) run under the preparation budget. */
async function prepareDeletePageMutation(engine: BrainEngine, row: WriteRequest, snapshot: PageSnapshot | null,
  options: { activePack?: ParseOpts['activePack']; clock?: ClaimPhaseClock; allowMissingFile?: boolean }): Promise<PreparedMutation> {
  const p = row.intent!, source = { sourceId: row.source_id }, clock = options.clock;
  assertPurgeParams(p, row.authority.remote);
  if (!snapshot) throw pageRefusal('page_not_found', 'Page not found.', row,
    `Page ${row.slug} does not exist in source ${row.source_id}, so nothing was deleted. Check the slug and the source.`, pageFix(row.source_id, row.slug));
  const observedRevision = snapshot.revision;
  const purge = p.purge === true;
  const noop = !purge && snapshot.page.deleted_at != null;
  // Always-loaded core pages: a remote caller cannot delete one (owner-only).
  if (!noop) { enterClaimStep(clock, 'core_guard', undefined, 'db'); await prepareCoreGuard(engine, { row, snapshot, incoming: null }); }
  enterClaimStep(clock, 'file_target', undefined, 'fs');
  // Tombstones still own their recorded artifact. Purge always attempts its
  // removal before the guarded hard-delete and receipt commit; failure rolls
  // back to the prior row, and replay survives the eventual absence of that row.
  const { file, excludedPath, shared } = await prepareDeleteFileTarget(engine, row, snapshot, purge, { allowMissing: purge || options.allowMissingFile, deleting: true, activePack: options.activePack, remote: row.authority.remote });
  // #6517: a purge tombstones content hashes source-wide, so a page whose file another live page records is only soft-deleted.
  if (shared && purge) {
    const error = pageRefusal('source_changed', 'The page\'s canonical file is shared with another live page, so a purge (which tombstones its content source-wide) was refused and nothing was removed, tombstoned or redacted. '
      + `Soft-delete it instead (gbrain delete ${row.slug} --source-id ${row.source_id} --expected-revision <rev>): the page is hidden, the file and the surviving page remain, and nothing is erased.`, row,
      `Another live page of source ${row.source_id} records the file of ${row.slug}.`, pageFix(row.source_id, row.slug));
    error.detail = 'shared_origin';
    throw error;
  }
  // #6511: the purge's journal sweep runs here, under the preparation budget, never inside the 5 s publication transaction.
  const preparedPurge: PreparedPagePurge | null = purge ? await preparePagePurge(engine, row, snapshot, clock) : null;
  // #6948: a page merged into its duplicate holds that page's body, so an owner purge would tombstone the survivor's content.
  if (preparedPurge && !preparedPurge.retention && await isOriginTwinPage(engine, row.source_id, row.slug)) {
    const error = pageRefusal('source_changed', 'The page was merged into a duplicate that holds the same content, so a purge (which tombstones its content source-wide) was refused and nothing was removed, tombstoned or redacted. '
      + 'The 72 h retention purge removes it database-only; to erase the content itself, purge the page it was merged into.', row,
      `${row.slug} of source ${row.source_id} was merged into a duplicate page (gbrain repair origin-twins).`, pageFix(row.source_id, row.slug));
    error.detail = 'origin_twin';
    throw error;
  }
  const prepared: PreparedMutation = { observedRevision, noop, file, ...await pageDatabaseOnlyPublication(engine, row, file),
    // W1: a purge bumps sources.purge_epoch, so it holds the source row exclusively from the start (retention bumps nothing, #26);
    // the derived rows' and cascaded links' streams are locked with the page.
    ...(purge && !preparedPurge?.retention ? { sourceExclusive: true } : {}),
    // The purge mirror's `committed` line comes from the coordinator after the commit, whoever waits for the reply (#23).
    ...(preparedPurge && !preparedPurge.retention ? { afterCommit: async () => { appendPurgeCommitted(row.id); } } : {}),
    ...(preparedPurge?.derivedSlugs.length ? { additionalPageKeys: preparedPurge.derivedSlugs.map(slug => ({ sourceId: row.source_id, slug })) } : {}),
    ...(excludedPath !== null ? { databaseOnlyReason: 'sync_excluded' as const } : {}), ...(shared ? { databaseOnlyReason: 'shared_origin' as const } : {}),
    ...(shared ? { validate: async (tx: BrainEngine) => { prepared.databaseOnlyWarning = await validateSharedOrigin(tx, row, shared); } } : {}),
    apply: async tx => {
      if (purge && excludedPath !== null) await assertStillSyncExcluded(tx, row, excludedPath);
      if (preparedPurge) return purgePageInTransaction(tx, row, snapshot, preparedPurge);
      if (!noop) { await tx.createVersion(row.slug, source); await tx.softDeletePage(row.slug, source); }
      return { status: 'soft_deleted', slug: row.slug, source_id: row.source_id, noop,
        recoverable_until: 'now + 72h via restore_page (remove immediately instead: gbrain delete <slug> --purge, local CLI only)' };
    } };
  return prepared;
}

/**
 * Wave B: `restore_page` of a segmented page whose body was not read back (over the single-string ceiling). Soft
 * delete only set `deleted_at` (its body, chunks, links and projections stay), so the restore clears it without
 * re-serializing or re-importing the body: version, clear, reseal (or queue the projection when chunks are missing or a
 * deferred retirement left rows of retired occurrences).
 * Whether it reseals is decided here, before publication: both probes read one index entry per live occurrence, so on
 * a loaded host they can outlast the publication transaction's 5 s statement_timeout, and a cancelled publication is
 * prepared and its whole file streamed again. Deciding here is exact: the transaction publishes only at the observed
 * revision, so the page is still soft-deleted at the same body generation, and a deleted page gains no chunk rows
 * (its projection skips it) and loses only rows its live generation does not hold.
 * The canonical file is serializePageToMarkdown's bytes streamed from the segments by export's serializer into one
 * buffer, never one string. The restore adds no text, so an agent-tier writer's advisory gate scan (flag only) is not
 * re-run over the stored body; a step that needs the whole body refuses (`page_body_segmented`): a core page's budget
 * render, and an external_untrusted writer, whose gate may quarantine or reject.
 */
async function prepareUnreadRestore(engine: BrainEngine, row: WriteRequest, snapshot: PageSnapshot,
  options: { activePack?: ParseOpts['activePack']; clock?: ClaimPhaseClock; allowMissingFile?: boolean }): Promise<PreparedMutation> {
  const source = { sourceId: row.source_id };
  const noop = snapshot.page.deleted_at == null;
  const storedTier = await storedPageTier(engine, row.source_id, row.slug);
  const trust = pageWriteTrust(row, snapshot.page.frontmatter);
  const gateTrust = pageGateTrust(row, trust, storedTier);
  if (!noop && gateTrust?.tier === 'external_untrusted' && writeGateApplies(gateTrust.tier, (await loadImportSanityConfig(engine)).writeGate ?? DEFAULT_WRITE_GATE_CONFIG)) {
    throw pageBodySegmentedError(snapshot.page, 'restore_page (the write gate scans the whole body of an external_untrusted write)');
  }
  enterClaimStep(options.clock, 'core_guard', undefined, 'db');
  const core = noop ? null : await prepareCoreGuard(engine, { row, snapshot, incoming: snapshot.page });
  enterClaimStep(options.clock, 'file_target', undefined, 'fs');
  const file = await prepareFileTarget(engine, row, snapshot, await unreadPageFile(engine, snapshot), undefined,
    { allowMissing: options.allowMissingFile, activePack: options.activePack, remote: row.authority.remote });
  const pageId = Number(snapshot.page.id);
  enterClaimStep(options.clock, 'seal_probe', undefined, 'db');
  const generation = Number(snapshot.bodyGeneration), live = noop ? [] : await engine.readManifest(pageId, { generation });
  const complete = noop || !(await occurrencesWithoutChunks(engine, pageId, generation, live)).length
    && !await hasStaleChunks(engine, pageId, generation, live.map(row => Number(row.occurrenceId)));
  const prepared: PreparedMutation = { observedRevision: snapshot.revision, noop, file, ...await pageDatabaseOnlyPublication(engine, row, file),
    ...(core ? { exclusiveSources: core.exclusiveSources } : {}), ...(trust ? { trust } : {}),
    validate: async tx => { await core?.validate(tx); },
    apply: async tx => {
      if (noop) return { ...pageNoopAdvisories(row), status: 'skipped', slug: row.slug, source_id: row.source_id, noop: true, chunks: 0, chunk_skip_reason: 'write_skipped' };
      await tx.createVersion(row.slug, source);
      await tx.restorePage(row.slug, source);
      const lowered = storedTier ? await recordAgentPageLowering(tx, row, { tier: storedTier, revision: snapshot.revision }) : null;
      if (complete) await sealSegmentedPage(tx, pageId);
      if (core) await core.record(tx, (await tx.readPageSnapshot(row.slug, source))?.revision ?? null);
      return { ...pageNoopAdvisories(row), status: 'restored', slug: row.slug, source_id: row.source_id, chunks: 0, noop: false,
        ...(complete ? {} : { projection: 'pending' }), ...await sizeStateField(tx, row.source_id, row.slug, snapshot.page),
        ...(lowered ? { trust_lowered: lowered } : {}) };
    },
    afterCommit: async target => { if (!complete) await buildSegmentedProjection(target, { sourceId: row.source_id, slug: row.slug }).catch(() => undefined); } };
  return prepared;
}
/**
 * serializePageToMarkdown's bytes for a page whose body was not read back, streamed from its segments by export's
 * serializer: measured here, produced again into the publication's staging file (large-file.ts), never concatenated.
 * A withdrawal mirror of a segmented page (effects.ts, effect-recovery.ts) renders its file the same way, with
 * `between` (its claim renewal) run after each piece each time the file is produced.
 */
export async function unreadPageFile(engine: BrainEngine, snapshot: PageSnapshot, between?: () => Promise<void>): Promise<StreamedFileContent> {
  const head = serializePageToMarkdown({ ...withoutBody(snapshot.page), compiled_truth: '', timeline: '' }, snapshot.tags).slice(0, -1);
  const ledger = snapshotLedger(snapshot);
  const produce = (exec: BrainEngine) => segmentedExportMarkdown(exec, snapshot.page, ledger, head);
  return StreamedFileContent.measure(engine, !between ? produce : async function* (exec) { for await (const piece of produce(exec)) { yield piece; await between(); } });
}

/** Work counters of segmented tag flips: `flips` applied, `hashStreams` content hashes recomputed over the segments. */
export const segmentedTagWork = { flips: 0, hashStreams: 0 };

/**
 * Wave B (spec 6.4): add_tag / remove_tag on a segmented page, at any size, as a metadata flip that reuses the live
 * manifest: the body generation, segment texts and chunks stay as they are. As the inline tag write does, it versions
 * the page (a segmented version references the live generation, O(1)), changes the tag rows, stores the new
 * content_hash and reseals a sealed page at its new revision; the canonical file is serializePageToMarkdown's bytes
 * with the new tags, streamed from the segments (unreadPageFile). The hash resumes from the last live row's midstate
 * (content-hash-stream.ts); a midstate that does not reproduce the stored hash is replaced by one pass over the segments.
 * Null when the write gate would scan the whole body (an external_untrusted writer): that write takes the put path.
 */
export async function prepareSegmentedTagMutation(engine: BrainEngine, row: WriteRequest, snapshot: PageSnapshot, tags: string[]): Promise<PreparedMutation | null> {
  const source = { sourceId: row.source_id };
  const [, pack, storedTier] = await Promise.all([assertKnowledgePublicationAllowed(engine, row),
    loadActivePackForEngine(engine, { remote: row.authority.remote, sourceId: row.source_id }).catch(() => null), storedPageTier(engine, row.source_id, row.slug)]);
  const noop = tags.length === snapshot.tags.length && tags.every(tag => snapshot.tags.includes(tag));
  const trust = pageWriteTrust(row, snapshot.page.frontmatter);
  const gateTrust = pageGateTrust(row, trust, storedTier);
  if (!noop && gateTrust && writeGateApplies(gateTrust.tier, (await loadImportSanityConfig(engine)).writeGate ?? DEFAULT_WRITE_GATE_CONFIG)
    && gateTrust.tier === 'external_untrusted') return null;
  const pageId = Number(snapshot.page.id);
  const hash = noop ? snapshot.page.content_hash : await segmentedContentHash(engine, snapshot, tags);
  const file = row.worktree_id ? await prepareFileTarget(engine, row, snapshot, await unreadPageFile(engine, { ...snapshot, tags }), undefined,
    { activePack: pack?.manifest, remote: row.authority.remote }) : undefined;
  const sealed = snapshot.page.text_projection_revision === snapshot.revision;
  return { observedRevision: snapshot.revision, noop, file, ...await pageDatabaseOnlyPublication(engine, row, file), ...(trust ? { trust } : {}),
    apply: async tx => {
      if (noop) return { ...pageNoopAdvisories(row), status: 'skipped', slug: row.slug, source_id: row.source_id, noop: true, chunks: 0, chunk_skip_reason: 'write_skipped' };
      await tx.createVersion(row.slug, source);
      for (const tag of snapshot.tags) if (!tags.includes(tag)) await tx.removeTag(row.slug, tag, source);
      for (const tag of tags) if (!snapshot.tags.includes(tag)) await tx.addTag(row.slug, tag, source);
      await tx.executeRaw('UPDATE pages SET content_hash=$2, updated_at=now() WHERE id=$1', [pageId, hash]);
      if (sealed) await sealSegmentedPage(tx, pageId);
      segmentedTagWork.flips++;
      return { ...remoteLinkHint(row), status: 'created_or_updated', slug: row.slug, source_id: row.source_id, chunks: 0, noop: false,
        searchable: isQuarantined(snapshot.page.frontmatter) ? false : sealed ? true : 'pending', ...await sizeStateField(tx, row.source_id, row.slug, snapshot.page) };
    } };
}

/** The content_hash of a segmented page with `tags`: its stored body and frontmatter, resumed from the last live manifest row's midstate. */
async function segmentedContentHash(engine: BrainEngine, snapshot: PageSnapshot, tags: string[]): Promise<string> {
  const pageId = Number(snapshot.page.id);
  const meta = { frontmatter: snapshot.page.frontmatter, tags };
  const last = (await engine.readManifest(pageId)).at(-1);
  const resumed = last ? (() => { try { return ContentHashStream.fromState(last.hashState); } catch { return null; } })() : null;
  if (resumed && resumed.finish({ frontmatter: snapshot.page.frontmatter, tags: snapshot.tags }) === snapshot.page.content_hash) return resumed.finish(meta);
  segmentedTagWork.hashStreams++;
  const stream = ContentHashStream.begin(snapshot.page);
  const decoder = new TextDecoder();
  for await (const part of readSegmentedBody(engine, pageId, snapshot.page.source_id)) {
    if (part.region === 'truth') stream.pushTruth(decoder.decode(part.bytes)); else stream.pushTimeline(decoder.decode(part.bytes));
  }
  return stream.finish(meta);
}

/**
 * Providers and parsing run before the OS lock and before any publication transaction.
 * `coordinated`: the caller publishes this mutation itself through the coordinator, whose
 * page guard and revision check on `row.slug` cover this import (the put_page apply diet).
 */
/**
 * `options.clock` (#6278): the claim's phase clock; each await boundary names its step through `enterClaimStep`, and the
 * preparation's raw reads run bounded by its remaining budget (`boundedReads`; a statement carrying the foreground `signal` keeps it).
 */
export async function preparePageMutation(unbounded: BrainEngine, row: WriteRequest, _config: GBrainConfig,
  preparedIntent?: { content: string; expectedRevision: string; tags?: string[] }, signal?: AbortSignal,
  options: { allowMissingFile?: boolean; coordinated?: boolean; clock?: ClaimPhaseClock } = {}): Promise<PreparedMutation> {
  signal?.throwIfAborted();
  const clock = options.clock;
  const engine = boundedReads(unbounded, clock);
  enterClaimStep(clock, 'page_snapshot', undefined, 'db');
  if (!row.intent) throw pageRefusal('storage_error', 'A pending write lost its normalized intent.', row,
    `The request has no stored intent for ${row.slug} (its payload was compacted or never recorded), so it cannot be published and wrote nothing.`);
  const p = row.intent;
  const source = { sourceId: row.source_id };
  // A coordinated (single-write) preparation sends its independent reads together; the first refusal in this order is reported.
  const together = options.coordinated ? engine : { kind: 'sequential' };
  const [, stored, pack] = await pipelined(together, [
    () => assertKnowledgePublicationAllowed(engine, row),
    () => engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true }),
    () => loadActivePackForEngine(engine, { remote: row.authority.remote, sourceId: row.source_id }).catch(() => null),
  ]) as [unknown, PageSnapshot | null, Awaited<ReturnType<typeof loadActivePackForEngine>> | null];
  // Wave B: a segmented page within the single-string ceiling is compared and merged as strings.
  const snapshot = await materializedSnapshot(unbounded, stored);
  signal?.throwIfAborted();
  enterClaimStep(clock, 'revision_check');
  assertPageRevision(snapshot, preparedIntent ? { expectedRevision: preparedIntent.expectedRevision } : engineMutationPrecondition(parseMutationPrecondition(p)));
  if ((snapshot?.page.id ?? null) !== row.page_id) throw pageIdentityError(snapshot != null || row.page_id === null, 'The accepted page identity changed.');
  const observedRevision = snapshot?.revision ?? null;
  const activePack = pack?.manifest;
  if (row.operation === 'put_page' && snapshot && !snapshot.page.deleted_at && typeof p.content === 'string'
    && `${snapshot.page.compiled_truth}\n${snapshot.page.timeline ?? ''}`.trim()) {
    const incoming = parseMarkdown(p.content, row.slug, { activePack });
    if (!preparedIntent && row.authority.remote) assertLargePageReplacement(row.slug, row.source_id, p, snapshot, incoming);
    if (p.allow_empty !== true && !`${incoming.compiled_truth}\n${incoming.timeline ?? ''}`.trim()) {
      throw new OperationError('invalid_params', `Refusing to overwrite existing non-empty page '${row.slug}' with empty content. Use capture --file PATH --slug SLUG for file input; set allow_empty:true to intentionally clear it.`,
        'Use capture --file PATH --slug SLUG for file input, or pass allow_empty:true with the expected revision to intentionally clear it.');
    }
  }
  if (row.operation === 'delete_page') return prepareDeletePageMutation(engine, row, snapshot, { activePack, clock, allowMissingFile: options.allowMissingFile });
  // #6188: a trusted local fence repair's receipt (admission refuses it from every other caller) rides the outcome and the file's commit.
  const fenceRepair = row.operation === 'put_page' && !row.authority.remote ? parseFenceRepairReceipt(p.fence_repair) : null;
  const fenceRepairOutcome = fenceRepair ? { fence_repair: fenceRepair } : {};
  // #5616: edits apply to the caller's view of the locked snapshot (revision checked above).
  const edited = row.operation === 'edit_page' ? editLockedPage(row, snapshot) : undefined;
  let content = edited?.content ?? preparedIntent?.content ?? p.content as string;
  let versionTags: string[] | undefined = preparedIntent?.tags;
  // A replacement/restore publishes a live page. Only a recorded version may
  // explicitly restore a tombstone; legacy versions leave this state unchanged.
  let targetDeleted = false;
  if (row.operation === 'restore_page' || row.operation === 'revert_version') {
    if (!snapshot) throw pageRefusal('page_not_found', 'Page not found.', row,
      `Page ${row.slug} does not exist in source ${row.source_id} (it was purged or never written), so nothing was ${row.operation === 'restore_page' ? 'restored' : 'reverted'}. Check the slug and the source.`,
      pageFix(row.source_id, row.slug));
    if (row.operation === 'restore_page' && bodyUnread(snapshot.page)) return prepareUnreadRestore(engine, row, snapshot, { activePack, clock, allowMissingFile: options.allowMissingFile });
    let page = snapshot.page;
    let tags = snapshot.tags;
    if (row.operation === 'revert_version') {
      const [version] = await engine.executeRaw<PageVersion>(
        'SELECT * FROM page_versions WHERE id=$1 AND page_id=$2', [p.version_id, page.id]);
      if (!version) throw pageRefusal('not_found', 'Version not found for this page.', row,
        `Version ${String(p.version_id)} is not in the history of page ${row.slug}, so nothing was reverted. List the page's versions (get_versions; CLI: gbrain history) and revert to one of them.`);
      if (version.body_storage === 'segmented' || isSegmentedPage(page)) throw segmentedRevertRefusal(row.slug, p.version_id);
      targetDeleted = version.is_deleted ?? (snapshot.page.deleted_at != null);
      page = { ...page, compiled_truth: version.compiled_truth, frontmatter: version.frontmatter,
        ...(version.timeline !== null && version.timeline !== undefined ? { timeline: version.timeline } : {}),
        ...(version.title !== null && version.title !== undefined ? { title: version.title } : {}),
        ...(version.type !== null && version.type !== undefined ? { type: version.type } : {}) };
      if (version.tags !== null && version.tags !== undefined) tags = version.tags;
      versionTags = tags;
    }
    content = serializePageToMarkdown(page, tags);
  }
  if (row.authority.remote && row.operation !== 'remember' && !row.operation.startsWith('takes_') && typeof content==='string') {
    const parsed=parseMarkdown(content,row.slug,{ activePack });
    const compiled_truth=preserveProtectedTakes(parsed.compiled_truth,snapshot?.page.compiled_truth??'');
    const timeline=preserveProtectedTakes(parsed.timeline??'',snapshot?.page.timeline??'');
    if (compiled_truth!==parsed.compiled_truth || timeline!==(parsed.timeline??'')) content=serializePageToMarkdown({
      ...(snapshot?.page??{id:0,source_id:row.source_id,created_at:new Date(),updated_at:new Date()}),...parsed,compiled_truth,timeline},parsed.tags);
  }
  // Core marking is owner-only: a remote write that omits always_load or
  // core_priority keeps the stored values instead of silently un-coring the page.
  if (row.authority.remote && snapshot && !snapshot.page.deleted_at && typeof content === 'string'
    && (snapshot.page.frontmatter?.always_load !== undefined || snapshot.page.frontmatter?.core_priority !== undefined)) {
    const parsed = parseMarkdown(content, row.slug, { activePack });
    const carried = carryCoreMarking(snapshot.page.frontmatter, parsed.frontmatter ?? {});
    if (carried.always_load !== parsed.frontmatter?.always_load || carried.core_priority !== parsed.frontmatter?.core_priority) {
      content = serializePageToMarkdown({ ...snapshot.page, ...parsed, frontmatter: carried }, parsed.tags);
    }
  }
  const projected = !(row.operation === 'remember' || row.operation.startsWith('takes_') || (row.operation === 'extract_facts' && p.kind === 'managed_facts_entity'));
  const writer = (row.operation === 'put_page' || row.operation === 'edit_page') && p.kind !== 'managed_maintenance_page'
    && (preparedIntent !== undefined || typeof p.expected_revision === 'string') ? 'editing' : 'preserving';
  // #5969 (D3): only an ordinary put_page intent carries a timeline section; every other writer keeps the shared policy.
  const timelinePolicy = row.operation === 'put_page' ? timelineWritePolicy(p, row.authority.remote, writer) : undefined;
  enterClaimStep(clock, 'timeline_policy', undefined, 'db');
  if (timelinePolicy && typeof content === 'string') await assertTimelineNotOmitted(engine, { intent: p, remote: row.authority.remote, writer,
    slug: row.slug, sourceId: row.source_id, content, prior: snapshot });
  // #5567: database-only timeline rows are written back into the page before
  // the no-op check, digest, rendering and chunking see the body.
  if (projected && snapshot && typeof content === 'string') {
    const parsed = parseMarkdown(content,row.slug);
    enterClaimStep(clock, 'materialize_timeline', undefined, 'db');
    const { timeline, materialized } = await materializeTimeline(engine,parsed,row.slug,snapshot,writer,timelinePolicy);
    if (materialized) content = serializePageToMarkdown({...snapshot.page,...parsed,timeline,type:parsed.typeExplicit ? parsed.type : snapshot.page.type},parsed.tags);
  }
  const storedTier = snapshot ? await storedPageTier(engine, row.source_id, row.slug) : null;
  // Detect an exact canonical no-op before ingestion can invoke any provider.
  // Revision/identity checks above still apply to stale identical replacements.
  if (snapshot && (snapshot.page.deleted_at != null) === targetDeleted && typeof content === 'string') {
    const incoming = parseMarkdown(content,row.slug,{ activePack });
    resolveParsedSubtype(incoming, snapshot.page);
    const tags = versionTags ?? [...new Set([...snapshot.tags,...incoming.tags])].sort();
    if (digest(canonical(snapshot.page,snapshot.tags)) === digest(canonical(incoming,tags))) {
      const file=await prepareFileTarget(engine,row,snapshot,targetDeleted ? null : serializePageToMarkdown(snapshot.page,snapshot.tags),undefined,{ activePack, remote: row.authority.remote });
      return {observedRevision,noop:true,file,...await pageDatabaseOnlyPublication(engine,row,file),
        apply:async()=>({...pageNoopAdvisories(row),status:'skipped',slug:row.slug,source_id:row.source_id,noop:true,chunks:0,chunk_skip_reason:'write_skipped',
          ...(row.operation==='capture'?{channel:'capture',content_hash:p.capture_hash}:{}),...fenceRepairOutcome})};
    }
  }
  let prepared: PreparedContentImport | undefined;
  let provenance: CanonicalProvenance | undefined;
  let suppliedTrustMarker: unknown;
  // #5575: the page's tier, computed once before import so the write gate sees exactly it (ENG-18).
  const trust = pageWriteTrust(row, typeof content === 'string' && !isFenceEditWrite(row) ? parseMarkdown(content, row.slug, { activePack }).frontmatter : null);
  const gateTrust = pageGateTrust(row, trust, storedTier);
  // The apply diet: the publisher's locked read of row.slug is the import base, and one read after the
  // last page write serves the read-back check, the seal, the core notice and the receipt (as sync does).
  const lean = options.coordinated === true && !targetDeleted && row.operation !== 'restore_page' && !versionTags;
  enterClaimStep(clock, 'import_content', undefined, 'db');
  const result = await importFromContent(engine, row.slug, content, {
    ...source, noEmbed: true, remote: row.authority.remote, activePack, fences: projected ? 'coordinated' : 'lenient', coordinated: lean,
    segmentedOwner: { kind: row.operation === 'edit_page' ? 'edit' : 'put', principalKind: row.principal_kind, principalId: row.principal_id, baseRevision: observedRevision },
    ...(lean ? { existingSnapshot: snapshot } : {}),
    // #6259: only owner-tier intents keep gate-owned markers; an ordinary put_page, local or remote, has them stripped.
    preserveGateMarkers: !row.authority.remote && (p.kind === 'managed_maintenance_page' || p.kind === 'managed_quarantine_clear'),
    forceRechunk: row.operation === 'restore_page' || row.operation === 'revert_version',
    allowEmptyOverwrite: p.allow_empty === true || row.operation === 'restore_page' || row.operation === 'revert_version',
    source_kind: typeof p.source_kind === 'string' ? p.source_kind : null,
    source_uri: typeof p.source_uri === 'string' ? p.source_uri : null,
    ingested_via: typeof p.ingested_via === 'string' ? p.ingested_via : null,
    ...(gateTrust ? { writeGate: gateInput(gateTrust, row.id) } : {}),
    // Provenance compares the caller's page with the stored one, so it runs before the server's trust marker is stamped.
    prepareFrontmatter: page => {
      provenance = putProvenance(row, snapshot, page);
      suppliedTrustMarker = page.frontmatter.trust_tier;
      stampPageTrustMarker(row, page.frontmatter, trust, storedTier);
    },
    prepare: async value => { prepared = value; return value.result; },
  }).catch(error => {
    if (!(error instanceof ContentSanityBlockError)) throw error;
    throw contentRefusalError({ code: 'content_rejected', message: error.message },
      'The operator set content_sanity.junk_disposition to reject, so this content refuses on every retry. Remove the matched junk and submit the corrected content with a new request_id.');
  });
  signal?.throwIfAborted();
  if (!prepared) {
    // A remote caller's refusal names the line, never a key: keys can be private, and the receipt keeps the message.
    const refusal = result.refusal && row.authority.remote && result.refusal.code === 'invalid_frontmatter'
      ? { ...result.refusal, key: undefined, message: frontmatterHoldMessageWithoutKeys(result.refusal.message) } : result.refusal;
    if (refusal?.code === 'file_too_large') throw contentRefusalError(refusal, PAGE_OVER_LIMIT_SUGGESTION, { legacy_error: 'request_too_large' });
    if (refusal?.code === 'invalid_fence') throw contentRefusalError(refusal, `Page ${row.slug} was not written. Fix ${fenceWhere(refusal.fence)} as the message says (fence_issues lists every row and column; use the allowed values), `
      + 'or write facts with remember and takes with takes_add instead of a hand-built table, then submit the corrected content with a new request_id.', { legacy_error: 'invalid_params' });
    if (refusal) throw contentRefusalError(refusal, `Correct ${refusal.line !== undefined ? `frontmatter line ${refusal.line}${refusal.key ? ` (key "${refusal.key}")` : ''}` : 'the frontmatter'}: one line per key with its whole value quoted, then submit the corrected content with a new request_id.`,
      { legacy_error: 'invalid_params' });
    throw opError('invalid_params', 'The content was rejected before publication.', 'Check the content and frontmatter, then submit the corrected content with a new request_id.');
  }
  const ready = prepared;
  if (ready.observedRevision !== observedRevision) throw pageRefusal('revision_conflict', 'The page changed during import preparation.', row,
    `Page ${row.slug} was written by another request while this one was being prepared, so it published nothing. Read the current page and revision, then submit the intended change against it.`,
    pageFix(row.source_id, row.slug));
  if (ready.slug !== row.slug) {
    await authorizeWrite(engine, row.authority, row.operation, ready.slug);
    const duplicate = await engine.readPageSnapshot(ready.slug, { ...source, excludePrivate: row.authority.remote });
    if (!duplicate) throw pageRefusal('permission_denied', 'The duplicate is not readable by this writer.', row,
      `The content duplicates another page in source ${row.source_id} that this writer cannot read, so nothing was published. Write it under a different slug, or ask the user to make the write from a writer that can read the existing page.`);
    return { observedRevision, noop: true, additionalPageKeys:[{sourceId:row.source_id,slug:ready.slug}],validate: async tx => {
      await authorizeWrite(tx,row.authority,row.operation,ready.slug,true);
      const current=await tx.readPageSnapshot(ready.slug,{...source,excludePrivate:row.authority.remote});
      if (!current || current.page.id!==duplicate.page.id || current.revision!==duplicate.revision) throw pageRefusal('revision_conflict','The read-only duplicate changed during preparation.', row,
        `Page ${ready.slug}, which this content duplicates, changed while the write was being prepared, so nothing was published. Read it, then submit the write again if it is still needed.`,
        pageFix(row.source_id, ready.slug));
    },
      apply: async () => ({ status: 'duplicate', slug: duplicate.page.slug, duplicate_revision: duplicate.revision }) };
  }
  const tags = versionTags ?? [...new Set([...(snapshot?.tags ?? []), ...ready.parsedPage.tags])].sort();
  const renderedPage: Page = { ...(snapshot?.page ?? { id: 0, slug: row.slug, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }), ...ready.parsedPage };
  const rendered = serializePageToMarkdown(renderedPage, tags);
  // CEO-21: the server-stamped trust marker alone never makes a write: unchanged as stamped or as the caller sent it.
  const callerPage = { ...ready.parsedPage, frontmatter: suppliedTrustMarkerView(ready.parsedPage.frontmatter, suppliedTrustMarker) };
  const logicalNoop = snapshot !== null && [ready.parsedPage, callerPage].some(page => digest(canonical(snapshot.page, snapshot.tags)) === digest(canonical(page, tags)));
  const noop = logicalNoop && (snapshot?.page.deleted_at != null) === targetDeleted;
  const ordinaryPage = ['put_page','capture','restore_page','revert_version','edit_page'].includes(row.operation);
  // A managed maintenance page (e.g. the dream write-back after grounding
  // quarantine) republishes a body; its automatic links follow that body.
  const autoLinkedPage = ordinaryPage || p.kind === 'managed_maintenance_page';
  const capture = row.operation === 'capture' && typeof p.capture_path === 'string' && typeof p.capture_file_hash === 'string'
    ? { path: p.capture_path, hash: p.capture_file_hash } : undefined;
  // Projections, advisories, link resolution (links-preparation.ts), the file target and the core guard go out together.
  enterClaimStep(clock, 'link_resolution', undefined, 'db');
  const [project, advisories, links, target, core] = await pipelined(together, [
    async () => projected ? prepareCanonicalProjections(engine,ready.parsedPage,row.slug,row.source_id,snapshot,writer,timelinePolicy) : undefined,
    async () => noop || targetDeleted ? pageNoopAdvisories(row) : !ordinaryPage ? remoteLinkHint(row) : preparePageAdvisories(engine,row,ready.parsedPage,snapshot),
    async () => !noop && !targetDeleted && autoLinkedPage && (row.authority.autoLinkTrusted ?? !row.authority.remote) && await isAutoLinkEnabled(engine)
      ? prepareAutomaticLinks(engine,row.slug,ready.parsedPage,row.source_id,options.coordinated === true) : undefined,
    () => prepareFileTarget(engine, row, snapshot, targetDeleted ? null : rendered, undefined, { capture, allowMissing: options.allowMissingFile, activePack, remote: row.authority.remote }),
    // Always-loaded core tier: owner-only marking, brain-wide budget, remote-edit policy (core-guard.ts).
    async () => noop ? null : prepareCoreGuard(engine, { row, snapshot, incoming: targetDeleted ? null : ready.parsedPage }),
  ]) as [Awaited<ReturnType<typeof prepareCanonicalProjections>> | undefined, Record<string, unknown>,
    Awaited<ReturnType<typeof prepareAutomaticLinks>> | undefined, PreparedMutation['file'], Awaited<ReturnType<typeof prepareCoreGuard>> | null];
  // #6188 (D12): what Tier 1 rewrote; a remote caller is never told about the takes fence it cannot read (preserved verbatim).
  const shownFixes = (ready.result.fences_normalized ?? []).filter(fix => !row.authority.remote || fix.fence !== 'takes');
  const fencesNormalized = shownFixes.length ? { fences_normalized: pageFencesNormalized({ sourceId: row.source_id, slug: row.slug, fixes: shownFixes,
    writer: row.principal_kind, path: snapshot?.page.source_path ?? null, remote: row.authority.remote }) } : {};
  const file = target && fenceRepair ? { ...target, commit: fenceRepairCommit(relative(target.root, target.path).split(sep).join('/'), fenceRepair.classes, fenceRepair.tier) } : target;
  enterClaimStep(clock, 'publication_mode', undefined, 'db');
  const [mintMode, databaseOnly] = await pipelined(together, [
    async () => file && !snapshot?.page.source_path ? scannerSlugRootMode(engine, row.source_id, file.root) : undefined,
    () => pageDatabaseOnlyPublication(engine, row, file),
  ]) as [Awaited<ReturnType<typeof scannerSlugRootMode>> | undefined, Pick<PreparedMutation, 'databaseOnlyReason'>];
  const sourcePath = file && mintMode ? scannerSourcePath(file.root, file.path, mintMode) : undefined;
  // An inferred mode is pinned with the first origin it mints, so later pages cannot flip the inference (#5610).
  const pinMode = sourcePath && mintMode && scannerSourcePath(file!.root, file!.root) && !await readSlugRootMode(engine, row.source_id) ? mintMode : undefined;
  const publication: PreparedMutation = { observedRevision, noop, additionalPageKeys:links?.pageKeys, file, ...databaseOnly,
    ...(core ? { exclusiveSources: core.exclusiveSources } : {}), ...(trust ? { trust } : {}), ...(ready.afterCommit ? { afterCommit: ready.afterCommit } : {}),
    validate: async tx => { await ready.validate(tx); await core?.validate(tx); }, apply: async (tx, preimage) => {
    let autoLinks: Awaited<ReturnType<NonNullable<typeof links>['apply']>> | undefined;
    let removedTimeline: TimelineRowsRemoved | null = null;
    let lowered: { proposal_ref: string } | null = null;
    let contested: string[] = [];
    let projectionPending = false;
    let segmentedWrite = false;
    if (!noop) {
      const prior = snapshot ? await storedPageTier(tx, row.source_id, row.slug) : null;
      // ENG-1: a managed fence edit keeps the page's tier; CEO-12: an agent rewrite that lowers a page files a queue item.
      const applied = await (isFenceEditWrite(row) ? withTrustKeep(tx, ['pages'], () => ready.apply(tx, lean ? preimage : undefined)) : ready.apply(tx, lean ? preimage : undefined));
      projectionPending = applied?.segmented?.complete === false;
      segmentedWrite = applied?.segmented !== undefined;
      lowered = prior ? await recordAgentPageLowering(tx, row, { tier: prior, revision: snapshot!.revision }) : null;
      // Mandatory metadata shares publication rollback; exact no-ops never heal it. These, and the
      // projections (facts, takes, timeline rows of the page the import just wrote live), are independent and sent together.
      const [, pinned] = await pipelined(tx, [
        async () => { if (sourcePath && !snapshot?.page.source_path) await bindOrigin(tx, { sourceId: row.source_id, slug: row.slug, sourcePath, onlyIfUnset: true }); },
        async () => pinMode ? (await tx.executeRaw<{ mode: string | null }>(`UPDATE sources SET config=CASE WHEN config->>'slug_root_mode' IS NULL
          THEN jsonb_set(${SOURCE_CONFIG_OBJECT_SQL},'{slug_root_mode}',to_jsonb($2::text)) ELSE config END WHERE id=$1 RETURNING config->>'slug_root_mode' AS mode`,
        [row.source_id, pinMode]))[0] : undefined,
        async () => { if (provenance) await tx.executeRaw(`UPDATE pages SET source_kind=$3,ingested_via=$4,ingested_at=$5::timestamptz
          WHERE source_id=$1 AND slug=$2`, [row.source_id, row.slug, provenance.source_kind, provenance.ingested_via, provenance.ingested_at]); },
        async () => { if (lean) ({ removedTimeline, contested } = projectedRows(await project?.(tx, applied?.pageId))); },
      ]) as [unknown, { mode: string | null } | undefined, unknown, unknown];
      if (pinMode && pinned?.mode !== pinMode) throw pageRefusal('revision_conflict', 'The source slug-root mode changed during preparation.', row,
        `Another write pinned source ${row.source_id}'s slug-root mode while ${row.slug} was being prepared, so this publication rolled back. Once the request is final, submit the write again; it is prepared under the pinned mode.`);
      if (row.operation === 'restore_page') await tx.restorePage(row.slug, source);
      if (versionTags) {
        for (const tag of snapshot!.tags) if (!versionTags.includes(tag)) await tx.removeTag(row.slug, tag, source);
        for (const tag of versionTags) await tx.addTag(row.slug, tag, source);
      }
      // #6007: the page the import just wrote live is the page the projections describe; no re-read.
      if (!lean) ({ removedTimeline, contested } = projectedRows(await project?.(tx, row.operation === 'restore_page' ? undefined : applied?.pageId)));
      autoLinks = await links?.apply(tx);
      if (lean) {
        const final = await tx.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
        const live = final && final.page.deleted_at == null ? final : null;
        await verifyPageReadable(tx, row.slug, ready.contentHash!, row.source_id, 'importFromContent', live?.page ?? null);
        if (applied?.segmented) { if (applied.segmented.complete && live) await sealSegmentedPage(tx, Number(live.page.id)); }
        else if (applied?.chunkerSeal !== undefined) await sealImportedPage(tx, row.slug, row.source_id, live, applied.chunkerSeal, applied.pageId);
        else if (live) await sealPageTextProjection(tx, row.slug, row.source_id, live);
        if (core) await core.record(tx, final?.revision ?? null);
        publication.postimage = final;
      } else {
        if (targetDeleted) await tx.softDeletePage(row.slug, source);
        // Index installation and terminal receipt share this transaction. The import sealed the projection
        // as its last revision-changing step; only a later revision change (restore, tags, links, delete) reseals.
        if (applied?.segmented) { if (applied.segmented.complete && applied.pageId !== undefined) await sealSegmentedPage(tx, applied.pageId); }
        else if (!(applied?.sealed && row.operation !== 'restore_page' && !versionTags && !links && !targetDeleted)) await sealPageTextProjection(tx, row.slug, row.source_id);
        if (core) await core.record(tx, (await tx.readPageSnapshot(row.slug, source))?.revision ?? null);
      }
    }
    const coreUsage = core?.usage();
    const gate = noop ? undefined : gateField(ready.result.gate, `p:${row.source_id}/${row.slug}`, null);
    // #6722: a large or embed_skip page says what this write left its embedding in.
    const sizeState = noop ? {} : await sizeStateField(tx, row.source_id, row.slug, ready.parsedPage);
    return { ...advisories, ...(autoLinks ? {auto_links:autoLinks} : {}), ...(coreUsage ? { core: coreUsage } : {}),
      ...(removedTimeline ? { timeline_rows_removed: timelineRowsRemovedAdvisory(row, removedTimeline) } : {}),
      status: noop ? 'skipped' : row.operation === 'restore_page' ? 'restored' : row.operation === 'revert_version' ? 'reverted' : 'created_or_updated',
      slug: row.slug, source_id: row.source_id, chunks: ready.result.chunks, noop, ...(projectionPending ? { projection: 'pending' } : {}),
      // Wave B: whether search sees a segmented write at commit; a pending one is re-read whenever its receipt is served (searchable.ts).
      ...(segmentedWrite ? { searchable: isQuarantined(ready.parsedPage.frontmatter) ? false : projectionPending ? 'pending' : true } : {}),
      ...sizeState,
      ...(ready.result.chunks === 0 && !projectionPending ? {chunk_skip_reason: noop ? 'write_skipped'
        : isEmbedSkipped(ready.parsedPage.frontmatter) || isQuarantined(ready.parsedPage.frontmatter) ? 'embed_skip' : 'empty_body'} : {}),
      // #6259: say the gate hid the page, not only why it has no chunks.
      ...(!noop && quarantineOutcome(ready.parsedPage.frontmatter) ? { quarantined: quarantineOutcome(ready.parsedPage.frontmatter) } : {}),
      ...(row.operation === 'capture' ? { channel: 'capture', content_hash: p.capture_hash } : {}),
      ...(edited ? editDiff(row.slug, edited.before, edited.after) : {}), ...fencesNormalized, ...fenceRepairOutcome,
      ...(lowered ? { trust_lowered: lowered } : {}), ...(gate ? { gate } : {}),
      // DX-1: a guarded supersession reports contested (the first proposal; every one when the write contested several rows).
      ...(contested.length ? { contested: { proposal_ref: contested[0], ...(contested.length > 1 ? { proposal_refs: contested } : {}) } } : {}) };
  } };
  return publication;
}

/** What a page's projections report back: removed timeline rows and the contested proposal refs (#5575 guarded supersession). */
function projectedRows(projected: { timelineRowsRemoved?: TimelineRowsRemoved | null; contested?: string[] } | undefined): { removedTimeline: TimelineRowsRemoved | null; contested: string[] } {
  return { removedTimeline: projected?.timelineRowsRemoved ?? null, contested: projected?.contested ?? [] };
}

function editLockedPage(row: WriteRequest, snapshot: PageSnapshot | null) {
  if (!snapshot || snapshot.page.deleted_at) throw pageRefusal('page_not_found', 'Page not found.', row,
    `Page ${row.slug} does not exist in source ${row.source_id} or is deleted, so the edit changed nothing. If it is soft-deleted, restore it with restore_page; otherwise write it whole with put_page.`,
    pageFix(row.source_id, row.slug));
  return applyPageEdits(snapshot.page, snapshot.tags, row.authority.remote, parsePageEdits(row.intent?.edits));
}
