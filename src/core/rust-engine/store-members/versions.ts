/**
 * Page version members (BrainEngine createVersion, getVersions, readLatestVersionIdAtTier). A version keeps the reason a write stamped on it and
 * can version the caller's own read of the page (`preimage`). `revertToVersion` is not served: it reads pages through
 * raw SQL.
 */
import type { PageVersion, GetVersionsOpts, PageVersionRows } from '../../page-state/version-types.ts';
import { toCreatedVersion, toVersion } from '../store-codec.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import type { VersionHistory } from '../../page-state/versions.ts';
import type { PageSnapshot } from '../../page-state/types.ts';
import { isSegmentedPage } from '../../page-body/page-shape.ts';

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
  const scope = takeOptions('getVersions', opts, ['sourceId', 'sourceIds', 'limit', 'includeBody']);
  const rows: PageVersion[] = await storeCall({ member: 'getVersions', slug }, () => brain.getVersions(slug, scope));
  return rows.map((row) => toVersion(row)) as PageVersionRows<boolean>;
};

/** The page's newest version id stamped with `tier`, or null (engine-sql/version-reasons.ts readLatestVersionIdAtTier). */
export const readLatestVersionIdAtTier: StoreMember<[pageId: number, tier: string], number | null> = async (brain, pageId, tier) => {
  const member = 'readLatestVersionIdAtTier';
  requireInteger(member, 'page id', pageId);
  if (typeof tier !== 'string') refuseMember(member, 'a tier that is not text');
  return storeCall({ member }, () => brain.readLatestVersionIdAtTier(pageId, tier));
};
