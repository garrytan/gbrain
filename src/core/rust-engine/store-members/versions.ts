/**
 * Page version members (BrainEngine createVersion, getVersions, the change-reason pair readLatestVersionId and
 * stampVersionChangeReason, readLatestVersionIdAtTier, engine-sql/version-reasons.ts, and the holding-page cap pruneHoldingPageVersions,
 * engine-sql/version-prune.ts). A segmented page's snapshot references its body
 * generation and keeps content_hash, as insertSegmentedVersion does. A version keeps the reason a write stamped on it:
 * getVersions reads it as `replaced_because` (the trusted read; `excludePrivate` is refused). `revertToVersion` is not
 * served: it reads pages through raw SQL.
 */
import type { PageVersion, GetVersionsOpts, PageVersionRows } from '../../page-state/version-types.ts';
import type { VersionHistory } from '../../page-state/versions.ts';
import type { PageSnapshot } from '../../page-state/types.ts';
import { isSegmentedPage } from '../../page-body/page-shape.ts';
import { toCreatedVersion, toVersion } from '../store-codec.ts';
import { storeErrorCode } from '../store-errors.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

function requireInteger(member: string, name: string, value: number): void {
  if (!Number.isSafeInteger(value)) refuseMember(member, `a ${name} that is not an integer`);
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null | undefined => value == null || typeof value === 'string';

/**
 * A PageSnapshot in the store's wire form: the columns createPageVersion inserts from it. The frontmatter and tags go
 * through JSON as the `::jsonb` casts take them (`JSON.stringify`), and the deleted flag is `deleted_at != null`. A
 * segmented page is refused before its body getters are read; any other shape the insert would refuse is refused here.
 */
function preimageWire(snapshot: PageSnapshot): Record<string, unknown> {
  const member = 'createVersion';
  const page = snapshot?.page;
  if (!page || typeof page !== 'object') refuseMember(member, 'a preimage with no page');
  if (isSegmentedPage(page)) refuseMember(member, 'a segmented page');
  if (!Number.isSafeInteger(page.id) || page.id <= 0) refuseMember(member, 'a preimage page id that is not a positive integer');
  if (!isText(page.compiled_truth) || !isTextOrNull(page.timeline) || !isText(page.title) || !isText(page.type)) {
    refuseMember(member, 'a preimage whose body, title or type is not text');
  }
  if (!isTextOrNull(page.content_hash) || !isTextOrNull(page.source_path)) refuseMember(member, 'a preimage whose content hash or source path is not text');
  if (!Array.isArray(snapshot.tags) || !snapshot.tags.every(isText)) refuseMember(member, 'preimage tags that are not a list of text');
  if (!isText(snapshot.revision)) refuseMember(member, 'a preimage revision that is not text');
  const frontmatter: unknown = JSON.parse(JSON.stringify(page.frontmatter ?? {}));
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) refuseMember(member, 'a preimage frontmatter that is not an object');
  return {
    pageId: page.id,
    compiledTruth: page.compiled_truth,
    timeline: page.timeline ?? null,
    title: page.title,
    type: page.type,
    frontmatter,
    contentHash: page.content_hash ?? null,
    tags: JSON.parse(JSON.stringify(snapshot.tags)),
    revision: snapshot.revision,
    isDeleted: page.deleted_at != null,
    sourcePath: page.source_path ?? null,
  };
}

/**
 * `reason` is served (a null one is none), and so is `historyGap` (the page records `version_history_gap_at` first). A
 * Git-sourced reason (`reasonSource`) is served: the store drops a non-empty reason whose (commit, path) a purge
 * tombstoned for the source, in the same write, as stampableReason does. `preimage` (the page as the caller read it, which
 * import-file.ts passes on every update) is served: the snapshot takes its text, title, type, frontmatter, tags (in the
 * given order), revision, deleted flag and source path from it, and its trust tier, write origin and revision receipt from
 * the stored page, as createPageVersion's insert and the page_versions triggers do. The store refuses a preimage of another
 * page id than the slug's (PGLite inserts it under that id) before it writes. The store prunes the page's history after
 * the snapshot as `createPageVersion` does (rust/crates/gbrain-store/src/version_prune.rs), from the snapshot's size. A
 * segmented page, or a segmented preimage, is refused (the store answers `invalid_state` before it writes): PGLite
 * versions it as a reference to its live body generation, which the Rust store does not keep.
 */
export const createVersion: StoreMember<[slug: string, opts?: { sourceId?: string; preimage?: PageSnapshot } & VersionHistory], PageVersion> = async (brain, slug, opts) => {
  const scope = takeOptions('createVersion', opts && opts.reason === null ? { ...opts, reason: undefined } : opts, ['sourceId', 'reason', 'reasonSource', 'historyGap', 'preimage']);
  if (scope.preimage !== undefined) scope.preimage = preimageWire(scope.preimage as PageSnapshot);
  return toCreatedVersion(await storeCall({ member: 'createVersion', slug, sourceId: scope.sourceId as string | undefined },
    () => brain.createVersion(slug, scope).catch((error: unknown) => {
      if (storeErrorCode(error) === 'invalid_state') refuseMember('createVersion', 'a segmented page');
      throw error;
    })));
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
