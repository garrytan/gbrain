import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { formatResult } from '../src/cli.ts';
import { formatResultExplain } from '../src/core/search/explain-formatter.ts';
import { stampAtomSourceDrift } from '../src/core/search/source-drift.ts';
import { runGather } from '../src/core/think/gather.ts';

let engine: PGLiteEngine;
const op = (name: string) => operations.find(o => o.name === name)!;
const context = (sourceId = 'default'): OperationContext => ({
  engine, config: {}, logger: console, dryRun: false, remote: false, sourceId,
} as unknown as OperationContext);
const run = (name: string, params: Record<string, unknown>, sourceId?: string) =>
  op(name).handler(context(sourceId), params) as Promise<any>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT (id) DO NOTHING");
  for (const sourceId of ['default', 'other']) {
    await engine.putPage('notes/origin', { type: 'note', title: 'Origin', compiled_truth: `original ${sourceId}` }, { sourceId });
    const source = await engine.getPage('notes/origin', { sourceId });
    const sourceHash = source!.content_hash!.slice(0, 16);
    for (const [slug, hash] of [
      ['atoms/driftcase', sourceId === 'default' ? 'wrong-hash' : sourceHash],
      ['atoms/orphancase', sourceHash],
      ['atoms/legacycase', sourceHash],
    ]) {
      await engine.putPage(slug, {
        type: 'atom', title: slug, compiled_truth: `uniquedriftneedle ${slug} ${sourceId}`,
        frontmatter: { source_slug: slug === 'atoms/orphancase' ? 'notes/missing' : 'notes/origin', source_hash: hash },
      }, { sourceId });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: `uniquedriftneedle ${slug} ${sourceId}`, chunk_source: 'compiled_truth' }], { sourceId });
    }
    await engine.putPage('atoms/legacycase', {
      type: 'atom', title: 'Legacy', compiled_truth: 'uniquedriftneedle legacy', frontmatter: {},
    }, { sourceId });
  }
  await engine.putPage('atoms/hash-without-origin', {
    type: 'atom', title: 'Missing origin locator', compiled_truth: 'uniquedriftneedle missing origin locator',
    frontmatter: { source_hash: 'abcdabcdabcdabcd' },
  });
});
afterAll(async () => { await engine.disconnect(); });

describe('source-drift provenance on retrieval', () => {
  test('search and query stamp drift, missing origin, same-source verified, and legacy', async () => {
    for (const name of ['search', 'query']) {
      for (const sourceId of ['default', 'other']) {
        const params = { query: 'uniquedriftneedle', source_id: sourceId, limit: 20, ...(name === 'query' ? { expand: false, use_cache: true, autocut: false } : {}) };
        const first = await run(name, params);
        const second = await run(name, params);
        for (const results of [first, second]) {
          const bySlug = new Map<string, any>(results.map((r: any) => [r.slug, r]));
          expect(bySlug.get('atoms/driftcase')?.unverified_source_drift).toBe(sourceId === 'default' ? true : undefined);
          expect(bySlug.get('atoms/orphancase')?.unverified_source_drift).toBe(true);
          expect(bySlug.get('atoms/legacycase')?.unverified_source_drift).toBeUndefined();
          expect(results.every((r: any) => r.source_id === sourceId)).toBe(true);
        }
      }
    }
    await engine.setConfig('search.mcp_keyword_only', 'true');
    try {
      const results = await run('search', { query: 'uniquedriftneedle', source_id: 'default' });
      expect(results.find((r: any) => r.slug === 'atoms/driftcase')?.unverified_source_drift).toBe(true);
    } finally { await engine.setConfig('search.mcp_keyword_only', 'false'); }
  });

  test('get_page and fetch carry the flag only for drifted atom in resolved source', async () => {
    const bad = await run('get_page', { slug: 'atoms/driftcase' });
    expect(bad.unverified_source_drift).toBe(true);
    const fetched = await run('fetch', { id: 'atoms/driftcase' });
    expect(fetched.unverified_source_drift).toBe(true);
    expect(fetched.metadata.unverified_source_drift).toBe(true);
    expect((await run('get_page', { slug: 'atoms/driftcase', source_id: 'other' })).unverified_source_drift).toBeUndefined();
    expect((await run('get_page', { slug: 'atoms/orphancase' })).unverified_source_drift).toBe(true);
    expect((await run('get_page', { slug: 'atoms/legacycase' })).unverified_source_drift).toBeUndefined();
    expect((await run('get_page', { slug: 'atoms/hash-without-origin' })).unverified_source_drift).toBe(true);
  });

  test('live source edits change provenance; lookup failures never assert verification', async () => {
    const params = { query: 'uniquedriftneedle', source_id: 'other' };
    expect((await run('search', params)).find((r: any) => r.slug === 'atoms/driftcase')?.unverified_source_drift).toBeUndefined();
    await engine.putPage('notes/origin', { type: 'note', title: 'Origin', compiled_truth: 'edited other' }, { sourceId: 'other' });
    expect((await run('search', params)).find((r: any) => r.slug === 'atoms/driftcase')?.unverified_source_drift).toBe(true);
    const fakeEngine = { executeRaw: async () => { throw new Error('lookup unavailable'); } } as any;
    const atoms = [{ type: 'atom', page_id: 999 }, { type: 'note', page_id: 998 }] as any[];
    await stampAtomSourceDrift(fakeEngine, atoms);
    expect(atoms[0].unverified_source_drift).toBe(true);
    expect(atoms[1].unverified_source_drift).toBeUndefined();
  });

  test('recall labels historical page hits and think excludes them as evidence', async () => {
    const recalled = await run('recall', { query: 'uniquedriftneedle', source_id: 'default', limit: 30 });
    const row = recalled.results?.find((r: any) => r.slug === 'atoms/driftcase');
    expect(row?.unverified_source_drift).toBe(true);
    const gathered = await runGather(engine, { question: 'uniquedriftneedle', sourceId: 'default' });
    expect(gathered.pages.some(r => r.slug === 'atoms/driftcase')).toBe(false);
    expect(gathered.warnings).toContain('GATHER_UNVERIFIED_SOURCE_DRIFT_EXCLUDED');
  });

  test('human CLI output visibly warns; JSON keeps structured field', () => {
    const row = { slug: 'atoms/driftcase', score: 0.5, chunk_text: 'synthetic', unverified_source_drift: true };
    expect(formatResult('search', [row])).toContain('unverified_source_drift');
    expect(formatResult('query', [row])).toContain('unverified_source_drift');
    expect(formatResultExplain(row as any, 1)).toContain('unverified_source_drift');
    const originalError = console.error;
    const warnings: string[] = [];
    console.error = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const markdown = formatResult('get_page', { ...row, type: 'atom', title: 'Synthetic', frontmatter: {}, tags: [], compiled_truth: 'synthetic', timeline: '' });
      expect(markdown).toStartWith('---\n');
      expect(warnings.join(' ')).toContain('unverified_source_drift');
    } finally {
      console.error = originalError;
    }
    expect(JSON.parse(formatResult('search', [row], { json: true }))[0].unverified_source_drift).toBe(true);
  });
});
