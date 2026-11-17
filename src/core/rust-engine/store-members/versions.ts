/** Page version members (BrainEngine createVersion, getVersions). `revertToVersion` is not served: it reads pages through raw SQL. */
import type { PageVersion, GetVersionsOpts, PageVersionRows } from '../../page-state/version-types.ts';
import { toCreatedVersion, toVersion } from '../store-codec.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

export const createVersion: StoreMember<[slug: string, opts?: { sourceId?: string }], PageVersion> = async (brain, slug, opts) => {
  const scope = takeOptions('createVersion', opts, ['sourceId']);
  return toCreatedVersion(await storeCall({ member: 'createVersion', slug, sourceId: scope.sourceId as string | undefined },
    () => brain.createVersion(slug, scope)));
};

export const getVersions: StoreMember<[slug: string, opts?: GetVersionsOpts<boolean>], PageVersionRows<boolean>> = async (brain, slug, opts) => {
  const scope = takeOptions('getVersions', opts, ['sourceId', 'sourceIds', 'limit', 'includeBody']);
  const rows: PageVersion[] = await storeCall({ member: 'getVersions', slug }, () => brain.getVersions(slug, scope));
  return rows.map((row) => toVersion(row)) as PageVersionRows<boolean>;
};
