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

describe('prefixes read every spelling that holds pages, so no stored row hides', () => {
  const nfdOne = 'un/caf\u0065\u0301-old';
  const nfcTwo = 'un/caf\u00e9-new';

  test('list_pages and search_exact by a decomposed prefix list the decomposed and the composed pages together', async () => {
    await storeAs('un/seed-old', nfdOne, 'Union old', 'union-marker-unique words');
    await call('put_page', { slug: nfcTwo, content: page('Union new', 'union-marker-unique words') });
    const prefix = 'un/caf\u0065\u0301';
    expect((await call<Array<{ slug: string }>>('list_pages', { slug_prefix: prefix })).map(p => p.slug).sort()).toEqual([nfdOne, nfcTwo].sort());
    // A composed prefix reads as master read it (the composed rows): only the spellings the caller sent, lowercased or normalized, are read.
    expect((await call<Array<{ slug: string }>>('list_pages', { slug_prefix: 'un/caf\u00e9' })).map(p => p.slug)).toEqual([nfcTwo]);
    const hits = await call<{ matches?: Array<{ slug: string }> }>('search_exact', { phrase: 'union-marker-unique', slug_prefix: prefix });
    expect((hits.matches ?? []).map(h => h.slug).sort()).toEqual([nfdOne, nfcTwo].sort());
  });

  test('a prefix with pages under one spelling only is unchanged', async () => {
    expect((await call<Array<{ slug: string }>>('list_pages', { slug_prefix: 'zz-none/' }))).toEqual([]);
    await call('put_page', { slug: 'solo/a', content: page('Solo', 'x') });
    expect((await call<Array<{ slug: string }>>('list_pages', { slug_prefix: 'Solo/' })).map(p => p.slug)).toEqual(['solo/a']);
  });

  test('takes_scorecard and get_recent_salience hand the engine both prefixes', async () => {
    const seen: Record<string, unknown> = {};
    const real = { sc: engine.getScorecard.bind(engine), sal: engine.getRecentSalience.bind(engine) };
    (engine as any).getScorecard = async (o: any, ...rest: any[]) => { seen.scorecard = { p: o.domainPrefix, also: o.domainPrefixAlso }; return (real.sc as any)(o, ...rest); };
    (engine as any).getRecentSalience = async (o: any) => { seen.salience = { p: o.slugPrefix, also: o.slugPrefixAlso }; return real.sal(o); };
    try {
      await call('takes_scorecard', { domain_prefix: 'un/caf\u0065\u0301' });
      await call('get_recent_salience', { slugPrefix: 'un/caf\u0065\u0301' });
    } finally { (engine as any).getScorecard = real.sc; (engine as any).getRecentSalience = real.sal; }
    expect(seen).toEqual({
      scorecard: { p: 'un/caf\u0065\u0301', also: ['un/caf\u00e9'] },
      salience: { p: 'un/caf\u0065\u0301', also: ['un/caf\u00e9'] },
    });
  });

  test('get_recent_salience reads both spellings\' pages in one list', async () => {
    const rows = await call<Array<{ slug: string }>>('get_recent_salience', { slugPrefix: 'un/caf\u0065\u0301', days: 3650 });
    expect(rows.map(r => r.slug).sort()).toEqual([nfdOne, nfcTwo].sort());
  });
});

