/**
 * The reads link preparation made through executeRaw (engine-sql/links-preparation.ts), answered from the store
 * (rust/docs/store/links-preparation.md). The fingerprint's hash is PostgreSQL's `hashtextextended(slug, 0)` computed in
 * the store, so a cache of the slug index built on one engine reads the same on another. The store returns the
 * slugs in slug byte order; the SQL engines state no order.
 */
import type { LiveSlugAliasRow, SlugFingerprintProbe, SlugFingerprintRead } from '../../engine-sql/links-preparation.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readLiveSlugAliases: StoreMember<[sourceId: string, targets: readonly string[]], LiveSlugAliasRow[]> = (brain, sourceId, targets) =>
  targets.length === 0 ? Promise.resolve([]) : storeCall({ member: 'readLiveSlugAliases', sourceId }, () => brain.readLiveSlugAliases(sourceId, [...new Set(targets)]));

export const probeSourceSlugFingerprint: StoreMember<[sourceId: string, afterId: number], SlugFingerprintProbe> = (brain, sourceId, afterId) =>
  storeCall({ member: 'probeSourceSlugFingerprint', sourceId }, () => brain.probeSourceSlugFingerprint(sourceId, afterId));

export const readSourceSlugFingerprint: StoreMember<[sourceId: string], SlugFingerprintRead> = (brain, sourceId) =>
  storeCall({ member: 'readSourceSlugFingerprint', sourceId }, () => brain.readSourceSlugFingerprint(sourceId));
