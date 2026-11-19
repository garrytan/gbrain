/**
 * Graph members (BrainEngine traverseGraph, traversePaths, traversePathsDetailed). The store applies the page policy
 * (`excludePrivate`, through storePagePolicy) and the temporal edge policy to the seed, every step and every returned
 * edge; the keyset-page option refuses.
 */
import type { TraverseGraphOpts } from '../../engine.ts';
import type { EdgeTemporalOpts, LinkReadScope } from '../../link-validity.ts';
import type { GraphNode, GraphPath, PageReadScope } from '../../types.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';
import { checkTemporalDates } from './link-temporal-dates.ts';
import { storePagePolicy } from './private-provenance.ts';

type PathOpts = { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both' };
const PATH_OPTIONS = ['depth', 'linkType', 'direction', 'sourceId', 'sourceIds', 'excludePrivate', 'temporal'] as const;

/**
 * The wire options of a walk: the temporal dates checked as `temporalWalkFilter` renders them, and the store page
 * policy. `requireSafeChunks` and `takesHoldersAllowList` gate chunk and take reads only;
 * engine-sql's walks never read them, so the store ignores them too.
 */
function walkOptions(member: string, opts: object | undefined, supported: readonly string[]): Record<string, unknown> {
  const o = takeOptions(member, opts, supported, ['requireSafeChunks', 'takesHoldersAllowList']);
  checkTemporalDates(o.temporal as EdgeTemporalOpts | undefined);
  return { ...o, excludePrivate: storePagePolicy(member, o.excludePrivate, { callerReaders: true }) ?? null };
}

export const traverseGraph: StoreMember<[slug: string, depth?: number, opts?: TraverseGraphOpts], GraphNode[]> = async (brain, slug, depth, opts) => {
  const scope = walkOptions('traverseGraph', opts, ['sourceId', 'sourceIds', 'frontierCap', 'excludePrivate', 'temporal']);
  return storeCall({ member: 'traverseGraph', slug }, () => brain.traverseGraph(slug, depth, scope));
};

export const traversePaths: StoreMember<[slug: string, opts?: PageReadScope & PathOpts], GraphPath[]> = async (brain, slug, opts) => {
  const scope = walkOptions('traversePaths', opts, PATH_OPTIONS);
  return storeCall({ member: 'traversePaths', slug }, () => brain.traversePaths(slug, scope));
};

export const traversePathsDetailed: StoreMember<[slug: string, opts?: LinkReadScope & PathOpts], { paths: GraphPath[]; truncated: boolean }> = async (brain, slug, opts) => {
  const scope = walkOptions('traversePathsDetailed', opts, PATH_OPTIONS);
  return storeCall({ member: 'traversePathsDetailed', slug }, () => brain.traversePathsDetailed(slug, scope));
};
