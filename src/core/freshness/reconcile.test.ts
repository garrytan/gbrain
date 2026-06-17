import { describe, test, expect } from 'bun:test';
import { runReconcileCheck } from './reconcile.ts';
import type { ReconcilePage, ReconcileGraph, ReconcileLink } from './reconcile.ts';

class MockGraph implements ReconcileGraph {
  private related = new Map<string, Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }>>();

  setRelated(slug: string, rels: Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }>) {
    this.related.set(slug, rels);
  }

  async getRelatedEntities(slug: string): Promise<Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }>> {
    return this.related.get(slug) ?? [];
  }
}

describe('runReconcileCheck', () => {
  test('page with no links → orphan_page finding', async () => {
    const pages: ReconcilePage[] = [{ slug: 'orphan-page' }];
    const graph = new MockGraph();
    graph.setRelated('orphan-page', []);
    const links: ReconcileLink[] = [];

    const report = await runReconcileCheck(pages, graph, links);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].category).toBe('orphan_page');
    expect(report.findings[0].severity).toBe('info');
    expect(report.findings[0].slug).toBe('orphan-page');
  });

  test('link to non-existent slug → dangling_link finding', async () => {
    const pages: ReconcilePage[] = [{ slug: 'existing-page' }];
    const graph = new MockGraph();
    graph.setRelated('existing-page', []);
    const links: ReconcileLink[] = [{ from_slug: 'existing-page', to_slug: 'missing-page' }];

    const report = await runReconcileCheck(pages, graph, links);

    const dangling = report.findings.filter(f => f.category === 'dangling_link');
    expect(dangling).toHaveLength(1);
    expect(dangling[0].severity).toBe('warning');
    expect(dangling[0].slug).toBe('existing-page');
    expect(dangling[0].message).toContain('missing-page');
  });

  test('page with duplicate tags → duplicate_tag finding', async () => {
    const pages: ReconcilePage[] = [{ slug: 'tagged-page', tags: ['ai', 'ml', 'ai'] }];
    const graph = new MockGraph();
    graph.setRelated('tagged-page', [{ slug: 'other', relation_type: 'related_to', direction: 'outgoing' }]);
    const links: ReconcileLink[] = [];

    const report = await runReconcileCheck(pages, graph, links);

    const dup = report.findings.filter(f => f.category === 'duplicate_tag');
    expect(dup).toHaveLength(1);
    expect(dup[0].severity).toBe('info');
    expect(dup[0].slug).toBe('tagged-page');
    expect(dup[0].message).toContain('ai');
  });

  test('healthy page → no findings for that page', async () => {
    const pages: ReconcilePage[] = [{ slug: 'healthy', tags: ['a', 'b'] }, { slug: 'other' }];
    const graph = new MockGraph();
    graph.setRelated('healthy', [{ slug: 'other', relation_type: 'related_to', direction: 'outgoing' }]);
    graph.setRelated('other', [{ slug: 'healthy', relation_type: 'related_to', direction: 'incoming' }]);
    const links: ReconcileLink[] = [{ from_slug: 'healthy', to_slug: 'other' }];

    const report = await runReconcileCheck(pages, graph, links);

    expect(report.findings).toHaveLength(0);
  });

  test('empty pages → empty report', async () => {
    const report = await runReconcileCheck([], new MockGraph(), []);
    expect(report.findings).toHaveLength(0);
  });

  test('multiple orphan pages each get their own finding', async () => {
    const pages: ReconcilePage[] = [{ slug: 'orphan-a' }, { slug: 'orphan-b' }, { slug: 'orphan-c' }];
    const graph = new MockGraph();
    graph.setRelated('orphan-a', []);
    graph.setRelated('orphan-b', []);
    graph.setRelated('orphan-c', []);

    const report = await runReconcileCheck(pages, graph, []);

    expect(report.findings).toHaveLength(3);
    for (const f of report.findings) {
      expect(f.category).toBe('orphan_page');
    }
  });
});
