/**
 * Page version members (BrainEngine createVersion, getVersions, the change-reason pair readLatestVersionId and
 * stampVersionChangeReason, readLatestVersionIdAtTier, engine-sql/version-reasons.ts, and the holding-page cap pruneHoldingPageVersions,
 * engine-sql/version-prune.ts). A segmented page's snapshot references its body
 * generation and keeps content_hash, as insertSegmentedVersion does. A version keeps the reason a write stamped on it:
 * getVersions reads it as `replaced_because` (the trusted read; `excludePrivate` is refused). `revertToVersion` is not
 * served: it reads pages through raw SQL.
 */
import type { PageVersion, GetVersionsOpts, PageVersionRows } from '../../page-state/version-types.ts';
import { toCreatedVersion, toVersion } from '../store-codec.ts';
import { storeErrorCode } from '../store-errors.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';
import type { PageSnapshot } from '../../page-state/types.ts';
import { isSegmentedPage } from '../../page-body/page-shape.ts';
import type { PurgeVersionBodyQuery, PurgeVersionBodyRow } from '../../engine-sql/segmented-purge-writes.ts';

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
 * `preimage` (preimageFields). A
 * Git-sourced reason (`reasonSource`) is refused. The store prunes the page's history after the snapshot as
 * `createPageVersion` does (rust/crates/gbrain-store/src/version_prune.rs). A segmented page is refused (the store
 * answers `invalid_state` before it writes): PGLite versions it as a reference to its live body generation, which the
 * Rust store does not keep.
 */
export const createVersion: StoreMember<[slug: string, opts?: { sourceId?: string; reason?: string | null; historyGap?: boolean; preimage?: PageSnapshot }], PageVersion> = async (brain, slug, opts) => {
  const scope = takeOptions('createVersion', opts && opts.reason === null ? { ...opts, reason: undefined } : opts, ['sourceId', 'reason', 'historyGap', 'preimage']);
  if (scope.preimage) scope.preimage = preimageFields(scope.preimage as PageSnapshot);
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

/** The fact purge's read of saved inline version bodies (engine-sql/segmented-purge-writes.ts): one batch in id order. */
export const listPurgeVersionBodies: StoreMember<[query: PurgeVersionBodyQuery], PurgeVersionBodyRow[]> = async (brain, query) =>
  storeCall({ member: 'listPurgeVersionBodies' }, () => brain.listPurgeVersionBodies({ sourceId: query.sourceId, pageIds: [...query.pageIds],
    after: query.after, needle: query.needle, escaped: query.escaped }));
