/**
 * Slug renames, slug aliases, page aliases and contextual retrieval state (BrainEngine updateSlug,
 * resolveSlugWithAlias, resolveSlugWithAliasDetailed, resolveAliases, setPageAliases,
 * updatePageContextualRetrievalState).
 *
 * A privacy, trust or flag filter refuses with `engine_capability_missing`: the store keeps no page visibility. A
 * rename does not move fact bindings (no fact store yet), and the `none` contextual retrieval tier keeps no vectors to
 * reset (rust/docs/store/aliases.md).
 */
import type { PageReadScope } from '../../types.ts';
import { validateSlug, warnOncePerProcess } from '../../utils.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

type AliasRef = { slug: string; source_id: string };
type SlugAliasMatch = { canonical_slug: string; source_id: string; matches: number };

async function detailed(
  brain: StoreBrain,
  member: string,
  slug: string,
  sourceOrSources: string | readonly string[],
  opts: { excludePrivate?: boolean } | undefined,
): Promise<{ canonical_slug: string; source_id: string } | null> {
  takeOptions(member, opts, []);
  const sources = Array.isArray(sourceOrSources) ? [...sourceOrSources] : [sourceOrSources as string];
  if (sources.length === 0) return null;
  const found: SlugAliasMatch | null = await storeCall({ member, slug }, () => brain.resolveSlugWithAliasDetailed(slug, sources));
  if (found === null) return null;
  if (found.matches > 1) {
    warnOncePerProcess(
      `resolveSlugWithAlias:multi_match:${slug}`,
      `[resolveSlugWithAlias] multi_match: alias '${slug}' exists in ${found.matches} sources; returning first by sourceOrSources order.`,
    );
  }
  return { canonical_slug: found.canonical_slug, source_id: found.source_id };
}

export const updateSlug: StoreMember<[oldSlug: string, newSlug: string, opts?: { sourceId?: string }], number> = (brain, oldSlug, newSlug, opts) => {
  const slug = validateSlug(newSlug);
  const o = takeOptions('updateSlug', opts, ['sourceId']);
  const sourceId = o.sourceId as string | undefined;
  return storeCall({ member: 'updateSlug', slug: oldSlug, sourceId }, () => brain.updateSlug(oldSlug, slug, sourceId ?? null));
};

export const resolveSlugWithAliasDetailed: StoreMember<
  [slug: string, sourceOrSources: string | readonly string[], opts?: { excludePrivate?: boolean }],
  { canonical_slug: string; source_id: string } | null
> = (brain, slug, sourceOrSources, opts) => detailed(brain, 'resolveSlugWithAliasDetailed', slug, sourceOrSources, opts);

export const resolveSlugWithAlias: StoreMember<[slug: string, sourceOrSources: string | readonly string[], opts?: { excludePrivate?: boolean }], string> =
  async (brain, slug, sourceOrSources, opts) => (await detailed(brain, 'resolveSlugWithAlias', slug, sourceOrSources, opts))?.canonical_slug ?? slug;

export const resolveAliases: StoreMember<[aliasNorms: string[], opts?: PageReadScope], Map<string, AliasRef[]>> = async (brain, aliasNorms, opts) => {
  const o = takeOptions('resolveAliases', opts, ['sourceId', 'sourceIds'], ['requireSafeChunks']);
  if (aliasNorms.length === 0) return new Map();
  const rows: Array<[string, AliasRef[]]> = await storeCall({ member: 'resolveAliases', sourceId: o.sourceId as string | undefined }, () =>
    brain.resolveAliases(aliasNorms, o));
  return new Map(rows);
};

export const setPageAliases: StoreMember<[slug: string, sourceId: string, aliasNorms: string[], opts?: { inline?: boolean }], void> =
  async (brain, slug, sourceId, aliasNorms, opts) => {
    takeOptions('setPageAliases', opts, [], ['inline']);
    await storeCall({ member: 'setPageAliases', slug, sourceId }, () => brain.setPageAliases(slug, sourceId, aliasNorms));
  };

export const updatePageContextualRetrievalState: StoreMember<[slug: string, sourceId: string, mode: string, corpusGeneration: string | null], void> =
  async (brain, slug, sourceId, mode, corpusGeneration) => {
    await storeCall({ member: 'updatePageContextualRetrievalState', slug, sourceId }, () =>
      brain.updatePageContextualRetrievalState(slug, sourceId, mode, corpusGeneration ?? null));
  };
