import { describe, it, expect, mock } from 'bun:test';
import { PostgresGraphAdapter } from './pg-adapter.ts';
import type { MemoryNode, Relation } from '../domain.ts';

function createMockEngine() {
  const pages = new Map<string, any>();

  return {
    getPage: mock(async (slug: string) => {
      return pages.get(slug) ?? null;
    }),
    putPage: mock(async (slug: string, data: any) => {
      pages.set(slug, { slug, ...data });
    }),
    deletePage: mock(async (slug: string) => {
      pages.delete(slug);
    }),
    addLink: mock(async (_from: string, _to: string) => {}),
    getRelatedEntities: mock(async (_slug: string) => {
      return [] as Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }>;
    }),
    traverseGraph: mock(async (slug: string, _depth?: number) => {
      const page = pages.get(slug);
      if (!page) return null;
      return {
        root: { slug, title: page.title ?? slug, type: page.type ?? 'concept' },
        nodes: [],
        edges: [],
      };
    }),
    listPages: mock(async (_opts?: any) => {
      return { pages: Array.from(pages.values()), total: pages.size };
    }),
  };
}

function makeNode(slug: string, title: string, type: string = 'concept'): MemoryNode {
  const now = '2024-01-01T00:00:00Z';
  return {
    id: slug,
    slug,
    type: type as MemoryNode['type'],
    title,
    summary: '',
    source: 'test',
    confidence: 0.8,
    consent: true,
    tags: [],
    created_at: now,
    last_verified_at: now,
    metadata: {},
  };
}

function makeRelation(from: string, to: string, relationType: string = 'related_to'): Relation {
  return {
    from_slug: from,
    to_slug: to,
    relation_type: relationType,
    confidence: 0.9,
    context: '',
    source: 'test',
    created_at: '2024-01-01T00:00:00Z',
  };
}

describe('PostgresGraphAdapter', () => {
  it('creates an entity via engine.putPage', async () => {
    const engine = createMockEngine() as any;
    const adapter = new PostgresGraphAdapter(engine);
    await adapter.createEntity(makeNode('test-entity-1', 'Test Entity'));
    expect(engine.putPage).toHaveBeenCalled();
    const saved = await engine.getPage('test-entity-1');
    expect(saved).not.toBeNull();
  });

  it('returns related entities', async () => {
    const engine = createMockEngine() as any;
    const adapter = new PostgresGraphAdapter(engine);
    const result = await adapter.getRelatedEntities('nonexistent');
    expect(Array.isArray(result)).toBe(true);
  });

  it('traverses the graph', async () => {
    const engine = createMockEngine() as any;
    const adapter = new PostgresGraphAdapter(engine);
    await adapter.createEntity(makeNode('root', 'Root'));
    const result = await adapter.traverseGraph('root', 1);
    expect(result.root.slug).toBe('root');
  });

  it('deleteEntity removes via engine.deletePage', async () => {
    const engine = createMockEngine() as any;
    const adapter = new PostgresGraphAdapter(engine);
    await adapter.createEntity(makeNode('del-test', 'Delete Me'));
    await adapter.deleteEntity('del-test');
    const gone = await engine.getPage('del-test');
    expect(gone).toBeNull();
  });

  it('createRelation stores link metadata', async () => {
    const engine = createMockEngine() as any;
    const adapter = new PostgresGraphAdapter(engine);
    await adapter.createEntity(makeNode('a', 'A'));
    await adapter.createEntity(makeNode('b', 'B'));

    await adapter.createRelation(makeRelation('a', 'b', 'related_to'));
    const pageA = await engine.getPage('a');
    expect(pageA).not.toBeNull();
  });

  it('deleteRelation throws (not yet implemented)', async () => {
    const engine = createMockEngine() as any;
    const adapter = new PostgresGraphAdapter(engine);
    await expect(adapter.deleteRelation('a', 'b', 'related_to')).rejects.toThrow('not implemented');
  });
});
