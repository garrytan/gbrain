import type { GBrainConfig } from '../config.ts';
import { resolveQueryRewritePolicy, type QueryRewriteCapability } from '../offline-profile.ts';

const MIN_WORDS = 3;

export interface ResolvedQueryRewriteProvider {
  capability: QueryRewriteCapability;
  expand(query: string): Promise<string[]>;
}

export interface ExpandQueryOptions {
  config?: GBrainConfig | null;
}

export function resolveQueryRewriteProvider(
  opts: ExpandQueryOptions = {},
): ResolvedQueryRewriteProvider {
  return resolveQueryRewritePolicy(opts.config);
}

export async function expandQuery(
  query: string,
  opts: ExpandQueryOptions = {},
): Promise<string[]> {
  const wordCount = (query.match(/\S+/g) || []).length;
  if (wordCount < MIN_WORDS) return [query];

  const provider = resolveQueryRewriteProvider(opts);
  if (!provider.capability.available) {
    return [query];
  }

  try {
    return await provider.expand(query);
  } catch {
    return [query];
  }
}
