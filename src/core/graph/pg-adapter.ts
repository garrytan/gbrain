import type { GraphRepository, GraphTraversalResult } from './types.ts';
import type { MemoryNode, Relation } from '../domain.ts';
import { VALID_MEMORY_TYPES } from '../domain.ts';

interface BrainEngineLike {
  getPage(slug: string): Promise<Record<string, unknown> | null>;
  putPage(slug: string, data: Record<string, unknown>): Promise<void>;
  deletePage(slug: string): Promise<void>;
  addTag(slug: string, tag: string): Promise<void>;
  addLink(from: string, to: string, context?: string, linkType?: string, linkSource?: string): Promise<void>;
  getLinks(slug: string): Promise<Array<{ to_slug: string; link_type: string; link_source?: string }>>;
  getBacklinks(slug: string): Promise<Array<{ from_slug: string; link_type: string; link_source?: string }>>;
  traverseGraph(slug: string, depth?: number): Promise<Array<{ slug: string; title: string; type: string; depth: number; links: Array<{ to_slug: string; link_type: string }> }>>;
  listPages(opts?: { limit?: number; offset?: number }): Promise<Array<Record<string, unknown>>>;
}

export class PostgresGraphAdapter implements GraphRepository {
  constructor(private engine: BrainEngineLike) {}

  async createEntity(node: MemoryNode): Promise<void> {
    await this.engine.putPage(node.slug, {
      title: node.title,
      type: VALID_MEMORY_TYPES.has(node.type) ? node.type : 'concept',
      compiled_truth: node.summary,
      frontmatter: {
        source: node.source,
        confidence: node.confidence,
        consent: node.consent,
        memoryId: node.id,
        created_at: node.created_at,
        last_verified_at: node.last_verified_at,
        ...node.metadata,
      },
    });
    for (const tag of node.tags) {
      await this.engine.addTag(node.slug, tag);
    }
  }

  async createRelation(relation: Relation): Promise<void> {
    await this.engine.addLink( // gbrain-allow-direct-insert: PostgresGraphAdapter is the authorized graph-repository layer for link writes
      relation.from_slug,
      relation.to_slug,
      relation.context,
      relation.relation_type,
      relation.source,
    );
  }

  async getRelatedEntities(
    slug: string,
  ): Promise<Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }>> {
    const [outgoing, incoming] = await Promise.all([
      this.engine.getLinks(slug),
      this.engine.getBacklinks(slug),
    ]);
    const result: Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }> = [];
    for (const link of outgoing) {
      result.push({ slug: link.to_slug, relation_type: link.link_type, direction: 'outgoing' });
    }
    for (const link of incoming) {
      result.push({ slug: link.from_slug, relation_type: link.link_type, direction: 'incoming' });
    }
    return result;
  }

  async traverseGraph(slug: string, depth: number = 1): Promise<GraphTraversalResult> {
    const page = await this.engine.getPage(slug);
    if (!page) {
      return { root: { slug: '', title: '', type: '' }, nodes: [], edges: [] };
    }

    const graphNodes = await this.engine.traverseGraph(slug, depth);
    const nodes: Array<{ slug: string; title: string; type: string; depth: number }> = [];
    const edges: Array<{ from: string; to: string; relation_type: string }> = [];

    for (const gn of graphNodes) {
      nodes.push({ slug: gn.slug, title: gn.title, type: gn.type, depth: gn.depth });
      for (const link of gn.links) {
        edges.push({ from: gn.slug, to: link.to_slug, relation_type: link.link_type });
      }
    }

    return {
      root: {
        slug,
        title: ((page as any)?.title as string) ?? slug,
        type: ((page as any)?.type as string) ?? 'unknown',
      },
      nodes,
      edges,
    };
  }

  async deleteEntity(slug: string): Promise<void> {
    await this.engine.deletePage(slug);
  }

  async deleteRelation(_from: string, _to: string, _relation_type: string): Promise<void> {
    throw new Error('deleteRelation not implemented for PostgresGraphAdapter');
  }
}
