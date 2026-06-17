import type { GraphRepository } from './types.ts';

export interface EnrichedSearchResult {
  slug: string;
  title: string;
  score?: number;
  related_memories: Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }>;
}

export async function enrichWithRelatedMemories(
  searchResults: Array<{ slug: string; title: string; score?: number }>,
  graph: GraphRepository,
  maxPerResult: number = 5,
): Promise<EnrichedSearchResult[]> {
  return Promise.all(
    searchResults.map(async (result) => {
      try {
        const related = await graph.getRelatedEntities(result.slug);
        return {
          ...result,
          related_memories: related.slice(0, maxPerResult),
        };
      } catch {
        return {
          ...result,
          related_memories: [],
        };
      }
    }),
  );
}
