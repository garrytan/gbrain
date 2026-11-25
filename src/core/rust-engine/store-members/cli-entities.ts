/**
 * The privacy-label page reads of the import notice (BrainEngine readIgnoredPrivacyLabelPages, readLivePageFrontmatter), served by
 * gbrain-store `cli_reads::entities`.
 */
import type { IgnoredLabelPageRow } from '../../engine-sql/entity-reads.ts';
import { ignoredPrivacyLabels, SCAN_CAP } from '../../search/ignored-privacy-labels.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

/** The live page's type and frontmatter, or null; the store has no statement deadline, so `timeoutMs` is not read. */
export const readLivePageFrontmatter: StoreMember<[sourceId: string, slug: string, opts?: { timeoutMs?: number }], IgnoredLabelPageRow | null> =
  async (brain, sourceId, slug, opts) => {
    takeOptions('readLivePageFrontmatter', opts, [], ['timeoutMs']);
    return (await storeCall({ member: 'readLivePageFrontmatter', sourceId }, () => brain.readLivePageFrontmatter(sourceId, slug)) as IgnoredLabelPageRow | null) ?? null;
  };

/** The store returns every live labelled page with no visibility key; the label rule itself is the TypeScript twin of the SQL. */
export const readIgnoredPrivacyLabelPages: StoreMember<[sourceId: string, scope: { slugs: readonly string[] } | { since: string },
  opts?: { limit?: number; timeoutMs?: number }], IgnoredLabelPageRow[]> = async (brain, sourceId, scope, opts) => {
  const taken = takeOptions('readIgnoredPrivacyLabelPages', opts, ['limit'], ['timeoutMs']);
  const limit = Math.max(0, Math.floor(typeof taken.limit === 'number' ? taken.limit : SCAN_CAP));
  const rows = await storeCall({ member: 'readIgnoredPrivacyLabelPages', sourceId }, () => brain.readIgnoredPrivacyLabelPages(sourceId,
    'slugs' in scope ? { slugs: [...new Set(scope.slugs)] } : { since: scope.since })) as IgnoredLabelPageRow[];
  return rows.filter(row => ignoredPrivacyLabels(row).length > 0).slice(0, limit);
};
