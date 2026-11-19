/**
 * Page operations over the store's page_ops family (rust/docs/store/page_ops.md).
 *
 * Served: getContentFlagsByPageIds, getUnverifiedExtractionPageIds, getEffectiveDates. The other page operations are not
 * built yet and refuse with `engine_capability_missing` (docs/designs/RUST_ENGINE_INTERFACES.md).
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import type { PageReadScope } from '../../types.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { HYBRID_BAG_KEYS, storePagePolicy } from './private-provenance.ts';

/**
 * A `PageReadScope` as the store reads it. Any scope object turns on PGLite's live filter (not deleted, not quarantined,
 * source not archived), so `live` says one was passed. The trust filters refuse when set: the store keeps no trust tiers.
 * `requireSafeChunks` changes nothing on these reads. `markerRead` is for the marker reads hybridSearch hands its whole
 * option bag: they also accept and ignore the bag's own keys (any other key still refuses) and serve `excludePrivate`
 * as the page policy `pageReadFilter` adds (private-provenance.ts `storePagePolicy`, which refuses a caller whose policy
 * is wider than the store's). Every member here is a marker read, so each serves `excludePrivate`.
 */
function readScope(member: string, opts: PageReadScope | undefined, markerRead = false): Record<string, unknown> {
  if (opts === undefined || opts === null) return {};
  for (const key of markerRead ? (['minTrust', 'suppressFlagged'] as const) : (['excludePrivate', 'minTrust', 'suppressFlagged'] as const)) {
    if (opts[key]) refuseMember(member, `option ${key}`);
  }
  const ignored = ['requireSafeChunks', 'excludePrivate', 'minTrust', 'suppressFlagged', ...(markerRead ? HYBRID_BAG_KEYS : [])];
  const taken = takeOptions(member, opts, ['sourceId', 'sourceIds'], ignored);
  const excludePrivate = markerRead ? storePagePolicy(member, opts.excludePrivate) : undefined;
  return { ...taken, live: true, ...(excludePrivate ? { excludePrivate } : {}) };
}

const reviveDate = (value: unknown): Date => new Date(String(value));

/** Page ids as the store reads them: integers only, as Postgres's `int[]` cast requires. */
function pageIds(member: string, ids: number[]): number[] {
  for (const id of ids) if (!Number.isSafeInteger(id)) throw new TypeError(`${member}: page id ${String(id)} is not an integer`);
  return ids;
}

export const getContentFlagsByPageIds: StoreMember<[pageIds: number[], opts?: PageReadScope], Map<number, { reason: string; detail: string }>> = async (
  brain,
  ids,
  opts,
) => {
  if (!ids.length) return new Map();
  const scope = readScope('getContentFlagsByPageIds', opts, true);
  const rows: Array<{ id: number; reason: string; detail: string }> = await storeCall({ member: 'getContentFlagsByPageIds' }, () =>
    brain.getContentFlagsByPageIds(pageIds('getContentFlagsByPageIds', ids), scope));
  return new Map(rows.map((r) => [Number(r.id), { reason: r.reason, detail: r.detail }]));
};

export const getUnverifiedExtractionPageIds: StoreMember<[pageIds: number[], opts?: PageReadScope], Map<number, { unverified: boolean; status: string }>> = async (
  brain,
  ids,
  opts,
) => {
  if (!ids.length) return new Map();
  const scope = readScope('getUnverifiedExtractionPageIds', opts, true);
  const rows: Array<{ id: number; status: string; unverified: boolean }> = await storeCall({ member: 'getUnverifiedExtractionPageIds' }, () =>
    brain.getUnverifiedExtractionPageIds(pageIds('getUnverifiedExtractionPageIds', ids), scope));
  return new Map(rows.map((r) => [Number(r.id), { unverified: r.unverified === true, status: r.status }]));
};

export const getEffectiveDates: StoreMember<[refs: Array<{ slug: string; source_id: string }>, opts?: PageReadScope], Map<string, Date>> = async (
  brain,
  refs,
  opts,
) => {
  if (!refs.length) return new Map();
  const scope = readScope('getEffectiveDates', opts, true);
  const rows: Array<{ slug: string; source_id: string; ts: string }> = await storeCall({ member: 'getEffectiveDates' }, () =>
    brain.getEffectiveDates(refs.map((r) => ({ slug: r.slug, source_id: r.source_id })), scope));
  return new Map(rows.map((r) => [`${r.source_id}::${r.slug}`, reviveDate(r.ts)]));
};
