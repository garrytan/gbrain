/**
 * v0.41.29.0 — orphan source-scoping regression suite.
 *
 * Covers three Codex-flagged behaviors of the `--source` / find_orphans
 * source-scoping wave, all at the layer the bugs live (engine +
 * getOrphansData + the find_orphans op handler):
 *
 *   - A2: candidate-only scoping. A page in source X linked FROM source Y
 *     is reachable, so it is NOT an orphan of X (cross-source inbound counts).
 *   - F6: total_linkable denominator. Excluded NON-orphan pages (e.g. a
 *     `templates/` page that HAS inbound links) must NOT inflate the
 *     denominator. Pre-fix the formula `total - excludedOrphans` left them in.
 *   - F8: the find_orphans MCP op handler scopes by ctx.sourceId AND
 *     ctx.auth.allowedSources (the v0.34.1 source-isolation read leak).
 *
 * Runs against PGLite in-memory (both engines share the SQL surface; the
 * Postgres path is pinned separately in test/e2e/multi-source-bug-class).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { findOrphans } from '../src/commands/orphans.ts';

let engine: PGLiteEngine;

const page = (title: string) => ({
  type: 'person' as const,
  title,
  compiled_truth: `${title} body.`,
  timeline: '',
  frontmatter: {},
});

// Every test in this file is READ-ONLY (findOrphanPages / getOrphansData /
// find_orphans op handler). Seed ONCE in beforeAll rather than reset+reseed
// per test — the canonical R3/R4 pattern (engine in beforeAll, disconnect in
// afterAll) is satisfied, and this cuts the file from ~6min to seconds.
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('src-b', 'src-b', '{}'::jsonb) ON CONFLICT DO NOTHING`,
  );

  // --- default source ---
  // alice-orphan: no inbound → orphan.
  await engine.putPage('people/alice-orphan', page('Alice Orphan'), { sourceId: 'default' });
  // bob-linked: inbound from alice-orphan → NOT orphan.
  await engine.putPage('people/bob-linked', page('Bob Linked'), { sourceId: 'default' });
  // cross-target: inbound ONLY from a src-b page → A2: NOT orphan of default.
  await engine.putPage('people/cross-target', page('Cross Target'), { sourceId: 'default' });
  // templates/junk-linked: excluded prefix, HAS inbound → not orphan, and must
  // be excluded from total_linkable (F6).
  await engine.putPage('templates/junk-linked', page('Junk Template'), { sourceId: 'default' });

  // --- src-b source ---
  // zara-orphan: no inbound → orphan.
  await engine.putPage('people/zara-orphan', page('Zara Orphan'), { sourceId: 'src-b' });
  // src-b-linker: links to default's cross-target; itself has no inbound → orphan.
  await engine.putPage('people/src-b-linker', page('Src-B Linker'), { sourceId: 'src-b' });

  // --- links ---
  await engine.addLink(
    'people/alice-orphan', 'people/bob-linked', '', 'mentions', 'markdown',
    undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' },
  );
  await engine.addLink(
    'people/alice-orphan', 'templates/junk-linked', '', 'mentions', 'markdown',
    undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' },
  );
  // Cross-source inbound: src-b page → default page (A2).
  await engine.addLink(
    'people/src-b-linker', 'people/cross-target', '', 'mentions', 'markdown',
    undefined, undefined, { fromSourceId: 'src-b', toSourceId: 'default' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('findOrphanPages — source scoping (A2)', () => {
  test('scoped to default: alice-orphan is an orphan; cross-source-linked page is NOT', async () => {
    const rows = await engine.findOrphanPages({ sourceId: 'default' });
    const slugs = rows.map(r => r.slug);
    expect(slugs).toContain('people/alice-orphan');
    // A2: cross-target has inbound from src-b → reachable → NOT an orphan.
    expect(slugs).not.toContain('people/cross-target');
    // bob-linked + templates/junk-linked have intra-source inbound.
    expect(slugs).not.toContain('people/bob-linked');
    expect(slugs).not.toContain('templates/junk-linked');
    // src-b pages must not appear in a default-scoped scan.
    expect(slugs).not.toContain('people/zara-orphan');
    expect(slugs).not.toContain('people/src-b-linker');
  });

  test('scoped to src-b returns a different orphan set', async () => {
    const rows = await engine.findOrphanPages({ sourceId: 'src-b' });
    const slugs = rows.map(r => r.slug).sort();
    expect(slugs).toEqual(['people/src-b-linker', 'people/zara-orphan']);
  });

  test('unscoped (brain-wide) returns the union', async () => {
    const rows = await engine.findOrphanPages();
    const slugs = rows.map(r => r.slug).sort();
    expect(slugs).toEqual([
      'people/alice-orphan',
      'people/src-b-linker',
      'people/zara-orphan',
    ]);
  });

  test('federated sourceIds scopes to the union of the given sources', async () => {
    const rows = await engine.findOrphanPages({ sourceIds: ['default', 'src-b'] });
    const slugs = rows.map(r => r.slug).sort();
    expect(slugs).toEqual([
      'people/alice-orphan',
      'people/src-b-linker',
      'people/zara-orphan',
    ]);
    // Single-element federated array behaves like the scalar scope.
    const onlyB = await engine.findOrphanPages({ sourceIds: ['src-b'] });
    expect(onlyB.map(r => r.slug).sort()).toEqual([
      'people/src-b-linker',
      'people/zara-orphan',
    ]);
  });
});

describe('getOrphansData — scoped totals + F6 denominator', () => {
  test('default scope: counts differ from brain-wide; excluded non-orphan drops from total_linkable (F6)', async () => {
    const data = await findOrphans(engine, { includePseudo: false, sourceId: 'default' });
    // 4 live default pages; 1 orphan (alice-orphan).
    expect(data.total_pages).toBe(4);
    expect(data.total_orphans).toBe(1);
    expect(data.orphans.map(o => o.slug)).toEqual(['people/alice-orphan']);
    // F6: templates/junk-linked is an EXCLUDED page that HAS an inbound link.
    // It must NOT count in total_linkable. NEW denominator = total(4) -
    // excludedAll(1) = 3. The pre-fix formula (total - excludedOrphans) left
    // the excluded non-orphan in and returned 4.
    expect(data.total_linkable).toBe(3);
    expect(data.total_linkable).toBe(data.total_pages - 1);
  });

  test('src-b scope: distinct from default', async () => {
    const data = await findOrphans(engine, { includePseudo: false, sourceId: 'src-b' });
    expect(data.total_pages).toBe(2);
    expect(data.total_orphans).toBe(2);
    expect(data.total_linkable).toBe(2); // no excluded pages in src-b
  });

  test('brain-wide F6: excluded non-orphan drops from total_linkable', async () => {
    const data = await findOrphans(engine, { includePseudo: false });
    expect(data.total_pages).toBe(6);
    expect(data.total_orphans).toBe(3);
    // 6 live pages - 1 excluded (templates/junk-linked) = 5.
    expect(data.total_linkable).toBe(5);
  });

  test('includePseudo keeps excluded pages in the denominator', async () => {
    const data = await findOrphans(engine, { includePseudo: true, sourceId: 'default' });
    // No exclusion → denominator is the full live set.
    expect(data.total_linkable).toBe(4);
  });
});

describe('find_orphans MCP op — F8 source-isolation scope', () => {
  test('ctx.sourceId scopes results to that source only', async () => {
    const { operations } = await import('../src/core/operations.ts');
    const op = operations.find(o => o.name === 'find_orphans');
    expect(op).toBeDefined();
    const ctx = {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'src-b',
    };
    const result = (await op!.handler(ctx as any, {})) as { orphans: { slug: string }[] };
    const slugs = result.orphans.map(o => o.slug).sort();
    expect(slugs).toEqual(['people/src-b-linker', 'people/zara-orphan']);
    // Leak guard: default's orphan must NOT appear.
    expect(slugs).not.toContain('people/alice-orphan');
  });

  test('ctx.auth.allowedSources (federated) scopes to the allowed set', async () => {
    const { operations } = await import('../src/core/operations.ts');
    const op = operations.find(o => o.name === 'find_orphans');
    const ctx = {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'default', // scalar would scope to default-only...
      auth: {
        token: 'test',
        clientId: 'test',
        scopes: ['read'],
        sourceId: 'default',
        allowedSources: ['src-b'], // ...but the federated array wins.
      },
    };
    const result = (await op!.handler(ctx as any, {})) as { orphans: { slug: string }[] };
    const slugs = result.orphans.map(o => o.slug).sort();
    expect(slugs).toEqual(['people/src-b-linker', 'people/zara-orphan']);
    expect(slugs).not.toContain('people/alice-orphan');
  });
});
