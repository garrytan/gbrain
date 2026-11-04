/**
 * #7191: `find_pages` (gbrain find) and `get_stats` grouped mode on a real
 * engine: pattern forms, visibility (deleted, archived source, private and
 * quarantined pages for remote callers), source scoping, type filters, the
 * limit/complete contract, --by grouping, --since and alias collapse.
 * Runs on PGLite, and on Postgres too when DATABASE_URL is set
 * (test/e2e/page-lookup-7191.test.ts registers the Postgres arm).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const findOp = operations.find((op) => op.name === 'find_pages')!;
const statsOp = operations.find((op) => op.name === 'get_stats')!;
const getPageOp = operations.find((op) => op.name === 'get_page')!;

for (const backend of testBackends()) {
  describe(`find_pages + get_stats --by (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    const ctx = (overrides: Partial<OperationContext> = {}): OperationContext => ({
      engine, config: {} as any, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: '__all__',
      ...overrides,
    } as OperationContext);
    const remote = (allowedSources = ['source-a', 'source-b']): OperationContext =>
      ctx({ remote: true, sourceId: undefined, auth: { token: 't', clientId: 'c', scopes: ['read', 'admin'], allowedSources } as any });
    const find = async (c: OperationContext, params: Record<string, unknown>) => findOp.handler(c, params) as Promise<any>;
    const stats = async (c: OperationContext, params: Record<string, unknown>) => statsOp.handler(c, params) as Promise<any>;
    const slugs = (r: any) => r.pages.map((p: any) => `${p.source_id}:${p.slug}`);

    beforeAll(async () => {
      if (backend === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a'), ('source-b', 'source-b'), ('source-old', 'source-old')");
      const put = (slug: string, type: string, title: string, sourceId: string, extra: Record<string, unknown> = {}) =>
        engine.putPage(slug, { title, type, compiled_truth: `about ${title}`, frontmatter: extra.frontmatter ?? {}, ...(extra.source_path ? { source_path: extra.source_path } : {}) } as any, { sourceId });
      await put('people/alice-example', 'person', 'Alice Example', 'source-a', { source_path: 'People/Alice Example.md' });
      await put('people/charlie-acme', 'person', 'Charlie of Acme', 'source-a');
      await put('companies/acme-example', 'company', 'Acme Example Inc', 'source-a');
      await put('companies/acme-example', 'company', 'Acme Example Inc', 'source-b');
      await put('companies/widget-co', 'company', 'Widget Co', 'source-b');
      await put('people/private-acme', 'person', 'Private Acme Contact', 'source-a', { frontmatter: { visibility: 'private' } });
      await put('people/junk-acme', 'person', 'Junk Acme', 'source-a', { frontmatter: { quarantine: { reason: 'junk_pattern', detail: 'x', assessed_at: '2026-01-01T00:00:00Z' } } });
      await put('people/deleted-acme', 'person', 'Deleted Acme', 'source-a');
      await engine.softDeletePage('people/deleted-acme', { sourceId: 'source-a' });
      await put('people/archived-acme', 'person', 'Archived Acme', 'source-old');
      await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'source-old'");
      await put('media/transcripts/call-1', 'media/transcript', 'Call one', 'source-b');
      await put('transcripts/call-2', 'transcript', 'Call two', 'source-b');
      await put('transcripts/call-3', 'audio-transcript', 'Call three', 'source-a');
      await put('notes/100%_literal', 'note', 'Percent literal', 'source-a');
      await put('notes/100x-other', 'note', 'Other', 'source-a');
      await engine.executeRaw("UPDATE pages SET effective_date = '2020-01-01T00:00:00Z' WHERE slug = 'companies/widget-co'");
      await put('test/fixture-acme', 'note', 'Fixture Acme', 'source-b');
      await put('.raw/acme-sidecar', 'note', 'Raw Acme', 'source-b');
      await put('atoms/acme-fact', 'atom', 'Acme atom', 'source-b');
      await put('notes/acme-summary', 'note', 'Acme summary', 'source-a', { frontmatter: { derived_from: 'people/private-acme' } });
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('glob matches slugs and source paths, sorted by slug then source', async () => {
      const r = await find(ctx(), { pattern: 'people/*acme*' });
      expect(r.match).toBe('glob');
      expect(slugs(r)).toEqual(['source-a:people/charlie-acme', 'source-a:people/junk-acme', 'source-a:people/private-acme']);
      expect(r).toMatchObject({ total: 3, complete: true });
      expect(slugs(await find(ctx(), { pattern: 'People/Alice*.md' }))).toEqual(['source-a:people/alice-example']);
      expect(r.pages[0]).toMatchObject({ slug: 'people/charlie-acme', source_id: 'source-a', type: 'person', title: 'Charlie of Acme' });
      expect(r.pages[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('slug prefix lists both cross-source twins', async () => {
      const r = await find(ctx(), { pattern: 'companies/acme' });
      expect(r.match).toBe('prefix');
      expect(slugs(r)).toEqual(['source-a:companies/acme-example', 'source-b:companies/acme-example']);
    });

    test('plain name matches title or the last slug segment, case-insensitively', async () => {
      const r = await find(ctx(), { pattern: 'ACME' });
      expect(r.match).toBe('name');
      expect(slugs(r)).toEqual([
        'source-b:atoms/acme-fact', 'source-a:companies/acme-example', 'source-b:companies/acme-example',
        'source-a:notes/acme-summary', 'source-a:people/charlie-acme', 'source-a:people/junk-acme', 'source-a:people/private-acme',
      ]);
      // "people" is a directory segment, never the last one: no name match.
      expect((await find(ctx(), { pattern: 'people' })).total).toBe(0);
    });

    test('LIKE metacharacters in the pattern match literally', async () => {
      expect(slugs(await find(ctx(), { pattern: 'notes/100%' }))).toEqual(['source-a:notes/100%_literal']);
      expect(slugs(await find(ctx(), { pattern: '100%_' }))).toEqual(['source-a:notes/100%_literal']);
    });

    test('soft-deleted pages and archived sources are never listed', async () => {
      const r = await find(ctx(), { pattern: 'acme', limit: 500 });
      expect(slugs(r).some((s: string) => s.includes('deleted-acme') || s.includes('archived-acme'))).toBe(false);
    });

    test('remote callers lose private and quarantined pages; local callers keep them', async () => {
      expect(slugs(await find(remote(), { pattern: 'people/*acme*' }))).toEqual(['source-a:people/charlie-acme']);
      expect((await find(ctx(), { pattern: 'people/*acme*' })).total).toBe(3);
    });

    test('source scoping: explicit source, __all__, and the remote grant', async () => {
      expect(slugs(await find(ctx(), { pattern: 'companies/*', source_id: 'source-b' }))).toEqual(['source-b:companies/acme-example', 'source-b:companies/widget-co']);
      expect((await find(ctx(), { pattern: 'companies/*', source_id: '__all__' })).total).toBe(3);
      expect(slugs(await find(remote(['source-b']), { pattern: 'companies/*' }))).toEqual(['source-b:companies/acme-example', 'source-b:companies/widget-co']);
      await expect(find(remote(['source-b']), { pattern: 'companies/*', source_id: 'source-a' })).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(find(ctx(), { pattern: 'x', source_id: 'source-old' })).rejects.toMatchObject({ code: 'unknown_source' });
    });

    test('type filters: one type, a comma list, and a types array', async () => {
      expect((await find(ctx(), { pattern: 'acme', type: 'company' })).total).toBe(2);
      expect((await find(ctx(), { pattern: 'acme', type: 'company,person' })).total).toBe(5);
      expect((await find(ctx(), { pattern: 'acme', type: 'note' })).total).toBe(1);
      expect((await find(ctx(), { pattern: '*', types: ['transcript', 'media/transcript'] })).total).toBe(2);
    });

    test('limit truncates with complete: false and the full total; remote limit is capped', async () => {
      const r = await find(ctx(), { pattern: 'acme', limit: 2 });
      expect(r.pages).toHaveLength(2);
      expect(r).toMatchObject({ total: 7, complete: false, limit: 2 });
      const capped = await find(remote(), { pattern: 'acme', limit: 5000 });
      expect(capped).toMatchObject({ limit: 100, limit_clamped_from: 5000, complete: true });
    });

    test('the ranked-search hard excludes stay hidden unless the pattern targets them', async () => {
      const r = await find(ctx(), { pattern: 'acme', limit: 500 });
      expect(slugs(r).some((s: string) => s.includes('test/') || s.includes('.raw/'))).toBe(false);
      expect(r.hidden_prefixes).toEqual(expect.arrayContaining(['test/', '.raw/']));
      const tests = await find(ctx(), { pattern: 'test/*' });
      expect(slugs(tests)).toEqual(['source-b:test/fixture-acme']);
      expect(tests.hidden_prefixes).not.toContain('test/');
    });

    test('remote=true: find never returns a page the untrusted caller cannot read', async () => {
      const unreadable = ['people/private-acme', 'people/junk-acme', 'atoms/acme-fact', 'notes/acme-summary', 'people/deleted-acme', 'people/archived-acme'];
      for (const pattern of ['*', 'acme', 'people/', 'atoms/*', 'notes/*']) {
        const r = await find(remote(['source-a', 'source-b', 'source-old']), { pattern, limit: 100 });
        expect(r.pages.filter((p: any) => unreadable.includes(p.slug))).toEqual([]);
        for (const p of r.pages) {
          const page = await getPageOp.handler(remote(['source-a', 'source-b', 'source-old']), { slug: p.slug, source_id: p.source_id }) as any;
          expect(page.slug).toBe(p.slug);
        }
      }
      // The trusted local view still lists the private, derived and atom pages (deleted and archived never).
      const local = slugs(await find(ctx(), { pattern: 'acme', limit: 500 }));
      expect(local).toEqual(expect.arrayContaining(['source-a:people/private-acme', 'source-b:atoms/acme-fact', 'source-a:notes/acme-summary']));
    });

    test('an empty pattern is invalid_params', async () => {
      await expect(find(ctx(), { pattern: '  ' })).rejects.toMatchObject({ code: 'invalid_params' });
    });

    test('get_stats without grouping params keeps its counters', async () => {
      const r = await stats(ctx(), {});
      expect(r).toHaveProperty('page_count');
      expect(r).toHaveProperty('pages_by_type');
      expect(r).not.toHaveProperty('groups');
    });

    test('--by source,type counts each source\'s own live pages', async () => {
      const r = await stats(ctx(), { by: 'source,type' });
      expect(r.by).toEqual(['source', 'type']);
      const row = (s: string, t: string) => r.groups.find((g: any) => g.source_id === s && g.type === t);
      expect(row('source-a', 'company').pages).toBe(1);
      expect(row('source-b', 'company').pages).toBe(2);
      expect(row('source-b', 'atom').pages).toBe(1);
      expect(row('source-a', 'person').pages).toBe(4);
      expect(r.groups.some((g: any) => g.source_id === 'source-old')).toBe(false);
      expect(r.groups[0].distinct_slugs).toBeUndefined();
      expect(r.total_pages).toBe(16);
      expect(r.distinct_slugs).toBe(15);
    });

    test('--by type reports raw and distinct-slug counts so twins are visible', async () => {
      const r = await stats(ctx(), { by: 'type' });
      expect(r.groups.find((g: any) => g.type === 'company')).toEqual({ type: 'company', pages: 3, distinct_slugs: 2 });
    });

    test('--since filters on the effective date', async () => {
      const r = await stats(ctx(), { by: 'source', since: '2021-01-01' });
      expect(r.since).toBe('2021-01-01');
      expect(r.groups.find((g: any) => g.source_id === 'source-b').pages).toBe(6);
      await expect(stats(ctx(), { since: 'last tuesday' })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(stats(ctx(), { by: 'source,author' })).rejects.toMatchObject({ code: 'invalid_params' });
    });

    test('--collapse-aliases merges near-duplicate types and lists every member', async () => {
      const r = await stats(ctx(), { by: 'type', collapse_aliases: true });
      const transcript = r.groups.find((g: any) => g.type === 'transcript');
      expect(transcript.pages).toBe(3);
      expect(transcript.member_types).toEqual([
        { type: 'audio-transcript', pages: 1, via: 'suffix' },
        { type: 'media/transcript', pages: 1, via: 'normalized' },
        { type: 'transcript', pages: 1, via: 'exact' },
      ]);
      expect(r.groups.some((g: any) => g.type === 'media/transcript')).toBe(false);
    });

    test('remote grouped stats are confined to the grant and drop private/quarantined pages', async () => {
      const r = await stats(remote(['source-a']), { by: 'source,type' });
      expect(r.groups.every((g: any) => g.source_id === 'source-a')).toBe(true);
      expect(r.groups.find((g: any) => g.type === 'person').pages).toBe(2);
    });
  });
}
