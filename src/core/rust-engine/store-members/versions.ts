/**
 * Page version members (BrainEngine createVersion, getVersions, and the change-reason pair readLatestVersionId and
 * stampVersionChangeReason, engine-sql/version-reasons.ts, and the holding-page cap pruneHoldingPageVersions,
 * engine-sql/version-prune.ts). A segmented page's snapshot references its body
 * generation and keeps content_hash, as insertSegmentedVersion does. A version keeps the reason a write stamped on it:
 * getVersions reads it as `replaced_because` (the trusted read; `excludePrivate` is refused). `revertToVersion` is not
 * served: it reads pages through raw SQL.
 */
import type { PageVersion, GetVersionsOpts, PageVersionRows } from '../../page-state/version-types.ts';
import { toCreatedVersion, toVersion } from '../store-codec.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

function requireInteger(member: string, name: string, value: number): void {
  if (!Number.isSafeInteger(value)) refuseMember(member, `a ${name} that is not an integer`);
}

/**
 * `reason` is served (a null one is none), and so is `historyGap` (the page records `version_history_gap_at` first). A
 * Git-sourced reason (`reasonSource`) is refused. The store prunes the page's history after the snapshot as
 * `createPageVersion` does (rust/crates/gbrain-store/src/version_prune.rs).
 */
export const createVersion: StoreMember<[slug: string, opts?: { sourceId?: string; reason?: string | null; historyGap?: boolean }], PageVersion> = async (brain, slug, opts) => {
  const scope = takeOptions('createVersion', opts && opts.reason === null ? { ...opts, reason: undefined } : opts, ['sourceId', 'reason', 'historyGap']);
  return toCreatedVersion(await storeCall({ member: 'createVersion', slug, sourceId: scope.sourceId as string | undefined },
    () => brain.createVersion(slug, scope)));
};

export const getVersions: StoreMember<[slug: string, opts?: GetVersionsOpts<boolean>], PageVersionRows<boolean>> = async (brain, slug, opts) => {
  const scope = takeOptions('getVersions', opts, ['sourceId', 'sourceIds', 'limit', 'includeBody']);
  const rows: PageVersion[] = await storeCall({ member: 'getVersions', slug }, () => brain.getVersions(slug, scope));
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

export const stampVersionChangeReason: StoreMember<[spec: { pageId: number; afterVersionId: number; reason: string }], number> = async (brain, spec) => {
  const member = 'stampVersionChangeReason';
  requireInteger(member, 'page id', spec.pageId);
  requireInteger(member, 'version id', spec.afterVersionId);
  if (typeof spec.reason !== 'string') refuseMember(member, 'a reason that is not text');
  return storeCall({ member }, () => brain.stampVersionChangeReason({ pageId: spec.pageId, afterVersionId: spec.afterVersionId, reason: spec.reason }));
};
