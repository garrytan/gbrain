/**
 * #6725: one pointer per name per source in the volunteer title arm.
 *
 * Exact-title hits that share a candidate norm WITHIN one source collapse to
 * the page the `entity` card would pick (entities/exact-match-preference.ts:
 * explicit exact slug, then linkable entity type, then other), ties broken by
 * slug. Same-title pages in different sources are different entities and are
 * never collapsed. Runs after the privacy and activation gate, so a hidden or
 * withheld entity cannot suppress an eligible fallback. A norm an alias hit
 * already resolved is left alone (alias precedence). The mention policy and
 * source packs are read only when a collision exists.
 */
import type { BrainEngine } from '../engine.ts';
import { exactMatchPreference } from '../entities/exact-match-preference.ts';

interface TitleMatch {
  slug: string;
  source_id: string;
  arm: string;
  matchedNorm?: string;
}

export async function preferEntityTitleMatches<M extends TitleMatch>(
  engine: BrainEngine,
  resolved: readonly M[],
  rowFor: (match: M) => { slug: string; type?: string | null } | undefined,
  eligible: (match: M) => boolean,
  slugToNorm: ReadonlyMap<string, string>,
): Promise<M[]> {
  const matches = resolved.filter(m => rowFor(m) !== undefined && eligible(m));
  const aliasNorms = new Set(matches.filter(m => m.arm === 'alias').map(m => m.matchedNorm));
  const groupKey = (m: M) => `${m.source_id}\u0000${m.matchedNorm}`;
  const groups = new Map<string, M[]>();
  for (const m of matches) {
    if (m.arm !== 'title' || !m.matchedNorm || aliasNorms.has(m.matchedNorm)) continue;
    groups.set(groupKey(m), [...(groups.get(groupKey(m)) ?? []), m]);
  }
  const collisions = [...groups.values()].filter(group => group.length > 1);
  if (!collisions.length) return matches;

  const { linkableTypesFor, loadSourcePack, readMentionPolicy } = await import('../mentions/policy.ts');
  const policy = await readMentionPolicy(engine).catch(() => undefined);
  const typesBySource = new Map<string, ReadonlySet<string>>();
  for (const source of new Set(collisions.map(group => group[0].source_id))) {
    typesBySource.set(source, new Set(policy ? linkableTypesFor(await loadSourcePack(engine, source), policy) : []));
  }
  for (const group of collisions) {
    const exactSlugs = [...slugToNorm].filter(([, norm]) => norm === group[0].matchedNorm).map(([slug]) => slug);
    const types = typesBySource.get(group[0].source_id)!;
    group.sort((a, b) => exactMatchPreference(rowFor(a)!, exactSlugs, types) - exactMatchPreference(rowFor(b)!, exactSlugs, types)
      || a.slug.localeCompare(b.slug));
  }
  return matches.filter(m => {
    const group = m.arm === 'title' && m.matchedNorm ? groups.get(groupKey(m)) : undefined;
    return !group || group[0] === m;
  });
}