describe('writes by a stored spelling change that row in place, as on the merge base, and write no composed twin', () => {
  const stored = 'notes/w-caf\u0065\u0301';
  const rowsOf = async () => (await engine.executeRaw<{ slug: string; deleted: boolean }>('SELECT slug, deleted_at IS NOT NULL AS deleted FROM pages WHERE slug ILIKE $1 ORDER BY slug', ['notes/w-caf%']));
  const revisionOf = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))!.revision;
  const tagsOf = async (slug: string) => await call<string[]>('get_tags', { slug });
  const fresh = async (key: string, title = 'Writes') => {
    await engine.executeRaw('DELETE FROM pages WHERE slug ILIKE $1', ['notes/w-caf%']);
    await storeAs('notes/w-seed', key, title, 'Body.');
  };

  test('delete_page soft-deletes the stored row, and a second delete is the same no-op', async () => {
    await fresh(stored);
    const out = await call('delete_page', { slug: stored, expected_revision: await revisionOf(stored) });
    expect({ slug: out.slug, status: out.status, noop: out.noop }).toEqual({ slug: stored, status: 'soft_deleted', noop: false });
    expect(await rowsOf()).toEqual([{ slug: stored, deleted: true }]);
    const again = await call('delete_page', { slug: stored, expected_revision: await revisionOf(stored) });
    expect({ slug: again.slug, status: again.status, noop: again.noop }).toEqual({ slug: stored, status: 'soft_deleted', noop: true });
  });

  test('add_tag and remove_tag change the stored row\'s tags', async () => {
    await fresh(stored);
    const added = await call('add_tag', { slug: stored, tag: 'added' });
    expect({ slug: added.slug, tag: added.tag, noop: added.noop, status: added.status }).toEqual({ slug: stored, tag: 'added', noop: false, status: 'ok' });
    await call('add_tag', { slug: stored, tag: 'gone' });
    const removed = await call('remove_tag', { slug: stored, tag: 'gone' });
    expect({ slug: removed.slug, tag: removed.tag, noop: removed.noop }).toEqual({ slug: stored, tag: 'gone', noop: false });
    expect(await tagsOf(stored)).toEqual(['added']);
    expect(await rowsOf()).toEqual([{ slug: stored, deleted: false }]);
  });

  test('add_timeline_entry adds the entry to the stored row', async () => {
    await fresh(stored);
    const out = await call('add_timeline_entry', { slug: stored, date: '2026-03-04', summary: 'added entry' });
    expect({ slug: out.slug, status: out.status, noop: out.noop, entry: out.entry }).toEqual({ slug: stored, status: 'ok', noop: false, entry: { date: '2026-03-04', source: 'manual', summary: 'added entry' } });
    expect((await call<Array<{ summary: string }>>('get_timeline', { slug: stored })).map(e => e.summary)).toEqual(['added entry']);
    expect(await rowsOf()).toEqual([{ slug: stored, deleted: false }]);
  });

  test('edit_page edits the stored row\'s text', async () => {
    await fresh(stored);
    const out = await call('edit_page', { slug: stored, expected_revision: await revisionOf(stored), edits: [{ old_text: 'Body.', new_text: 'Changed.' }] });
    expect({ slug: out.slug, status: out.status, noop: out.noop }).toEqual({ slug: stored, status: 'created_or_updated', noop: false });
    expect((await engine.getPage(stored))?.compiled_truth).toBe('Changed.');
    expect(await rowsOf()).toEqual([{ slug: stored, deleted: false }]);
  });

  test('append_page appends to the stored row', async () => {
    await fresh(stored);
    const out = await call('append_page', { slug: stored, text: 'Appended.', request_id: '5b0c1a52-8a4e-4a3c-9f0e-2d6a7c1e9b11' });
    expect({ slug: out.slug, appended: out.appended_bytes }).toEqual({ slug: stored, appended: 10 });
    expect((await engine.getPage(stored))?.compiled_truth).toBe('Body.\nAppended.');
    expect(await rowsOf()).toEqual([{ slug: stored, deleted: false }]);
  });

  test('a capital spelling of a capital-stored page (the merge base lowercased the slug and answered page_not_found): every write acts on that row, never a lowercase twin', async () => {
    const cap = 'Notes/W-Cafe';
    await fresh(cap);
    const outs: Array<{ op: string; slug: unknown }> = [];
    const run = async (op: string, params: Record<string, unknown>) => { const out = await call(op, { slug: cap, ...params }); outs.push({ op, slug: out.slug }); };
    await run('add_tag', { tag: 'cap' });
    await run('add_tag', { tag: 'gone' });
    await run('remove_tag', { tag: 'gone' });
    await run('add_timeline_entry', { date: '2026-03-04', summary: 'cap entry' });
    await run('edit_page', { expected_revision: await revisionOf(cap), edits: [{ old_text: 'Body.', new_text: 'Changed.' }] });
    await run('append_page', { text: 'Appended.', request_id: '7c2d9e41-3b6f-4d8a-a1e5-0f9b8c7d6e21' });
    expect(outs).toEqual(['add_tag', 'add_tag', 'remove_tag', 'add_timeline_entry', 'edit_page', 'append_page'].map(op => ({ op, slug: cap })));
    expect(await tagsOf(cap)).toEqual(['cap']);
    const after = (await engine.getPage(cap))!;
    expect({ changed: after.compiled_truth.startsWith('Changed.'), appended: `${after.compiled_truth}\n${after.timeline}`.includes('Appended.') }).toEqual({ changed: true, appended: true });
    expect(await rowsOf()).toEqual([{ slug: cap, deleted: false }]);
    await call('delete_page', { slug: cap, expected_revision: await revisionOf(cap) });
    expect(await rowsOf()).toEqual([{ slug: cap, deleted: true }]);
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
