import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresGraphAdapter } from '../src/core/graph/pg-adapter.ts';
import type { MemoryNode, Relation } from '../src/core/domain.ts';

let engine: PGLiteEngine;
let adapter: PostgresGraphAdapter;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  for (const t of ['links', 'tags', 'pages', 'sources']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('default', 'default', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
  );
}

describe('PostgresGraphAdapter integration (PGLite)', () => {
  beforeEach(() => {
    truncateAll();
    adapter = new PostgresGraphAdapter(engine as any);
  });

  test('createEntity creates a page via engine', async () => {
    const node: MemoryNode = {
      id: 'alice',
      slug: 'people/alice',
      type: 'person',
      title: 'Alice',
      summary: 'CEO of Acme',
      source: 'voice',
      confidence: 0.8,
      consent: true,
      tags: ['person', 'voice'],
      created_at: '2026-06-17T00:00:00.000Z',
      last_verified_at: '2026-06-17T00:00:00.000Z',
      metadata: {},
    };

    await adapter.createEntity(node);

    const page = await engine.getPage('people/alice');
    expect(page).not.toBeNull();
    expect(page!.slug).toBe('people/alice');
    expect(page!.type).toBe('person');
    expect(page!.title).toBe('Alice');
  });

  test('createEntity upserts on duplicate slug (no throw)', async () => {
    const node: MemoryNode = {
      id: 'alice',
      slug: 'people/alice',
      type: 'person',
      title: 'Alice',
      summary: 'CEO',
      source: 'voice',
      confidence: 0.7,
      consent: true,
      tags: [],
      created_at: new Date().toISOString(),
      last_verified_at: new Date().toISOString(),
      metadata: {},
    };

    await adapter.createEntity(node);
    const updated: MemoryNode = { ...node, title: 'Alice Updated' };
    await expect(adapter.createEntity(updated)).resolves.toBeUndefined();
    const page = await engine.getPage('people/alice');
    expect(page!.title).toBe('Alice Updated');
  });

  test('createEntity stores tags in tags table', async () => {
    const node: MemoryNode = {
      id: 'alice',
      slug: 'people/alice',
      type: 'person',
      title: 'Alice',
      summary: '',
      source: 'voice',
      confidence: 0.6,
      consent: false,
      tags: ['person', 'founder', 'voice'],
      created_at: '2026-06-17T00:00:00.000Z',
      last_verified_at: '2026-06-17T00:00:00.000Z',
      metadata: {},
    };

    await adapter.createEntity(node);
    const tags = await engine.getTags('people/alice');
    expect(tags.sort()).toEqual(['founder', 'person', 'voice']);
  });

  test('createRelation and traverseGraph', async () => {
    await adapter.createEntity(makeNode('people/alice', 'person', 'Alice'));
    await adapter.createEntity(makeNode('companies/acme', 'company', 'Acme'));
    await adapter.createEntity(makeNode('people/bob', 'person', 'Bob'));

    const rel1: Relation = {
      from_slug: 'people/alice',
      to_slug: 'companies/acme',
      relation_type: 'works_at',
      confidence: 0.9,
      context: 'Alice works at Acme',
      source: 'voice',
      created_at: '2026-06-17T00:00:00.000Z',
    };

    const rel2: Relation = {
      from_slug: 'people/bob',
      to_slug: 'companies/acme',
      relation_type: 'invested_in',
      confidence: 0.8,
      context: 'Bob invested in Acme',
      source: 'voice',
      created_at: '2026-06-17T00:00:00.000Z',
    };

    await adapter.createRelation(rel1);
    await adapter.createRelation(rel2);

    const links = await engine.getLinks('people/alice');
    const acmeLink = links.find(l => l.to_slug === 'companies/acme');
    expect(acmeLink).toBeDefined();
    expect(acmeLink!.link_type).toBe('works_at');

    const traverse = await adapter.traverseGraph('people/alice', 1);
    expect(traverse.nodes.length).toBeGreaterThanOrEqual(1);
    const acmeNode = traverse.nodes.find(n => n.slug === 'companies/acme');
    expect(acmeNode).toBeDefined();
    const acmeEdge = traverse.edges.find(e => e.to === 'companies/acme');
    expect(acmeEdge).toBeDefined();
    expect(acmeEdge!.relation_type).toBe('works_at');
  });

  test('traverseGraph returns empty for nonexistent slug', async () => {
    const result = await adapter.traverseGraph('nonexistent', 1);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  test('getRelatedEntities returns outgoing EntityLinks', async () => {
    await adapter.createEntity(makeNode('people/alice', 'person', 'Alice'));
    await adapter.createEntity(makeNode('companies/acme', 'company', 'Acme'));

    await adapter.createRelation({
      from_slug: 'people/alice',
      to_slug: 'companies/acme',
      relation_type: 'works_at',
      confidence: 0.9,
      context: '',
      source: 'voice',
      created_at: '2026-06-17T00:00:00.000Z',
    });

    const related = await adapter.getRelatedEntities('people/alice');
    expect(related.length).toBe(1);
    expect(related[0].slug).toBe('companies/acme');
    expect(related[0].relation_type).toBe('works_at');
    expect(related[0].direction).toBe('outgoing');
  });

  test('createRelation propagates source field', async () => {
    await adapter.createEntity(makeNode('a', 'note', 'A'));
    await adapter.createEntity(makeNode('b', 'note', 'B'));

    await adapter.createRelation({
      from_slug: 'a',
      to_slug: 'b',
      relation_type: 'mentions',
      confidence: 0.5,
      context: 'test',
      source: 'deepgram',
      created_at: '2026-06-17T00:00:00.000Z',
    });

    const links = await engine.getLinks('a');
    const link = links.find(l => l.to_slug === 'b');
    expect(link?.link_source).toBe('deepgram');
  });

  test('pageToMemoryNode preserves created_at when provided', async () => {
    const { pageToMemoryNode } = await import('../src/core/graph/index.ts');
    const ts = '2025-01-15T10:30:00.000Z';
    const node = pageToMemoryNode({
      slug: 'test',
      title: 'Test',
      type: 'person',
      tags: [],
      content: 'Hello world',
      createdAt: ts,
    });
    expect(node.created_at).toBe(ts);
    expect(node.last_verified_at).toBe(ts);
  });

  test('pageToMemoryNode defaults created_at to now', async () => {
    const { pageToMemoryNode } = await import('../src/core/graph/index.ts');
    const before = new Date().toISOString();
    const node = pageToMemoryNode({
      slug: 'test',
      title: 'Test',
      type: 'concept',
      tags: ['voice'],
    });
    const after = new Date().toISOString();
    expect(node.created_at >= before).toBe(true);
    expect(node.created_at <= after).toBe(true);
    expect(node.last_verified_at).toBe(node.created_at);
  });
});

function makeNode(slug: string, type: string, title: string): MemoryNode {
  return {
    id: slug,
    slug,
    type: type as any,
    title,
    summary: '',
    source: 'voice',
    confidence: 0.7,
    consent: true,
    tags: [],
    created_at: new Date().toISOString(),
    last_verified_at: new Date().toISOString(),
    metadata: {},
  };
}
