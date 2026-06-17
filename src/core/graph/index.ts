import type { MemoryNode, MemoryType } from '../domain.ts';
import { VALID_MEMORY_TYPES } from '../domain.ts';

export type { GraphRepository, GraphTraversalResult } from './types.ts';
export { InMemoryGraphAdapter } from './in-memory-adapter.ts';

export function pageToMemoryNode(page: {
  slug: string;
  title: string;
  type: string;
  tags: string[];
  content?: string;
}): MemoryNode {
  const now = new Date().toISOString();
  return {
    id: page.slug,
    slug: page.slug,
    type: (VALID_MEMORY_TYPES.has(page.type) ? page.type : 'concept') as MemoryType,
    title: page.title,
    summary: page.content ? page.content.slice(0, 200) : '',
    source: 'gbrain-sync',
    confidence: 0.8,
    consent: true,
    tags: page.tags,
    created_at: now,
    last_verified_at: now,
    metadata: { original_type: page.type },
  };
}
