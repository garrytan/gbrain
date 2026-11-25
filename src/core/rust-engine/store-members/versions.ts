/**
 * Page version members (BrainEngine createVersion, getVersions, the change-reason pair readLatestVersionId and
 * stampVersionChangeReason, readLatestVersionIdAtTier, the purged-change-reasons pair listVersionsByChangeReason and
 * replaceVersionChangeReasons and the redacted-facts body read listRetainedVersionBodies, engine-sql/version-reasons.ts, the
 * overwritten-edits reads listOverwriteCandidates, listVersionsAfter, listOverwriteLivePages and readVersionContent,
 * engine-sql/overwrite-reads.ts, and the holding-page cap pruneHoldingPageVersions,
 * engine-sql/version-prune.ts). A segmented page's snapshot references its body
 * generation and keeps content_hash, as insertSegmentedVersion does. A version keeps the reason a write stamped on it:
 * getVersions reads it as `replaced_because` (the trusted read; `excludePrivate` is refused). `revertToVersion` is not
 * served: it reads pages through raw SQL. readPageVersionRow is the version row `revert_version` reverts to.
 */
import type { PageVersion, GetVersionsOpts, PageVersionRows } from '../../page-state/version-types.ts';
import type { VersionHistory } from '../../page-state/versions.ts';
import type { VersionReasonRow } from '../../engine-sql/version-reasons.ts';
import type { OverwriteCandidateRow, OverwriteContentRow, OverwriteLiveRow, OverwriteVersionRow } from '../../engine-sql/overwrite-reads.ts';
import { toCreatedVersion, toVersion } from '../store-codec.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';
import type { PageSnapshot } from '../../page-state/types.ts';
import { isSegmentedPage } from '../../page-body/page-shape.ts';
import type { PurgeVersionBodyQuery, PurgeVersionBodyRow } from '../../engine-sql/segmented-purge-writes.ts';
import { storeErrorCode } from '../store-errors.ts';

function requireInteger(member: string, name: string, value: number): void {
  if (!Number.isSafeInteger(value)) refuseMember(member, `a ${name} that is not an integer`);
}

/**
 * The fields of the caller's page read (`createPageVersion`'s `preimage`) that the version takes: a fact purge reads the
 * page, then versions it after its generation flip, so the store versions the read revision and metadata (and, on an
 * inline page, the read body) rather than the page as it stands.
 */
function preimageFields(preimage: PageSnapshot) {
  const { page } = preimage;
  // A segmented page's body columns guard against a whole-body read; its version references the live generation instead.
  const body = isSegmentedPage(page) ? { compiledTruth: null, timeline: null } : { compiledTruth: page.compiled_truth ?? null, timeline: page.timeline ?? null };
  return { revision: preimage.revision, title: page.title, type: page.type, frontmatter: page.frontmatter ?? {}, tags: preimage.tags,
    ...body, sourcePath: page.source_path ?? null, deleted: page.deleted_at != null };
}

/**
 * `reason` is served (a null one is none), and so is `historyGap` (the page records `version_history_gap_at` first), and
 * `preimage` (preimageFields: the caller's own read of the page, which the store versions instead of the page as it stands).
 * A Git-sourced reason (`reasonSource`) is served: the store drops a non-empty reason whose (commit, path) a purge
 * tombstoned for the source, in the same write, as stampableReason does. The store prunes the page's history after the snapshot as
 * `createPageVersion` does (rust/crates/gbrain-store/src/version_prune.rs). A segmented page is refused (the store
 * answers `invalid_state` before it writes): PGLite versions it as a reference to its live body generation, which the
 * Rust store does not keep.
 */
export const createVersion: StoreMember<[slug: string, opts?: { sourceId?: string } & VersionHistory & { preimage?: PageSnapshot }], PageVersion> = async (brain, slug, opts) => {
  const scope = takeOptions('createVersion', opts && opts.reason === null ? { ...opts, reason: undefined } : opts, ['sourceId', 'reason', 'reasonSource', 'historyGap', 'preimage']);
  if (scope.preimage) scope.preimage = preimageFields(scope.preimage as PageSnapshot);
  return toCreatedVersion(await storeCall({ member: 'createVersion', slug, sourceId: scope.sourceId as string | undefined },
    () => brain.createVersion(slug, scope)));
};

