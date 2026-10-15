import type { BrainEngine } from '../engine.ts';
import { pageKey } from '../eligibility/activation.ts';
import { exactMatchPreference } from '../entities/exact-match-preference.ts';
import { linkableTypesFor, loadSourcePack, readMentionPolicy } from '../mentions/policy.ts';

interface Match {
  slug: string;
  source_id: string;
  arm: string;
  matchedNorm?: string;
}

/** Collapse strong title collisions AFTER privacy and activation gates, before the pointer cap.
 * Alias arms keep precedence. Weak/CJK and surname arms retain their stricter ambiguity rules.
 * Read policy/packs only when multiple eligible title hits actually need disambiguation.
 */
export async function preferEntityTitleMatches<T extends Match>(
  engine: BrainEngine,
  resolved: T[],
  rows: ReadonlyMap<string, { slug: string; type?: string | null }>,
  trust: ReadonlyMap<string, unknown>,
  slugToNorm: ReadonlyMap<string, string>,
): Promise<T[]> {
  const rowFor = (match: T) => rows.get(`${match.source_id} ${match.slug}`);
  const matches = resolved.filter(m => rowFor(m) && trust.has(pageKey(m)));
  const aliases = new Set(matches.filter(m => m.arm === 'alias').map(m => m.matchedNorm));
  const groups = new Map<string, T[]>();
  for (const match of matches) {
    if (match.arm !== 'title' || !match.matchedNorm || aliases.has(match.matchedNorm)) continue;
    const group = groups.get(match.matchedNorm) ?? [];
    group.push(match);
    groups.set(match.matchedNorm, group);
  }
  const collisions = [...groups.values()].filter(group => group.length > 1);
  if (collisions.length) {
    const policy = await readMentionPolicy(engine).catch(() => undefined);
    const sources = [...new Set(collisions.flatMap(group => group.map(m => m.source_id)))];
    const types = new Map(await Promise.all(sources.map(async source => [
      source, new Set(policy ? linkableTypesFor(await loadSourcePack(engine, source), policy) : []),
    ] as const)));
    for (const group of collisions) {
      const exactSlugs = [...slugToNorm].filter(([, norm]) => norm === group[0].matchedNorm).map(([slug]) => slug);
      group.sort((a, b) =>
        exactMatchPreference(rowFor(a)!, exactSlugs, types.get(a.source_id)!)
        - exactMatchPreference(rowFor(b)!, exactSlugs, types.get(b.source_id)!)
        || a.source_id.localeCompare(b.source_id) || a.slug.localeCompare(b.slug));
    }
  }
  return matches.filter(m => m.arm !== 'title' || !m.matchedNorm
    || (!aliases.has(m.matchedNorm) && groups.get(m.matchedNorm)?.[0] === m));
}
