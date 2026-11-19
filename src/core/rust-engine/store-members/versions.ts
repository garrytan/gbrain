/**
 * Page version members (BrainEngine createVersion, getVersions). A segmented page's snapshot references its body
 * generation and keeps content_hash, as insertSegmentedVersion does. `revertToVersion` is not served: it reads pages
 * through raw SQL.
 */
import type { PageVersion, GetVersionsOpts, PageVersionRows } from '../../page-state/version-types.ts';
import { toCreatedVersion, toVersion } from '../store-codec.ts';
import { versionPrivacySql } from '../../engine-sql/pages.ts';
import { withCallerAccess, withoutCallerAccess } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { normalizeConceptInputs, storePagePolicy, type StorePrivacyPolicy } from './private-provenance.ts';

export const createVersion: StoreMember<[slug: string, opts?: { sourceId?: string }], PageVersion> = async (brain, slug, opts) => {
  const scope = takeOptions('createVersion', opts, ['sourceId']);
  return toCreatedVersion(await storeCall({ member: 'createVersion', slug, sourceId: scope.sourceId as string | undefined },
    () => brain.createVersion(slug, scope)));
};

export const getVersions: StoreMember<[slug: string, opts?: GetVersionsOpts<boolean>], PageVersionRows<boolean>> = async (brain, slug, opts) => {
  // The SQL reads only these five options; the rest of the read policy the MCP tool passes changes nothing there.
  const scope = takeOptions('getVersions', opts, ['sourceId', 'sourceIds', 'limit', 'includeBody', 'excludePrivate'],
    ['requireSafeChunks', 'minTrust', 'suppressFlagged', 'takesHoldersAllowList']);
  // The page policy judges the page; the store judges each version by the same identity, grant and flags.
  if ('excludePrivate' in scope) scope.excludePrivate = versionsPolicy(scope.excludePrivate) ?? null;
  const rows: PageVersion[] = await storeCall({ member: 'getVersions', slug }, () => brain.getVersions(slug, scope));
  return rows.map((row) => toVersion(row)) as PageVersionRows<boolean>;
};

/**
 * The store policy of `getVersions` under `excludePrivate`: the caller's page policy on the live page
 * (`storePagePolicy`, with `callerReaders`), served only when the whole predicate (`versionPrivacySql`, which adds the
 * snapshot's readers, privacy and pinned marker) is the rendering for a record of only the reader identity and
 * private-readable grant that policy carries. Any other caller refuses.
 */
function versionsPolicy(excludePrivate: unknown): StorePrivacyPolicy | undefined {
  const policy = storePagePolicy('getVersions', excludePrivate, { callerReaders: true });
  if (!policy) return undefined;
  const text = normalizeConceptInputs(versionPrivacySql());
  const readers = { identity: policy.identity ?? [], privateReadableSources: policy.privateReadableSources ?? [] };
  const renderings = [
    () => withoutCallerAccess(versionPrivacySql),
    () => withoutCallerAccess(() => withCallerAccess({ ...readers, hidePrivate: true }, versionPrivacySql)),
    () => withoutCallerAccess(() => withCallerAccess({ ...readers, hidePrivate: true, restricted: false }, versionPrivacySql)),
  ];
  if (renderings.some((render) => normalizeConceptInputs(render()) === text)) return policy;
  refuseMember('getVersions', 'excludePrivate for a caller whose snapshot readers or grants widen the policy');
}
