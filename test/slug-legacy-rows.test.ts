/**
 * Rows a brain already holds under a spelling that writes no longer produce (capitals, or a decomposed Unicode
 * name stored before writes composed slugs) keep answering to that exact spelling.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Contract: a read by the exact stored spelling returns that row (never its composed twin), a read by the
 *     spelling a page or row was stored under finds it, a prefix typed the way pages were stored finds them, and
 *     delete_page / add_timeline_entry / add_tag / import by the stored spelling still act on that row and never
 *     write a composed twin beside it.
 *  2. Regression: PR 9944 review r1 blockers 1-4 (a read of `coll/café` NFD returned the composed twin's title and
 *     tags; `Up/Alice-Example` stored with capitals answered page_not_found; file_list, ontology_get and slug
 *     prefixes lost rows stored under the caller's spelling; import by a stored NFD slug wrote an NFC twin).
 *  3. Existing coverage: test/slug-normalize-reads.test.ts reads only pages stored normalized or decomposed alone.
 *  4. Seam: none. Real PGLite engine and registry operations. This file imports nothing the normalization change
 *     added, so the same file runs on the merge base and shows the behavior to preserve.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;

function ctx(): OperationContext {
  return { engine, config: { engine: 'pglite', embedding_disabled: true } as never, remote: false, sourceId: 'default',
    dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}
async function call<T = Record<string, any>>(name: string, params: Record<string, unknown>): Promise<T> {
  return await operationsByName[name]!.handler(ctx(), params) as T;
}
async function errorOf(name: string, params: Record<string, unknown>): Promise<{ code?: string; message?: string; detail?: string } | null> {
  try { await call(name, params); return null; } catch (e) { return e as { code?: string; message?: string; detail?: string }; }
}
const page = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n${body}\n`;

/** Write `seed` through put_page, then store the page under `stored`, as an older writer left it. */
async function storeAs(seed: string, stored: string, title: string, body = 'body'): Promise<void> {
  await call('put_page', { slug: seed, content: page(title, body) });
  await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2 AND source_id = $3', [stored, seed, 'default']);
  // A raw slug update changes the knowledge revision and clears the served-text one; a stored page kept both in step.
  await engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = $1 AND source_id = $2', [stored, 'default']);
}
const tag = (slug: string, t: string) => engine.executeRaw('INSERT INTO tags (page_id, tag) SELECT id, $1 FROM pages WHERE slug = $2 AND source_id = $3', [t, slug, 'default']);
const pageRows = async (like: string) => (await engine.executeRaw<{ slug: string; title: string }>(
  'SELECT slug, title FROM pages WHERE slug LIKE $1 AND deleted_at IS NULL ORDER BY slug', [like]));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

describe('blocker 1: a read by a stored spelling returns that row, not its composed twin', () => {
  const nfd = 'coll/caf\u0065\u0301-both';
  const nfc = 'coll/caf\u00e9-both';
  test('get_page, get_tags and get_timeline by the exact decomposed bytes answer for the decomposed page', async () => {
    await storeAs('coll/both-nfd-seed', nfd, 'Legacy NFD');
    await tag(nfd, 'nfd-tag');
    await call('put_page', { slug: nfc, content: page('Composed NFC', 'composed body') });
    expect((await call('get_page', { slug: nfd })).title).toBe('Legacy NFD');
    expect(await call<string[]>('get_tags', { slug: nfd })).toEqual(['nfd-tag']);
    expect((await call('get_page', { slug: nfc })).title).toBe('Composed NFC');
    expect(await call<string[]>('get_tags', { slug: nfc })).toEqual([]);
  });
});

describe('blocker 2: a page stored with capitals is read by its exact spelling', () => {
  test('get_page and get_tags by `Up/Alice-Example` answer for the page stored under that spelling', async () => {
    await storeAs('up/alice-seed', 'Up/Alice-Example', 'Capital Alice');
    await tag('Up/Alice-Example', 'capital-tag');
    expect((await call('get_page', { slug: 'Up/Alice-Example' })).title).toBe('Capital Alice');
    expect(await call<string[]>('get_tags', { slug: 'Up/Alice-Example' })).toEqual(['capital-tag']);
    expect((await errorOf('get_page', { slug: 'up/alice-example' }))?.code).toBe('page_not_found');
  });
});

