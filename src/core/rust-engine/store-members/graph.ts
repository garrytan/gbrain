/** Graph members (BrainEngine traverseGraph, traversePaths, traversePathsDetailed). Temporal, privacy and keyset-page options refuse. */
import type { TraverseGraphOpts } from '../../engine.ts';
import type { LinkReadScope } from '../../link-validity.ts';
import type { GraphNode, GraphPath, PageReadScope } from '../../types.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

type PathOpts = { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both' };
const PATH_OPTIONS = ['depth', 'linkType', 'direction', 'sourceId', 'sourceIds'] as const;

export const traverseGraph: StoreMember<[slug: string, depth?: number, opts?: TraverseGraphOpts], GraphNode[]> = (brain, slug, depth, opts) =>
  storeCall({ member: 'traverseGraph', slug }, () =>
    brain.traverseGraph(slug, depth, takeOptions('traverseGraph', opts, ['sourceId', 'sourceIds', 'frontierCap'])));

export const traversePaths: StoreMember<[slug: string, opts?: PageReadScope & PathOpts], GraphPath[]> = (brain, slug, opts) =>
  storeCall({ member: 'traversePaths', slug }, () => brain.traversePaths(slug, takeOptions('traversePaths', opts, PATH_OPTIONS)));

export const traversePathsDetailed: StoreMember<[slug: string, opts?: LinkReadScope & PathOpts], { paths: GraphPath[]; truncated: boolean }> = (brain, slug, opts) =>
  storeCall({ member: 'traversePathsDetailed', slug }, () => brain.traversePathsDetailed(slug, takeOptions('traversePathsDetailed', opts, PATH_OPTIONS)));
