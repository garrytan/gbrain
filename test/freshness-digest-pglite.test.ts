import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { generateDigest, digestToMarkdown, computeFreshness } from '../src/core/freshness/index.ts';
import type { DigestPage } from '../src/core/freshness/digest.ts';
import type { FreshnessMeta } from '../src/core/freshness/types.ts';
import { PostgresGraphAdapter } from '../src/core/graph/pg-adapter.ts';
import { pageToMemoryNode } from '../src/core/graph/index.ts';
import { runReconcileCheck } from '../src/core/freshness/reconcile.ts';

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

async function seedFreshPages() {
  await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: 'CEO of Acme', timeline: '' });
  await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: 'Funded', timeline: '' });
  await engine.addTag('people/alice', 'person');
  await engine.addTag('companies/acme', 'company');
}

describe('freshness digest integration (PGLite)', () => {
  beforeEach(async () => {
    await truncateAll();
    adapter = new PostgresGraphAdapter(engine as any);
  });

  test('generateDigest returns items for manually constructed DigestPages', async () => {
    const freshness: FreshnessMeta = {
      last_verified_at: new Date().toISOString(),
      source_precision: 'high',
      confidence: 0.8,
      decay_class: 'fast',
      stale_after_days: 30,
    };
    const pages: DigestPage[] = [{
      slug: 'people/alice',
      title: 'Alice',
      pageType: 'person',
      freshness,
    }, {
      slug: 'companies/acme',
      title: 'Acme',
      pageType: 'company',
      freshness,
    }];

    const digest = generateDigest(pages);
    expect(digest.items.length).toBeGreaterThanOrEqual(2);

    const aliceItem = digest.items.find(i => i.slug === 'people/alice');
    expect(aliceItem).toBeDefined();
    expect(aliceItem!.slug).toBe('people/alice');
    expect(aliceItem!.pageType).toBe('person');
    expect(aliceItem!.status).toBeDefined();
    expect(typeof aliceItem!.days_since_verified).toBe('number');
  });

  test('digestToMarkdown produces non-empty markdown', async () => {
    const freshness: FreshnessMeta = {
      last_verified_at: new Date().toISOString(),
      source_precision: 'high',
      confidence: 0.8,
      decay_class: 'fast',
      stale_after_days: 30,
    };
    const digest = generateDigest([{
      slug: 'people/alice',
      title: 'Alice',
      pageType: 'person',
      freshness,
    }]);
    const md = digestToMarkdown(digest);
    expect(md.length).toBeGreaterThan(0);
    expect(md).toContain('people/alice');
    expect(md).toContain('Alice');
  });

  test('runReconcileCheck returns no errors when all pages have incoming links', async () => {
    await seedFreshPages();
    await adapter.createEntity(pageToMemoryNode({
      slug: 'people/alice',
      title: 'Alice',
      type: 'person',
      tags: [],
      content: 'CEO',
    }));
    await adapter.createEntity(pageToMemoryNode({
      slug: 'companies/acme',
      title: 'Acme',
      type: 'company',
      tags: [],
      content: 'Funding',
    }));
    await engine.addLink('people/alice', 'companies/acme', 'works_at', 'works_at', 'voice');
    await engine.addLink('companies/acme', 'people/alice', 'references', 'references', 'voice');

    const reconcilePages = [{ slug: 'people/alice' }, { slug: 'companies/acme' }];
    const reconcileLinks = [{ from_slug: 'people/alice', to_slug: 'companies/acme' }, { from_slug: 'companies/acme', to_slug: 'people/alice' }];
    const report = await runReconcileCheck(reconcilePages, adapter, reconcileLinks);
    const orphanFindings = report.findings.filter(f => f.category === 'orphan_page');
    expect(orphanFindings.length).toBe(0);
  });

  test('runReconcileCheck flags orphan pages', async () => {
    await adapter.createEntity(pageToMemoryNode({
      slug: 'people/alice',
      title: 'Alice',
      type: 'person',
      tags: [],
      content: 'CEO',
    }));
    await adapter.createEntity(pageToMemoryNode({
      slug: 'companies/acme',
      title: 'Acme',
      type: 'company',
      tags: [],
      content: 'Funding',
    }));
    await adapter.createEntity(pageToMemoryNode({
      slug: 'orphan-page',
      title: 'Orphan',
      type: 'concept',
      tags: [],
      content: 'No links',
    }));
    await engine.addLink('people/alice', 'companies/acme', 'works_at', 'works_at', 'voice');

    const reconcilePages = [{ slug: 'people/alice' }, { slug: 'orphan-page' }];
    const reconcileLinks: Array<{ from_slug: string; to_slug: string }> = [];
    const report = await runReconcileCheck(reconcilePages, adapter, reconcileLinks);
    const orphanFinding = report.findings.find(f => f.category === 'orphan_page' && f.slug === 'orphan-page');
    expect(orphanFinding).toBeDefined();
    expect(orphanFinding!.slug).toBe('orphan-page');
  });

  test('runReconcileCheck returns empty report for empty input', async () => {
    const report = await runReconcileCheck([], adapter, []);
    expect(report.findings).toEqual([]);
  });
});
