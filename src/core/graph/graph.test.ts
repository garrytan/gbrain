import { describe, test, expect } from 'bun:test';
import { InMemoryGraphAdapter } from './in-memory-adapter.ts';
import type { MemoryNode, Relation } from '../domain.ts';

function makeNode(slug: string, title: string, type: string = 'concept'): MemoryNode {
  const now = new Date().toISOString();
  return {
    id: slug,
    slug,
    type: type as MemoryNode['type'],
    title,
    summary: '',
    source: 'gbrain-sync',
    confidence: 0.8,
    consent: true,
    tags: [],
    created_at: now,
    last_verified_at: now,
    metadata: {},
  };
}

function makeRelation(from: string, to: string, relation_type: string = 'related_to'): Relation {
  return {
    from_slug: from,
    to_slug: to,
    relation_type,
    confidence: 0.9,
    context: '',
    source: 'gbrain-sync',
    created_at: new Date().toISOString(),
  };
}

describe('InMemoryGraphAdapter', () => {
  test('create entity and retrieve related', async () => {
    const graph = new InMemoryGraphAdapter();
    await graph.createEntity(makeNode('alice', 'Alice', 'person'));

    const related = await graph.getRelatedEntities('alice');
    expect(related).toHaveLength(0);
  });

  test('create relation between two entities', async () => {
    const graph = new InMemoryGraphAdapter();
    await graph.createEntity(makeNode('alice', 'Alice', 'person'));
    await graph.createEntity(makeNode('bob', 'Bob', 'person'));
    await graph.createRelation(makeRelation('alice', 'bob', 'knows'));

    const aliceRelated = await graph.getRelatedEntities('alice');
    expect(aliceRelated).toHaveLength(1);
    expect(aliceRelated[0].slug).toBe('bob');
    expect(aliceRelated[0].relation_type).toBe('knows');
    expect(aliceRelated[0].direction).toBe('outgoing');

    const bobRelated = await graph.getRelatedEntities('bob');
    expect(bobRelated).toHaveLength(1);
    expect(bobRelated[0].slug).toBe('alice');
    expect(bobRelated[0].direction).toBe('incoming');
  });

  test('traverse graph with depth 1', async () => {
    const graph = new InMemoryGraphAdapter();
    await graph.createEntity(makeNode('alice', 'Alice', 'person'));
    await graph.createEntity(makeNode('bob', 'Bob', 'person'));
    await graph.createRelation(makeRelation('alice', 'bob', 'knows'));

    const result = await graph.traverseGraph('alice', 1);
    expect(result.root.slug).toBe('alice');
    expect(result.root.title).toBe('Alice');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].slug).toBe('bob');
    expect(result.nodes[0].depth).toBe(1);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].from).toBe('alice');
    expect(result.edges[0].to).toBe('bob');
  });

  test('traverse graph with depth 2 returns second-degree nodes', async () => {
    const graph = new InMemoryGraphAdapter();
    await graph.createEntity(makeNode('alice', 'Alice', 'person'));
    await graph.createEntity(makeNode('bob', 'Bob', 'person'));
    await graph.createEntity(makeNode('carol', 'Carol', 'person'));
    await graph.createRelation(makeRelation('alice', 'bob', 'knows'));
    await graph.createRelation(makeRelation('bob', 'carol', 'knows'));

    const result = await graph.traverseGraph('alice', 2);
    expect(result.root.slug).toBe('alice');
    expect(result.nodes).toHaveLength(2);

    const depths = result.nodes.map(n => n.depth).sort();
    expect(depths).toEqual([1, 2]);

    const slugs = result.nodes.map(n => n.slug);
    expect(slugs).toContain('bob');
    expect(slugs).toContain('carol');
  });

  test('delete entity cascades related relations', async () => {
    const graph = new InMemoryGraphAdapter();
    await graph.createEntity(makeNode('alice', 'Alice'));
    await graph.createEntity(makeNode('bob', 'Bob'));
    await graph.createRelation(makeRelation('alice', 'bob'));

    await graph.deleteEntity('alice');

    const aliceRelated = await graph.getRelatedEntities('alice');
    expect(aliceRelated).toHaveLength(0);

    const bobRelated = await graph.getRelatedEntities('bob');
    expect(bobRelated).toHaveLength(0);
  });

  test('delete relation removes specific edge only', async () => {
    const graph = new InMemoryGraphAdapter();
    await graph.createEntity(makeNode('alice', 'Alice'));
    await graph.createEntity(makeNode('bob', 'Bob'));
    await graph.createEntity(makeNode('carol', 'Carol'));
    await graph.createRelation(makeRelation('alice', 'bob', 'knows'));
    await graph.createRelation(makeRelation('alice', 'carol', 'knows'));

    await graph.deleteRelation('alice', 'bob', 'knows');

    const related = await graph.getRelatedEntities('alice');
    expect(related).toHaveLength(1);
    expect(related[0].slug).toBe('carol');
  });

  test('empty graph returns empty traversal', async () => {
    const graph = new InMemoryGraphAdapter();

    const result = await graph.traverseGraph('nonexistent', 1);
    expect(result.root.slug).toBe('nonexistent');
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});