export const getVersions: StoreMember<[slug: string, opts?: GetVersionsOpts<boolean>], PageVersionRows<boolean>> = async (brain, slug, opts) => {
  // The SQL reads only these five options; the rest of the read policy the MCP tool passes changes nothing there.
  const scope = takeOptions('getVersions', opts, ['sourceId', 'sourceIds', 'limit', 'includeBody', 'excludePrivate'],
    ['requireSafeChunks', 'minTrust', 'suppressFlagged', 'takesHoldersAllowList']);
  // The page policy judges the page; the store judges each version by the same identity, grant and flags.
  const excludePrivate = storePagePolicy('getVersions', scope.excludePrivate, { callerReaders: true }) ?? null;
  const rows: PageVersion[] = await storeCall({ member: 'getVersions', slug }, () => brain.getVersions(slug, { ...scope, excludePrivate }));
  return rows.map((row) => toVersion(row)) as PageVersionRows<boolean>;
};

export const readLatestVersionId: StoreMember<[pageId: number], number | null> = async (brain, pageId) => {
  const member = 'readLatestVersionId';
  requireInteger(member, 'page id', pageId);
  return storeCall({ member }, () => brain.readLatestVersionId(pageId));
};

/** GST-2497: the holding-page version cap the fence fact append runs (engine-sql/version-prune.ts); answers how many it deleted. */
export const pruneHoldingPageVersions: StoreMember<[pageId: number], number> = async (brain, pageId) => {
  const member = 'pruneHoldingPageVersions';
  requireInteger(member, 'page id', pageId);
  return storeCall({ member }, () => brain.pruneHoldingPageVersions(pageId));
};

/** The page's newest version id stamped with `tier`, or null (engine-sql/version-reasons.ts readLatestVersionIdAtTier). */
export const readLatestVersionIdAtTier: StoreMember<[pageId: number, tier: string], number | null> = async (brain, pageId, tier) => {
  const member = 'readLatestVersionIdAtTier';
  requireInteger(member, 'page id', pageId);
  if (typeof tier !== 'string') refuseMember(member, 'a tier that is not text');
  return storeCall({ member }, () => brain.readLatestVersionIdAtTier(pageId, tier));
};

export const stampVersionChangeReason: StoreMember<[spec: { pageId: number; afterVersionId: number; reason: string }], number> = async (brain, spec) => {
  const member = 'stampVersionChangeReason';
  requireInteger(member, 'page id', spec.pageId);
  requireInteger(member, 'version id', spec.afterVersionId);
  if (typeof spec.reason !== 'string') refuseMember(member, 'a reason that is not text');
  return storeCall({ member }, () => brain.stampVersionChangeReason({ pageId: spec.pageId, afterVersionId: spec.afterVersionId, reason: spec.reason }));
};

/** The source's versions whose change reason is one of `reasons`, by id (repair_versions.rs). */
export const listVersionsByChangeReason: StoreMember<[sourceId: string, reasons: readonly string[]], VersionReasonRow[]> = async (brain, sourceId, reasons) => {
  const member = 'listVersionsByChangeReason';
  if (reasons.some(reason => typeof reason !== 'string')) refuseMember(member, 'a reason that is not text');
  const rows: VersionReasonRow[] = await storeCall({ member }, () => brain.listVersionsByChangeReason({ sourceId, reasons: [...reasons] }));
  return rows.map(row => ({ id: Number(row.id), slug: row.slug, source_path: row.source_path ?? null, reason: row.reason }));
};

/** Sets `replacement` on each named version still holding its named reason; the ids set, by id (repair_versions.rs). */
export const replaceVersionChangeReasons: StoreMember<[sourceId: string, rows: ReadonlyArray<{ id: number; reason: string }>, replacement: string], number[]> =
  async (brain, sourceId, rows, replacement) => {
    const member = 'replaceVersionChangeReasons';
    for (const row of rows) requireInteger(member, 'version id', row.id);
    const ids: number[] = await storeCall({ member }, () => brain.replaceVersionChangeReasons({ sourceId, rows: rows.map(row => ({ id: row.id, reason: row.reason })), replacement }));
    return ids.map(Number);
  };

