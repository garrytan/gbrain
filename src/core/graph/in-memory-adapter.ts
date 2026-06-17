import type { MemoryNode, Relation } from '../domain.ts';
import type { GraphRepository, GraphTraversalResult } from './types.ts';

export class InMemoryGraphAdapter implements GraphRepository {
  private nodes = new Map<string, MemoryNode>();
  private outgoing = new Map<string, Relation[]>();
  private incoming = new Map<string, Relation[]>();

  async createEntity(node: MemoryNode): Promise<void> {
    this.nodes.set(node.slug, node);
  }

  async createRelation(relation: Relation): Promise<void> {
    const out = this.outgoing.get(relation.from_slug) ?? [];
    out.push(relation);
    this.outgoing.set(relation.from_slug, out);

    const inc = this.incoming.get(relation.to_slug) ?? [];
    inc.push(relation);
    this.incoming.set(relation.to_slug, inc);
  }

  async getRelatedEntities(slug: string): Promise<Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }>> {
    const results: Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }> = [];

    const outEdges = this.outgoing.get(slug) ?? [];
    for (const edge of outEdges) {
      results.push({ slug: edge.to_slug, relation_type: edge.relation_type, direction: 'outgoing' });
    }

    const inEdges = this.incoming.get(slug) ?? [];
    for (const edge of inEdges) {
      results.push({ slug: edge.from_slug, relation_type: edge.relation_type, direction: 'incoming' });
    }

    return results;
  }

  async traverseGraph(slug: string, depth = 1): Promise<GraphTraversalResult> {
    const rootNode = this.nodes.get(slug);
    if (!rootNode) {
      return { root: { slug, title: '', type: '' }, nodes: [], edges: [] };
    }

    const root = { slug: rootNode.slug, title: rootNode.title, type: rootNode.type };
    const visited = new Set<string>([slug]);
    const nodes: Array<{ slug: string; title: string; type: string; depth: number }> = [];
    const edges: Array<{ from: string; to: string; relation_type: string }> = [];
    const queue: Array<{ slug: string; currentDepth: number }> = [{ slug, currentDepth: 0 }];

    while (queue.length > 0) {
      const { slug: currentSlug, currentDepth } = queue.shift()!;
      if (currentDepth >= depth) continue;

      const outEdges = this.outgoing.get(currentSlug) ?? [];
      for (const edge of outEdges) {
        edges.push({ from: edge.from_slug, to: edge.to_slug, relation_type: edge.relation_type });
        if (!visited.has(edge.to_slug)) {
          visited.add(edge.to_slug);
          const target = this.nodes.get(edge.to_slug);
          nodes.push({
            slug: edge.to_slug,
            title: target?.title ?? '',
            type: target?.type ?? '',
            depth: currentDepth + 1,
          });
          queue.push({ slug: edge.to_slug, currentDepth: currentDepth + 1 });
        }
      }

      const inEdges = this.incoming.get(currentSlug) ?? [];
      for (const edge of inEdges) {
        edges.push({ from: edge.from_slug, to: edge.to_slug, relation_type: edge.relation_type });
        if (!visited.has(edge.from_slug)) {
          visited.add(edge.from_slug);
          const target = this.nodes.get(edge.from_slug);
          nodes.push({
            slug: edge.from_slug,
            title: target?.title ?? '',
            type: target?.type ?? '',
            depth: currentDepth + 1,
          });
          queue.push({ slug: edge.from_slug, currentDepth: currentDepth + 1 });
        }
      }
    }

    return { root, nodes, edges };
  }

  async deleteEntity(slug: string): Promise<void> {
    this.nodes.delete(slug);
    this.outgoing.delete(slug);
    this.incoming.delete(slug);

    for (const [from, edges] of this.outgoing.entries()) {
      const filtered = edges.filter(e => e.to_slug !== slug);
      if (filtered.length === 0) {
        this.outgoing.delete(from);
      } else {
        this.outgoing.set(from, filtered);
      }
    }

    for (const [to, edges] of this.incoming.entries()) {
      const filtered = edges.filter(e => e.from_slug !== slug);
      if (filtered.length === 0) {
        this.incoming.delete(to);
      } else {
        this.incoming.set(to, filtered);
      }
    }
  }

  async deleteRelation(from: string, to: string, relation_type: string): Promise<void> {
    const outEdges = this.outgoing.get(from);
    if (outEdges) {
      const filtered = outEdges.filter(e => !(e.to_slug === to && e.relation_type === relation_type));
      if (filtered.length === 0) {
        this.outgoing.delete(from);
      } else {
        this.outgoing.set(from, filtered);
      }
    }

    const inEdges = this.incoming.get(to);
    if (inEdges) {
      const filtered = inEdges.filter(e => !(e.from_slug === from && e.relation_type === relation_type));
      if (filtered.length === 0) {
        this.incoming.delete(to);
      } else {
        this.incoming.set(to, filtered);
      }
    }
  }
}
