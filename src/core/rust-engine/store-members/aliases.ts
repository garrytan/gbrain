/**
 * Slug renames, slug aliases, page aliases and contextual retrieval state (BrainEngine updateSlug,
 * resolveSlugWithAlias, resolveSlugWithAliasDetailed, resolveAliases, setPageAliases,
 * updatePageContextualRetrievalState, aliasCanonicalRefs).
 *
 * aliasCanonicalRefs reads its policy as `pageReadFilter('p', policy, !!policy)` does: the source clause, the live test
 * and `excludePrivate` through the page policy (private-provenance.ts `storePagePolicy`); a trust floor or flag
 * suppression refuses, as the store keeps no trust tiers. resolveAliases reads `excludePrivate` the same way. Elsewhere
 * a privacy, trust or flag filter refuses with `engine_capability_missing`. A rename moves fact bindings only once the
 * facts family fills its rename hook, and the `none` contextual retrieval tier keeps no vectors to reset
 * (rust/docs/store/aliases.md).
 */
import type { PageReadPolicy, PageReadScope } from '../../types.ts';
import { validateSlug, warnOncePerProcess } from '../../utils.ts';
import { storeErrorCode } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

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
  // A segmented page is refused (the store answers `invalid_state` before it writes): the SQL engines version it as a
  // reference to its live body generation before the move, which the Rust store does not keep (see createVersion).
  return storeCall({ member: 'updateSlug', slug: oldSlug, sourceId }, () => brain.updateSlug(oldSlug, slug, sourceId ?? null)
    .catch((error: unknown) => {
      if (storeErrorCode(error) === 'invalid_state') refuseMember('updateSlug', 'a segmented page');
      throw error;
    }));
};

export const resolveSlugWithAliasDetailed: StoreMember<
  [slug: string, sourceOrSources: string | readonly string[], opts?: { excludePrivate?: boolean }],
  { canonical_slug: string; source_id: string } | null
> = (brain, slug, sourceOrSources, opts) => detailed(brain, 'resolveSlugWithAliasDetailed', slug, sourceOrSources, opts);

export const resolveSlugWithAlias: StoreMember<[slug: string, sourceOrSources: string | readonly string[], opts?: { excludePrivate?: boolean }], string> =
  async (brain, slug, sourceOrSources, opts) => (await detailed(brain, 'resolveSlugWithAlias', slug, sourceOrSources, opts))?.canonical_slug ?? slug;

/** The keys of the alias hop's option bag (alias-hop.ts `IdentityTierOpts` and its hop switches) that are not page policy. */
const ALIAS_HOP_KEYS = ['excludeSlugs', 'excludeSlugPrefixes', 'type', 'types', 'tokenHop', 'qualified'] as const;

export const resolveAliases: StoreMember<[aliasNorms: string[], opts?: PageReadScope], Map<string, AliasRef[]>> = async (brain, aliasNorms, opts) => {
  // The alias hop hands over its whole identity-tier bag; PGLite's read looks only at the scope keys in it, so the
  // slug excludes and the hop switches are ignored here as there (the hop applies them to its own rows).
  const o = takeOptions('resolveAliases', opts, ['sourceId', 'sourceIds'], ['requireSafeChunks', 'excludePrivate', ...ALIAS_HOP_KEYS]);
  if (aliasNorms.length === 0) return new Map();
  // `excludePrivate` is the page policy `readAliases` adds for the page an alias names and for a title that shadows one.
  const excludePrivate = storePagePolicy('resolveAliases', opts?.excludePrivate);
  const rows: Array<[string, AliasRef[]]> = await storeCall({ member: 'resolveAliases', sourceId: o.sourceId as string | undefined }, () =>
    brain.resolveAliases(aliasNorms, excludePrivate ? { ...o, excludePrivate } : o));
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

/**
 * `aliasCanonicalRefs` (engine-sql/search-reads.ts): the refs that are the canonical slug of a `slug_aliases` row and
 * whose page the policy may read. Hybrid search passes its whole option bag as the policy; the SQL reads only the keys
 * below of it, so the rest change nothing.
 */
export const aliasCanonicalRefs: StoreMember<[refs: AliasRef[], policy?: PageReadPolicy], Array<{ source_id: string; canonical_slug: string }>> =
  async (brain, refs, policy) => {
    if (refs.length === 0) return [];
    if (policy?.minTrust) refuseMember('aliasCanonicalRefs', 'option minTrust');
    if (policy?.suppressFlagged) refuseMember('aliasCanonicalRefs', 'option suppressFlagged');
    const sourceIds = policy?.sourceIds?.length ? [...policy.sourceIds] : policy?.sourceId ? [policy.sourceId] : null;
    const excludePrivate = storePagePolicy('aliasCanonicalRefs', policy?.excludePrivate);
    return storeCall({ member: 'aliasCanonicalRefs' }, () => brain.aliasCanonicalRefs({
      refs: refs.map((r) => ({ slug: r.slug, source_id: r.source_id })),
      source_ids: sourceIds,
      live: !!policy,
      exclude_private: excludePrivate ?? null,
    }));
  };
