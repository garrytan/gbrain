/** Page version members (BrainEngine createVersion, getVersions). `revertToVersion` is not served: it reads pages through raw SQL. */
import type { PageVersion, GetVersionsOpts, PageVersionRows } from '../../page-state/version-types.ts';
import { toCreatedVersion, toVersion } from '../store-codec.ts';
import { storeErrorCode } from '../store-errors.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

/**
 * A segmented page is refused (the store answers `invalid_state` before it writes): PGLite versions it as a reference
 * to its live body generation, which the Rust store does not keep.
 */
export const createVersion: StoreMember<[slug: string, opts?: { sourceId?: string }], PageVersion> = async (brain, slug, opts) => {
  const scope = takeOptions('createVersion', opts, ['sourceId']);
  return toCreatedVersion(await storeCall({ member: 'createVersion', slug, sourceId: scope.sourceId as string | undefined },
    () => brain.createVersion(slug, scope).catch((error: unknown) => {
      if (storeErrorCode(error) === 'invalid_state') refuseMember('createVersion', 'a segmented page');
      throw error;
    })));
};

export const getVersions: StoreMember<[slug: string, opts?: GetVersionsOpts<boolean>], PageVersionRows<boolean>> = async (brain, slug, opts) => {
  const scope = takeOptions('getVersions', opts, ['sourceId', 'sourceIds', 'limit', 'includeBody']);
  const rows: PageVersion[] = await storeCall({ member: 'getVersions', slug }, () => brain.getVersions(slug, scope));
  return rows.map((row) => toVersion(row)) as PageVersionRows<boolean>;
};
