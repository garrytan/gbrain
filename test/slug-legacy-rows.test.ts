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
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';

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
async function storeAs(seed: string, stored: string, title: string, body = 'body', source = 'default'): Promise<void> {
  await call('put_page', { slug: seed, content: page(title, body), ...(source === 'default' ? {} : { source_id: source }) });
  await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2 AND source_id = $3', [stored, seed, source]);
  // A raw slug update changes the knowledge revision and clears the served-text one; a stored page kept both in step.
  await engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = $1 AND source_id = $2', [stored, source]);
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
    // The lowercase slug names no page by its own bytes, and the page stored with capitals is the only one that reads the same: it answers (final review 5; the merge base answered page_not_found).
    expect((await call('get_page', { slug: 'up/alice-example' })).title).toBe('Capital Alice');
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

describe('final review: a read answers the page the exact input names, or refuses only where nothing answered', () => {
  const NFD = (s: string) => s.normalize('NFD');
  const tombstone = (slug: string) => engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE slug = $1 AND source_id = $2', [slug, 'default']);

  test('finding 3: a per-call source_id picks the spelling in that source, not in the default source', async () => {
    const nfd = NFD('f3/caf\u00e9-src');
    const nfc = 'f3/caf\u00e9-src';
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('beta', 'beta') ON CONFLICT DO NOTHING`);
    await storeAs('f3/beta-nfd-seed', nfd, 'Beta decomposed', 'b', 'beta');
    await call('put_page', { slug: nfc, content: page('Beta composed', 'b'), source_id: 'beta' });
    await call('put_page', { slug: nfc, content: page('Default composed', 'd') });
    expect((await call('get_page', { slug: nfd, source_id: 'beta' })).title).toBe('Beta decomposed');
    expect((await call('get_page', { slug: nfd })).title).toBe('Default composed');
  });

  test('finding 4: an exact slug alias keeps answering with the page it names, not an unrelated composed page', async () => {
    const nfd = NFD('f4/caf\u00e9-alias');
    await call('put_page', { slug: 'f4/alias-target', content: page('Alias target', 't') });
    await call('put_page', { slug: 'f4/caf\u00e9-alias', content: page('Composed page', 'c') });
    await engine.executeRaw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', $1, 'f4/alias-target')`, [nfd]);
    const out = await call('get_page', { slug: nfd });
    expect({ title: out.title, slug: out.slug }).toEqual({ title: 'Alias target', slug: 'f4/alias-target' });
  });

  test('finding 5: a slug already in normal form finds the one other spelling', async () => {
    await storeAs('f5/one-seed', 'F5/One-Cafe', 'Only capital', 'o');
    expect((await call('get_page', { slug: 'f5/one-cafe' })).title).toBe('Only capital');
  });

  test('finding 5: a slug already in normal form is ambiguous between two other stored spellings', async () => {
    await storeAs('f5/two-seed-a', 'F5/Two-Caf\u00e9', 'Two composed', 'a');
    await storeAs('f5/two-seed-b', NFD('F5/Two-Caf\u00e9'), 'Two decomposed', 'b');
    const err = await errorOf('get_page', { slug: 'f5/two-caf\u00e9' });
    expect({ code: err?.code, detail: err?.detail }).toEqual({ code: 'invalid_params', detail: 'ambiguous_slug' });
    expect(err?.message).toContain(JSON.stringify('F5/Two-Caf\u00e9'));
    expect(err?.message).toContain(JSON.stringify(NFD('F5/Two-Caf\u00e9')));
  });

  test('finding 6: include_deleted answers the exact tombstone, not the live composed twin', async () => {
    const nfd = NFD('f6/caf\u00e9-gone');
    await storeAs('f6/gone-seed', nfd, 'Exact tombstone', 'x');
    await tombstone(nfd);
    await call('put_page', { slug: 'f6/caf\u00e9-gone', content: page('Live twin', 'l') });
    const withDeleted = await call('get_page', { slug: nfd, include_deleted: true });
    expect({ title: withDeleted.title, deleted: !!withDeleted.deleted_at }).toEqual({ title: 'Exact tombstone', deleted: true });
    expect((await call('get_page', { slug: nfd })).title).toBe('Live twin');
  });

  test('finding 7: rows of another source never use up the candidates a readable source holds', async () => {
    const spell = (bits: number) => 'f7/' + [...'abcdefgh'].map((c, i) => (bits >> i) & 1 ? c.toUpperCase() : c).join('');
    for (let bits = 1; bits <= 24; bits++) {
      await call('put_page', { slug: `f7/seed-${bits}`, content: page(`Beta ${bits}`, 'b'), source_id: 'beta' });
      await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2 AND source_id = $3', [spell(bits), `f7/seed-${bits}`, 'beta']);
    }
    await storeAs('f7/def-seed-a', spell(128), 'Default one', 'a');
    await storeAs('f7/def-seed-b', spell(255), 'Default two', 'b');
    const err = await errorOf('get_page', { slug: 'F7/ABCDEFGH' });
    expect({ code: err?.code, detail: err?.detail }).toEqual({ code: 'invalid_params', detail: 'ambiguous_slug' });
    // The first two readable spellings in code-unit order are named, whatever rows other sources hold.
    expect(err?.message).toContain(JSON.stringify(spell(255)));
    expect(err?.message).toContain(JSON.stringify(spell(128)));
  });

  test('finding 8: a stored spelling reads as the slug normalizeSlug makes of it, including characters that lowercase to two', async () => {
    await storeAs('f8/seed', 'F8/CAF\u00c9-\u0130', 'Unicode stored', 'u');
    expect((await call('get_page', { slug: 'f8/cafe\u0301-i\u0307' })).title).toBe('Unicode stored');
  });
});

