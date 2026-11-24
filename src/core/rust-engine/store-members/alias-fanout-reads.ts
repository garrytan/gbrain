/**
 * Alias fan-out reads (BrainEngine findPagesByTitles, resolveCaseSensitiveAliases, readPageTitle, readPageAliasRows,
 * the entity card's readEntityAliasRows, and link extraction's listSlugAliases;
 * SQL in engine-sql/alias-fanout-reads.ts). `findPagesByTitles` reads `excludePrivate` through the page policy
 * (private-provenance.ts `storePagePolicy`), the caller's reader identity and private-readable grant included; any other
 * caller whose policy differs (folder rules, lineage, an owner read) refuses.
 * The alias reads return the `case_sensitive` flag and `alias_text` the store keeps on a derived alias row
 * (`replaceDerivedAliases`); a `frontmatter` row is never case-sensitive and has a null `alias_text`
 * (rust/docs/store/alias_fanout_reads.md).
 */
import type { CaseSensitiveAliasRow, EntityAliasRow, PageAliasRow, SlugAliasRow, TitleHitRow } from '../../engine-sql/alias-fanout-reads.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

/** Live pages of the sources with a listed type whose lower-cased title is asked, by source then slug. */
export const findPagesByTitles: StoreMember<
  [titleNorms: readonly string[], sourceIds: readonly string[], types: readonly string[], opts?: { excludePrivate?: boolean }],
  TitleHitRow[]
> = async (brain, titleNorms, sourceIds, types, opts) => {
  const o = takeOptions('findPagesByTitles', opts, ['excludePrivate']);
  if (!titleNorms.length || !sourceIds.length || !types.length) return [];
  const excludePrivate = storePagePolicy('findPagesByTitles', o.excludePrivate, { callerReaders: true });
  return storeCall({ member: 'findPagesByTitles' }, () => brain.findPagesByTitles({
    title_norms: [...titleNorms], source_ids: [...sourceIds], types: [...types], exclude_private: excludePrivate ?? null,
  }));
};

/** The case-sensitive alias rows of the aliases in the sources, by source, slug, alias. */
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

/**
 * The entity card's alias rows: the store's alias rows of the listed slugs (by slug, alias, then origin), stably
 * re-sorted by alias in byte order, so equal aliases keep slug then origin order (Postgres leaves that tie to the plan).
 */
export const readEntityAliasRows: StoreMember<[sourceId: string, slugs: readonly string[]], EntityAliasRow[]> =
  async (brain, sourceId, slugs) => {
    if (!slugs.length) return [];
    const found = await storeCall({ member: 'readEntityAliasRows', sourceId },
      () => brain.readPageAliasRows([sourceId], [...slugs])) as PageAliasRow[];
    return found
      .map(r => ({ slug: r.slug, alias_norm: r.alias_norm, origin: r.origin, alias_text: r.alias_text }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.alias_norm), Buffer.from(b.alias_norm)));
  };

/** Every `slug_aliases` row of the source, in alias byte order (the SQL leaves the order to the plan). */
export const listSlugAliases: StoreMember<[sourceId: string], SlugAliasRow[]> = (brain, sourceId) =>
  storeCall({ member: 'listSlugAliases', sourceId }, () => brain.listSlugAliases(sourceId));
