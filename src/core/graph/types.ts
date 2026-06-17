import type { MemoryNode, Relation } from '../domain.ts';

export interface GraphTraversalResult {
  root: { slug: string; title: string; type: string };
  nodes: Array<{ slug: string; title: string; type: string; depth: number }>;
  edges: Array<{ from: string; to: string; relation_type: string }>;
}

export interface GraphRepository {
  createEntity(node: MemoryNode): Promise<void>;
  createRelation(relation: Relation): Promise<void>;
  getRelatedEntities(slug: string): Promise<Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }>>;
  traverseGraph(slug: string, depth?: number): Promise<GraphTraversalResult>;
  deleteEntity(slug: string): Promise<void>;
  deleteRelation(from: string, to: string, relation_type: string): Promise<void>;
}