describe('final review: a put by a spelling a page is stored under is refused, with or without a composed twin', () => {
  const content = '---\ntype: note\ntitle: Replaced\n---\nNew.\n';
  const snap = async (slug: string) => await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });

  test('finding 1: a decomposed page beside its composed twin is not written by a put by the decomposed spelling', async () => {
    const nfd = 'f1/caf\u0065\u0301-twin';
    const nfc = 'f1/caf\u00e9-twin';
    await storeAs('f1/twin-seed', nfd, 'Decomposed original', 'old');
    await call('put_page', { slug: nfc, content: page('Composed original', 'composed') });
    const before = { nfd: (await snap(nfd))!.revision, nfc: (await snap(nfc))!.revision };
    const answers: Array<string | undefined> = [];
    for (const extra of [{}, { expected_revision: before.nfd }, { expected_revision: before.nfc }]) {
      answers.push((await errorOf('put_page', { slug: nfd, content, request_id: crypto.randomUUID(), ...extra }))?.detail);
    }
    expect(answers).toEqual(['legacy_slug_spelling', 'legacy_slug_spelling', 'legacy_slug_spelling']);
    expect({ nfd: (await snap(nfd))!.revision, nfc: (await snap(nfc))!.revision }).toEqual(before);
    expect((await snap(nfc))!.page.title).toBe('Composed original');
  });

  test('finding 1: a forced put by the decomposed spelling does not write the decomposed page or its composed twin', async () => {
    const nfd = 'f1/caf\u0065\u0301-force';
    const nfc = 'f1/caf\u00e9-force';
    await storeAs('f1/force-seed', nfd, 'Decomposed original', 'old');
    await call('put_page', { slug: nfc, content: page('Composed original', 'composed') });
    const before = { nfd: (await snap(nfd))!.revision, nfc: (await snap(nfc))!.revision };
    const err = await errorOf('put_page', { slug: nfd, content, force: true, request_id: crypto.randomUUID() });
    expect({ code: err?.code, detail: err?.detail }).toEqual({ code: 'invalid_params', detail: 'legacy_slug_spelling' });
    expect({ nfd: (await snap(nfd))!.revision, nfc: (await snap(nfc))!.revision }).toEqual(before);
    expect({ nfd: (await snap(nfd))!.page.title, nfc: (await snap(nfc))!.page.title })
      .toEqual({ nfd: 'Decomposed original', nfc: 'Composed original' });
  });

  test('finding 1: a capital-stored page is not replaced by a put by its capital spelling, and no lowercase page appears', async () => {
    await storeAs('f1/cap-seed', 'F1/Cap-Put', 'Capital original', 'old');
    const before = (await snap('F1/Cap-Put'))!.revision;
    const err = await errorOf('put_page', { slug: 'F1/Cap-Put', content, request_id: crypto.randomUUID() });
    expect({ code: err?.code, detail: err?.detail }).toEqual({ code: 'invalid_params', detail: 'legacy_slug_spelling' });
    expect(await snap('f1/cap-put')).toBeNull();
    expect((await snap('F1/Cap-Put'))!.revision).toBe(before);
  });
});

describe('final review finding 2: remember through an entity alias of a decomposed page ends', () => {
  let rememberEngine: PGLiteEngine;
  beforeAll(async () => {
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    rememberEngine = new PGLiteEngine(); await rememberEngine.connect({}); await rememberEngine.initSchema();
  }, 60_000);
  afterAll(async () => { await disposePersistenceConsumer(rememberEngine); await rememberEngine.disconnect(); resetGateway(); });

  test('the fact lands on the decomposed page and the composed twin is left as it was', async () => {
    const e = rememberEngine;
    const rctx = { engine: e, config: { engine: 'pglite', embedding_disabled: true } as never, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
    const run = (name: string, params: Record<string, unknown>) => operationsByName[name]!.handler(rctx, params) as Promise<Record<string, any>>;
    const nfd = 'people/zo\u0065\u0301-rem';
    const person = (title: string) => `---\ntitle: ${title}\ntype: person\n---\nbody\n`;
    await run('put_page', { slug: 'people/zo\u00e9-rem', content: person('Zoe composed') });
    await run('put_page', { slug: 'people/zoe-rem-seed', content: person('Zoe decomposed') });
    await e.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [nfd, 'people/zoe-rem-seed']);
    await e.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = $1', [nfd]);
    await e.executeRaw(`INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES ('default', 'zozo unique', $1)`, [nfd]);
    await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await registerLocalWriter(e, 'cli'); await registerLocalWriter(e, 'stdio');
    await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const twinBefore = (await e.readPageSnapshot('people/zo\u00e9-rem', { sourceId: 'default' }))!.revision;
    const out = await run('remember', { fact: 'Zoe likes tea', entity: 'Zozo Unique', provenance: 'chat 2026-10-21', infer_entity: false });
    expect({ status: out.status, entity: out.entity_slug }).toEqual({ status: 'inserted', entity: nfd });
    expect((await e.getPage(nfd))!.compiled_truth).toContain('Zoe likes tea');
    expect((await e.readPageSnapshot('people/zo\u00e9-rem', { sourceId: 'default' }))!.revision).toBe(twinBefore);
  }, 60_000);
});