/** The page's retained inline bodies, newest first, at most `limit` (repair_versions.rs). */
export const listRetainedVersionBodies: StoreMember<[pageId: number, limit: number], Array<{ id: number; compiled_truth: string }>> = async (brain, pageId, limit) => {
  const member = 'listRetainedVersionBodies';
  requireInteger(member, 'page id', pageId);
  requireInteger(member, 'limit', limit);
  const rows: Array<{ id: number; compiled_truth: string }> = await storeCall({ member }, () => brain.listRetainedVersionBodies({ pageId, limit }));
  return rows.map(row => ({ id: Number(row.id), compiled_truth: row.compiled_truth }));
};

/** The overwrite candidates of the source, newest first (repair_versions.rs). `imported_at` is the store's ISO text. */
export const listOverwriteCandidates: StoreMember<[sourceId: string, slugs: readonly string[] | null, limit: number], OverwriteCandidateRow[]> =
  async (brain, sourceId, slugs, limit) => {
    const member = 'listOverwriteCandidates';
    requireInteger(member, 'limit', limit);
    return storeCall({ member, sourceId }, () => brain.listOverwriteCandidates({ sourceId, slugs: slugs === null ? null : [...slugs], limit }));
  };

export const listVersionsAfter: StoreMember<[pageIds: readonly number[], afterId: number], OverwriteVersionRow[]> = async (brain, pageIds, afterId) => {
  const member = 'listVersionsAfter';
  for (const id of pageIds) requireInteger(member, 'page id', id);
  requireInteger(member, 'version id', afterId);
  return storeCall({ member }, () => brain.listVersionsAfter({ pageIds: [...pageIds], afterId }));
};

export const listOverwriteLivePages: StoreMember<[pageIds: readonly number[]], OverwriteLiveRow[]> = async (brain, pageIds) => {
  const member = 'listOverwriteLivePages';
  for (const id of pageIds) requireInteger(member, 'page id', id);
  return storeCall({ member }, () => brain.listOverwriteLivePages({ pageIds: [...pageIds] }));
};

export const readVersionContent: StoreMember<[versionId: number, pageId: number], OverwriteContentRow | null> = async (brain, versionId, pageId) => {
  const member = 'readVersionContent';
  requireInteger(member, 'version id', versionId);
  requireInteger(member, 'page id', pageId);
  return storeCall({ member }, () => brain.readVersionContent({ versionId, pageId }));
};

/** revert_version's read of the whole version row (pages.rs `read_page_version_row`), as `createVersion` returns a row. */
export const readPageVersionRow: StoreMember<[versionId: number, pageId: number], PageVersion | null> = async (brain, versionId, pageId) => {
  const member = 'readPageVersionRow';
  requireInteger(member, 'version id', versionId);
  requireInteger(member, 'page id', pageId);
  const row: PageVersion | null = await storeCall({ member }, () => brain.readPageVersionRow(versionId, pageId));
  return row === null ? null : toCreatedVersion(row);
};

/** The newest version of the page that the request archived, or null (repair_versions.rs, `receipt.archived.request_id`). */
export const readArchivedVersionBody: StoreMember<[pageId: number, receiptId: string], { id: number; body_storage: string | null; compiled_truth: string | null; timeline: string | null } | null> =
  async (brain, pageId, receiptId) => {
    const member = 'readArchivedVersionBody';
    requireInteger(member, 'page id', pageId);
    return storeCall({ member }, () => brain.readArchivedVersionBody({ pageId, receiptId }));
  };

/** The fact purge's read of saved inline version bodies (engine-sql/segmented-purge-writes.ts): one batch in id order. */
export const listPurgeVersionBodies: StoreMember<[query: PurgeVersionBodyQuery], PurgeVersionBodyRow[]> = async (brain, query) =>
  storeCall({ member: 'listPurgeVersionBodies' }, () => brain.listPurgeVersionBodies({ sourceId: query.sourceId, pageIds: [...query.pageIds],
    after: query.after, needle: query.needle, escaped: query.escaped }));
