import type { GraphRepository, GraphTraversalResult } from './types.ts';
import type { MemoryNode, Relation } from '../domain.ts';
import { VALID_MEMORY_TYPES } from '../domain.ts';

interface BrainEngineLike {
  getPage(slug: string): Promise<Record<string, unknown> | null>;
  putPage(slug: string, data: Record<string, unknown>): Promise<void>;
  deletePage(slug: string): Promise<void>;
  addLink(from: string, to: string, context?: string, linkType?: string, linkSource?: string): Promise<void>;
  getRelatedEntities(slug: string): Promise<Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }>>;
  traverseGraph(slug: string, depth?: number): Promise<Record<string, unknown> | null>;
  listPages(opts?: { limit?: number; offset?: number }): Promise<{ pages: Record<string, unknown>[]; total: number }>;
}

export class PostgresGraphAdapter implements GraphRepository {
  constructor(private engine: BrainEngineLike) {}

  async createEntity(node: MemoryNode): Promise<void> {
    await this.engine.putPage(node.slug, {
      title: node.title,
      type: VALID_MEMORY_TYPES.has(node.type) ? node.type : 'concept',
      content: node.summary,
      tags: node.tags,
      metadata: {
        source: node.source,
        confidence: node.confidence,
        consent: node.consent,
        memoryId: node.id,
        created_at: node.created_at,
        last_verified_at: node.last_verified_at,
        ...node.metadata,
      },
    });
  }

  async createRelation(relation: Relation): Promise<void> {
    await this.engine.addLink(
      relation.from_slug,
      relation.to_slug,
      relation.context,
      relation.relation_type,
      'manual',
    );
  }

  async getRelatedEntities(
    slug: string,
  ): Promise<Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }>> {
    return this.engine.getRelatedEntities(slug);
  }

  async traverseGraph(slug: string, depth: number = 1): Promise<GraphTraversalResult> {
    const page = await this.engine.getPage(slug);
    if (!page) {
      return { root: { slug: '', title: '', type: '' }, nodes: [], edges: [] };
    }

    const traversalResult = await this.engine.traverseGraph(slug, depth);

    return {
      root: {
        slug,
        title: ((page as any)?.title as string) ?? slug,
        type: ((page as any)?.type as string) ?? 'unknown',
      },
      nodes: ((traversalResult as any)?.nodes as Array<{ slug: string; title: string; type: string; depth: number }>) ?? [],
      edges: ((traversalResult as any)?.edges as Array<{ from: string; to: string; relation_type: string }>) ?? [],
    };
  }

  async deleteEntity(slug: string): Promise<void> {
    await this.engine.deletePage(slug);
  }

  async deleteRelation(_from: string, _to: string, _relation_type: string): Promise<void> {
    throw new Error('deleteRelation not implemented for PostgresGraphAdapter');
  }
}
