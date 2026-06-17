import { describe, test, expect } from 'bun:test';
import { InMemoryGraphAdapter } from './in-memory-adapter.ts';
import { enrichWithRelatedMemories } from './search-enrichment.ts';
import type { GraphRepository } from './types.ts';
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

describe('enrichWithRelatedMemories', () => {
  test('enrichment adds related memories', async () => {
    const graph = new InMemoryGraphAdapter();
    await graph.createEntity(makeNode('alice', 'Alice', 'person'));
    await graph.createEntity(makeNode('bob', 'Bob', 'person'));
    await graph.createRelation(makeRelation('alice', 'bob', 'knows'));

    const results = await enrichWithRelatedMemories(
      [{ slug: 'alice', title: 'Alice' }],
      graph,
    );

    expect(results).toHaveLength(1);
    expect(results[0].related_memories).toHaveLength(1);
    expect(results[0].related_memories[0].slug).toBe('bob');
    expect(results[0].related_memories[0].relation_type).toBe('knows');
  });

  test('enrichment handles empty results gracefully', async () => {
    const graph = new InMemoryGraphAdapter();

    const results = await enrichWithRelatedMemories([], graph);

    expect(results).toHaveLength(0);
  });

  test('graph failure produces degraded results', async () => {
    const throwingGraph: GraphRepository = {
      async createEntity() {},
      async createRelation() {},
      async getRelatedEntities() { throw new Error('db down'); },
      async traverseGraph() { throw new Error('db down'); },
      async deleteEntity() {},
      async deleteRelation() {},
    };

    const results = await enrichWithRelatedMemories(
      [{ slug: 'alice', title: 'Alice' }],
      throwingGraph,
    );

    expect(results).toHaveLength(1);
    expect(results[0].related_memories).toEqual([]);
    expect(results[0].slug).toBe('alice');
    expect(results[0].title).toBe('Alice');
  });

  test('maxPerResult limits related memories', async () => {
    const graph = new InMemoryGraphAdapter();
    await graph.createEntity(makeNode('alice', 'Alice', 'person'));
    await graph.createEntity(makeNode('bob', 'Bob', 'person'));
    await graph.createEntity(makeNode('carol', 'Carol', 'person'));
    await graph.createEntity(makeNode('dave', 'Dave', 'person'));
    await graph.createRelation(makeRelation('alice', 'bob', 'knows'));
    await graph.createRelation(makeRelation('alice', 'carol', 'knows'));
    await graph.createRelation(makeRelation('alice', 'dave', 'knows'));

    const results = await enrichWithRelatedMemories(
      [{ slug: 'alice', title: 'Alice' }],
      graph,
      2,
    );

    expect(results).toHaveLength(1);
    expect(results[0].related_memories).toHaveLength(2);
  });
});
