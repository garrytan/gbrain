/**
 * Page version members (BrainEngine createVersion, getVersions). A segmented page's snapshot references its body
 * generation and keeps content_hash, as insertSegmentedVersion does. `revertToVersion` is not served: it reads pages
 * through raw SQL.
 */
import type { PageVersion, GetVersionsOpts, PageVersionRows } from '../../page-state/version-types.ts';
import type { VersionHistory } from '../../page-state/versions.ts';
import { toCreatedVersion, toVersion } from '../store-codec.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

/**
 * A sync import's history (`VersionHistory`) rides along: `reason` is stamped as `change_reason` as given, since the
 * store keeps no reason purge tombstones (readReasonPurgeTombstones is empty and the purge writer needs raw SQL), so
 * `reasonSource` has nothing to check; `historyGap` marks the page's `version_history_gap_at`. A `preimage` is the
 * caller's own read of the page in its transaction, before its page write; the store snapshots the page under its
 * write instead, which on the store is the same page (the import's statements run in order, pipelined()).
 */
export const createVersion: StoreMember<[slug: string, opts?: { sourceId?: string } & VersionHistory & { preimage?: unknown }], PageVersion> = async (brain, slug, opts) => {
  const scope = takeOptions('createVersion', opts, ['sourceId', 'reason', 'historyGap'], ['reasonSource', 'preimage']);
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
