/**
 * #7191 ask 2: search_exact, the exhaustive literal scan. Match semantics,
 * completeness (limit, deadline, unreadable pages, resume) and the remote
 * visibility contract, on PGLite.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { runExactScan, phrasePattern } from '../src/core/search/exact-scan.ts';
import { routeCommand } from '../src/cli/command-route.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetPrivateVisibilityCacheForTests();
  await engine.executeRaw("INSERT INTO sources(id, name) VALUES ('source-a', 'source-a'), ('source-b', 'source-b') ON CONFLICT DO NOTHING");
});

const op = operations.find(o => o.name === 'search_exact')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as any,
    dryRun: false,
    remote: false,
    sourceId: 'source-a',
    ...overrides,
  } as OperationContext;
}
const local = () => ctxOf();
const allLocal = () => ctxOf({ sourceId: '__all__' });
const remote = () => ctxOf({ remote: true, transport: 'stdio', auth: { allowedSources: ['source-a'] } as any });

interface Out { matches: Array<{ slug: string; source_id: string; matching_chunks: number; snippets: Array<{ text: string }> }>; complete: boolean; incomplete_reasons: string[];
  resume_after: number | null; pages_scanned: number; unreadable: { total: number; by_reason: Record<string, number>; sample: Array<{ slug: string; reason: string }> } }
const exact = (ctx: OperationContext, params: Record<string, unknown>) => op.handler(ctx, params) as Promise<Out>;
const slugs = (o: Out) => o.matches.map(m => m.slug);

async function page(slug: string, body: string, opts: { sourceId?: string; frontmatter?: string } = {}) {
  const fm = '---\ntitle: ' + slug.split('/').pop() + '\ntype: note\n' + (opts.frontmatter ?? '') + '---\n';
  await importFromContent(engine as any, slug, fm + body, { sourceId: opts.sourceId ?? 'source-a', noEmbed: true });
}

describe('search_exact matching', () => {
  test('a substring match of the words in order across any whitespace, case-insensitive by default, literal otherwise', async () => {
    await page('notes/a', 'The Quarterly\nBoard   Pack is due on Friday.');
    await page('notes/b', 'We discussed the board pack later.');
    await page('notes/c', 'Board packs and boarding passes are different words.');
    await page('notes/d', 'quarterly board-pack draft');
    const res = await exact(local(), { phrase: 'board pack' });
    expect(slugs(res)).toEqual(['notes/a', 'notes/b', 'notes/c']);
    expect(res.complete).toBe(true);
    expect(res.matches[0]!.snippets[0]!.text).toContain('Board   Pack');
    expect(slugs(await exact(local(), { phrase: 'Board Pack', case_sensitive: true }))).toEqual(['notes/a']);
    expect(slugs(await exact(local(), { phrase: 'board-pack' }))).toEqual(['notes/d']);
    expect(slugs(await exact(local(), { phrase: 'quarterly board pack' }))).toEqual(['notes/a']);
  });

  test('regex and LIKE metacharacters in the phrase are literal', async () => {
    await page('notes/a', 'Ticket (A+B)? 100% done_ok [x] c:\\path.');
    await page('notes/b', 'Ticket AAB done');
    expect(slugs(await exact(local(), { phrase: '(A+B)?' }))).toEqual(['notes/a']);
    expect(slugs(await exact(local(), { phrase: '100% done_ok' }))).toEqual(['notes/a']);
    expect(slugs(await exact(local(), { phrase: '[x] c:\\path.' }))).toEqual(['notes/a']);
    expect(phrasePattern('  a.b   c ')).toEqual({ regex: 'a\\.b[[:space:]]+c', longest: 'a.b' });
  });

  test('a phrase near the end of a long page is found', async () => {
    const filler = Array.from({ length: 400 }, (_, i) => 'Paragraph ' + i + ' talks about ordinary planning topics in some detail.').join('\n\n');
    await page('notes/long', filler + '\n\nThe rare code word is zephyr-nine-alpha.');
    const res = await exact(local(), { phrase: 'zephyr-nine-alpha' });
    expect(slugs(res)).toEqual(['notes/long']);
    expect(res.complete).toBe(true);
  });

  test('type and slug_prefix narrow the scan', async () => {
    await page('meetings/m1', 'agenda item alpha');
    await page('notes/n1', 'agenda item alpha');
    expect(slugs(await exact(local(), { phrase: 'agenda item', slug_prefix: 'meetings/' }))).toEqual(['meetings/m1']);
    expect(slugs(await exact(local(), { phrase: 'agenda item', types: ['note'] }))).toEqual(['meetings/m1', 'notes/n1']);
    expect(slugs(await exact(local(), { phrase: 'agenda item', types: ['person'] }))).toEqual([]);
  });
});

describe('search_exact completeness', () => {
  test('limit bounds the page count and resume_after continues the scan to completion', async () => {
    for (const n of [1, 2, 3, 4, 5]) await page('notes/p' + n, 'marker phrase number ' + n);
    await page('notes/other', 'nothing to see');
    const first = await exact(local(), { phrase: 'marker phrase', limit: 2 });
    expect(slugs(first)).toEqual(['notes/p1', 'notes/p2']);
    expect(first.complete).toBe(false);
    expect(first.incomplete_reasons).toEqual(['limit']);
    const second = await exact(local(), { phrase: 'marker phrase', limit: 2, after: first.resume_after });
    expect(slugs(second)).toEqual(['notes/p3', 'notes/p4']);
    const third = await exact(local(), { phrase: 'marker phrase', limit: 2, after: second.resume_after });
    expect(slugs(third)).toEqual(['notes/p5']);
    expect(third).toMatchObject({ complete: true, incomplete_reasons: [], resume_after: null });
    expect(first.pages_scanned + second.pages_scanned + third.pages_scanned).toBe(6);
  });

  test('batch size never changes the answer', async () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await page('notes/p' + n, n % 2 ? 'odd marker here' : 'even page');
    const base = { phrase: 'odd marker', excludeSlugPrefixes: [], excludePrivate: false, remote: false, limit: 100, deadlineMs: Date.now() + 30_000, sourceId: 'source-a' };
    const whole = await runExactScan(engine, base);
    for (const batchPages of [1, 2, 3]) {
      const batched = await runExactScan(engine, { ...base, batchPages });
      expect({ batchPages, slugs: batched.matches.map(m => m.slug), complete: batched.complete, scanned: batched.pages_scanned })
        .toEqual({ batchPages, slugs: whole.matches.map(m => m.slug), complete: true, scanned: 7 });
    }
  });

  test('a spent deadline is incomplete and resumable from where it stopped', async () => {
    await page('notes/a', 'deadline marker');
    const stopped = await runExactScan(engine, { phrase: 'deadline marker', excludeSlugPrefixes: [], excludePrivate: false, remote: false, limit: 10, deadlineMs: Date.now() - 1, sourceId: 'source-a' });
    expect(stopped).toMatchObject({ complete: false, incomplete_reasons: ['deadline'], resume_after: 0, matches: [] });
    expect(slugs(await exact(local(), { phrase: 'deadline marker', after: stopped.resume_after }))).toEqual(['notes/a']);
  });

  test('a page with text but no readable chunk makes the scan incomplete and is named', async () => {
    await page('notes/indexed', 'the needle is here');
    await page('notes/held', 'the needle is also here');
    await page('notes/pending', 'the needle again');
    await page('notes/empty', '');
    const [held] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = 'notes/held'");
    await engine.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [held!.id]);
    await engine.executeRaw("UPDATE pages SET text_projection_revision = NULL WHERE slug = 'notes/pending'");
    const res = await exact(local(), { phrase: 'needle' });
    expect(slugs(res)).toEqual(['notes/indexed']);
    expect(res.complete).toBe(false);
    expect(res.incomplete_reasons).toEqual(['unreadable_pages']);
    expect(res.unreadable.by_reason).toEqual({ unchunked: 1, projection_pending: 1 });
    expect(res.unreadable.sample.map(s => [s.slug, s.reason]).sort()).toEqual([['notes/held', 'unchunked'], ['notes/pending', 'projection_pending']]);
  });
});

describe('search_exact remote visibility', () => {
  test('private and foreign-source pages are matched locally and never remotely, quarantined pages by nobody; remote stays complete', async () => {
    await page('notes/world', 'shared secret-word-77 text');
    const baseline = await exact(remote(), { phrase: 'secret-word-77' });
    expect(slugs(baseline)).toEqual(['notes/world']);
    expect(baseline.complete).toBe(true);
    await page('notes/private', 'private secret-word-77 text', { frontmatter: 'visibility: private\n' });
    await page('notes/quarantined', 'quarantined secret-word-77 text');
    await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter || '{\"quarantine\": \"synthetic\"}'::jsonb WHERE slug = 'notes/quarantined'");
    await page('notes/foreign', 'foreign secret-word-77 text', { sourceId: 'source-b' });
    const everywhere = await exact(allLocal(), { phrase: 'secret-word-77', source_id: '__all__' });
    expect(everywhere.matches.map(m => m.source_id + ':' + m.slug).sort()).toEqual(['source-a:notes/private', 'source-a:notes/world', 'source-b:notes/foreign']);
    const res = await exact(remote(), { phrase: 'secret-word-77' });
    expect(slugs(res)).toEqual(['notes/world']);
    expect(res.complete).toBe(true);
    expect(JSON.stringify(res)).not.toContain('notes/private');
  });

  test('a page indexed before the safe-chunk fence is withheld remotely and reported as unsealed', async () => {
    await page('notes/old', 'legacy marker words');
    await engine.executeRaw("UPDATE pages SET chunker_version = 1 WHERE slug = 'notes/old'");
    expect(slugs(await exact(local(), { phrase: 'legacy marker' }))).toEqual(['notes/old']);
    const res = await exact(remote(), { phrase: 'legacy marker' });
    expect(res.matches).toEqual([]);
    expect(res).toMatchObject({ complete: false, incomplete_reasons: ['unreadable_pages'], unreadable: { by_reason: { unsealed: 1 } } });
  });

  test('a page that times out alone is named in the gap report only when the caller may read it', async () => {
    await page('notes/open-gap', 'open gap marker text');
    await page('notes/private-gap', 'private gap marker text', { frontmatter: 'visibility: private\n' });
    await page('notes/foreign-gap', 'foreign gap marker text', { sourceId: 'source-b' });
    // Every batch statement times out, so the scan steps one page at a time through nextLivePageAfter and records each as scan_timeout.
    const timingOut = new Proxy(engine as any, {
      get(target, prop, receiver) {
        if (prop === 'scanExactBatch') return async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const viaRemote = await exact(ctxOf({ engine: timingOut, remote: true, transport: 'stdio', auth: { allowedSources: ['source-a'] } as any }), { phrase: 'gap marker' });
    expect(viaRemote.unreadable.sample.map(s => s.slug)).toEqual(['notes/open-gap']);
    expect(viaRemote.unreadable.total).toBe(1);
    expect(JSON.stringify(viaRemote)).not.toContain('notes/private-gap');
    expect(JSON.stringify(viaRemote)).not.toContain('notes/foreign-gap');
    // The cursor still passes the hidden page: the scan ends complete of pages, not stuck at the first one.
    expect(viaRemote.resume_after).toBeNull();
    const viaLocal = await exact(ctxOf({ engine: timingOut }), { phrase: 'gap marker' });
    expect(viaLocal.unreadable.sample.map(s => s.slug)).toEqual(expect.arrayContaining(['notes/open-gap', 'notes/private-gap']));
  });

  test('a source outside the grant is refused', async () => {
    await expect(exact(remote(), { phrase: 'x y', source_id: 'source-b' })).rejects.toBeDefined();
  });
});

describe('gbrain search --exact routing', () => {
  test('--exact routes search to search-exact and is dropped; after a bare -- it is a positional', () => {
    expect(routeCommand('search', ['--exact', 'board pack', '--limit', '5'])).toEqual({ command: 'search-exact', subArgs: ['board pack', '--limit', '5'] });
    expect(routeCommand('search', ['board pack', '--exact'])).toEqual({ command: 'search-exact', subArgs: ['board pack'] });
    expect(routeCommand('search', ['--', '--exact'])).toEqual({ command: 'search', subArgs: ['--', '--exact'] });
    expect(routeCommand('query', ['--exact', 'x'])).toEqual({ command: 'query', subArgs: ['--exact', 'x'] });
  });
});

describe('search_exact parameters', () => {
  for (const [label, params] of [
    ['empty phrase', { phrase: '   ' }],
    ['limit 0', { phrase: 'a b', limit: 0 }],
    ['limit 1001', { phrase: 'a b', limit: 1001 }],
    ['negative after', { phrase: 'a b', after: -1 }],
    ['max_seconds 0', { phrase: 'a b', max_seconds: 0 }],
    ['types string', { phrase: 'a b', types: 'note' }],
    ['case_sensitive string', { phrase: 'a b', case_sensitive: 'yes' }],
  ] as Array<[string, Record<string, unknown>]>) {
    test('rejects ' + label, async () => {
      await expect(exact(local(), params)).rejects.toMatchObject({ code: 'invalid_params' });
    });
  }
});
