/**
 * Alias fan-out reads (BrainEngine findPagesByTitles, resolveCaseSensitiveAliases, readPageTitle, readPageAliasRows;
 * SQL in engine-sql/alias-fanout-reads.ts). `findPagesByTitles` reads `excludePrivate` through the page policy
 * (private-provenance.ts `storePagePolicy`): a caller whose member pages, grants or lineage widen the policy refuses.
 * The store keeps only `frontmatter` alias rows, with no alias text and never case-sensitive, so
 * `resolveCaseSensitiveAliases` finds none and every alias row has a null `alias_text`
 * (rust/docs/store/alias_fanout_reads.md).
 */
import type { CaseSensitiveAliasRow, PageAliasRow, TitleHitRow } from '../../engine-sql/alias-fanout-reads.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

/** Live pages of the sources with a listed type whose lower-cased title is asked, by source then slug. */
export const findPagesByTitles: StoreMember<
  [titleNorms: readonly string[], sourceIds: readonly string[], types: readonly string[], opts?: { excludePrivate?: boolean }],
  TitleHitRow[]
> = async (brain, titleNorms, sourceIds, types, opts) => {
  const o = takeOptions('findPagesByTitles', opts, ['excludePrivate']);
  if (!titleNorms.length || !sourceIds.length || !types.length) return [];
  const excludePrivate = storePagePolicy('findPagesByTitles', o.excludePrivate);
  return storeCall({ member: 'findPagesByTitles' }, () => brain.findPagesByTitles({
    title_norms: [...titleNorms], source_ids: [...sourceIds], types: [...types], exclude_private: excludePrivate ?? null,
  }));
};

/** The case-sensitive alias rows of the aliases in the sources: none, as the store keeps none. */
export const resolveCaseSensitiveAliases: StoreMember<[aliasNorms: readonly string[], sourceIds: readonly string[]], CaseSensitiveAliasRow[]> =
  async (brain, aliasNorms, sourceIds) => {
    if (!aliasNorms.length || !sourceIds.length) return [];
    return storeCall({ member: 'resolveCaseSensitiveAliases' }, () => brain.resolveCaseSensitiveAliases([...aliasNorms], [...sourceIds]));
  };

/** The title of the page at `(sourceId, slug)`, soft-deleted pages included; null with no page. */
export const readPageTitle: StoreMember<[sourceId: string, slug: string], string | null> = (brain, sourceId, slug) =>
  storeCall({ member: 'readPageTitle', slug, sourceId }, () => brain.readPageTitle(sourceId, slug));

/** Every alias row of the listed slugs in the listed sources, by source, slug, alias, then origin. */
export const readPageAliasRows: StoreMember<[sourceIds: readonly string[], slugs: readonly string[]], PageAliasRow[]> =
  async (brain, sourceIds, slugs) => {
    if (!sourceIds.length || !slugs.length) return [];
    return storeCall({ member: 'readPageAliasRows' }, () => brain.readPageAliasRows([...sourceIds], [...slugs]));
  };