describe('blocker 3: rows keyed by the caller\'s spelling and prefixes typed the way pages were stored', () => {
  test('file_list by the slug a file was registered under finds its row', async () => {
    await call('put_page', { slug: 'filecase/alice', content: page('File Alice', 'a') });
    await engine.executeRaw(`INSERT INTO files (page_slug, filename, storage_path, content_hash) VALUES ('FileCase/Alice', 'a.txt', 'filecase/a.txt', 'h1')`);
    const rows = await call<Array<{ filename: string }>>('file_list', { slug: 'FileCase/Alice' });
    expect(rows.map(r => r.filename)).toEqual(['a.txt']);
  });

  test('ontology_get by the entity spelling a fact was stored under finds its value', async () => {
    await engine.mergeOntologyFact({ entitySlug: 'People/Onto-Legacy', dimension: 'role', value: 'advisor', source: 'seed', confidence: 0.9 });
    const rows = await call<Array<{ value: string }>>('ontology_get', { entity: 'People/Onto-Legacy' });
    expect(rows.map(r => r.value)).toEqual(['advisor']);
  });

  test('list_pages and search_exact by a decomposed prefix find the decomposed pages', async () => {
    const stored = 'lp/caf\u0065\u0301-one';
    await storeAs('lp/seed-one', stored, 'LP one', 'prefix-marker-unique words');
    const prefix = 'lp/caf\u0065\u0301';
    expect((await call<Array<{ slug: string }>>('list_pages', { slug_prefix: prefix })).map(p => p.slug)).toEqual([stored]);
    const hits = await call<{ matches?: Array<{ slug: string }> }>('search_exact', { phrase: 'prefix-marker-unique', slug_prefix: prefix });
    expect((hits.matches ?? []).map(h => h.slug)).toEqual([stored]);
  });
});

describe('notes: delete_page, add_timeline_entry and add_tag by a stored spelling', () => {
  test('each is refused with the legacy-spelling refusal, never run on a composed twin, and the page stays as it was', async () => {
    const stored = 'notes/w-caf\u0065\u0301';
    await storeAs('notes/w-seed', stored, 'Writes');
    const writes: Array<[string, Record<string, unknown>]> = [
      ['add_tag', { slug: stored, tag: 'added' }],
      ['remove_tag', { slug: stored, tag: 'gone' }],
      ['append_page', { slug: stored, text: 'more', request_id: '5b0c1a52-8a4e-4a3c-9f0e-2d6a7c1e9b11' }],
      ['edit_page', { slug: stored, expected_revision: (await engine.readPageSnapshot(stored, { sourceId: 'default' }))!.revision, edits: [{ old_text: 'Body.', new_text: 'Changed.' }] }],
      ['add_timeline_entry', { slug: stored, date: '2026-03-04', summary: 'added entry' }],
      ['delete_page', { slug: stored, expected_revision: (await engine.readPageSnapshot(stored, { sourceId: 'default' }))!.revision }],
    ];
    for (const [op, params] of writes) {
      const err = await errorOf(op, params) as { code?: string; detail?: string; message?: string } | null;
      expect({ op, code: err?.code, detail: err?.detail }).toEqual({ op, code: 'invalid_params', detail: 'legacy_slug_spelling' });
      expect(err?.message).toContain(`so ${op} by that spelling is refused and nothing was changed`);
    }
    expect((await pageRows('notes/w-caf%')).map(r => r.slug)).toEqual([stored]);
    expect(await call<string[]>('get_tags', { slug: stored })).toEqual([]);
    expect(await call<unknown[]>('get_timeline', { slug: stored })).toEqual([]);
  });
});

describe('blocker 4: importing content for a stored decomposed slug never writes a composed twin', () => {
  test('importFromContent by the stored slug leaves exactly one page, the stored one', async () => {
    const stored = 'imp/caf\u0065\u0301';
    await storeAs('imp/seed', stored, 'Before import', 'old text');
    const result = await importFromContent(engine, stored, page('After import', 'new text'), { noEmbed: true });
    const rows = await pageRows('imp/caf%');
    expect(rows.map(r => r.slug)).toEqual([stored]);
    expect(result.status).toBe('error');
    expect(result.error).toBe(`Page ${stored} is stored under an older spelling of its name (capitals or decomposed Unicode), and an import writes the normal spelling imp/caf\u00e9, which would create a second page that prints the same name, so nothing was imported. `
      + 'Fix: leave this content out until the page moves to imp/caf\u00e9, or import it under a different slug.');
    expect((await engine.getPage(stored))?.title).toBe('Before import');
  });

  test('importFromContent by a capital spelling of a capital-stored page holds too, and an import beside an existing composed page still imports', async () => {
    await storeAs('imp/seed-cap', 'Imp/Cap-Page', 'Capital stored', 'old text');
    const held = await importFromContent(engine, 'Imp/Cap-Page', page('After', 'new text'), { noEmbed: true });
    expect(held.status).toBe('error');
    expect((await pageRows('imp/cap-page')).length).toBe(0);
    await call('put_page', { slug: 'imp/both-café', content: page('Composed', 'one') });
    const ok = await importFromContent(engine, 'imp/both-cafe\u0301', page('Composed again', 'two'), { noEmbed: true });
    expect(ok.status).toBe('imported');
  });
});
