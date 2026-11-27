/**
 * Every slug a caller passes is read in the form writes store it: lowercase, then Unicode NFC
 * (normalizeSlug in src/core/utils.ts, applied to op params by src/core/ops/slug-params.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Contract: a slug spelled with capitals, or decomposed (NFD, as macOS file names are), reaches the
 *     page that put_page stored for it, on reads (get_page, get_links, get_tags, get_timeline), on writes
 *     (no NFC/NFD twin pages), in body links (an NFD wikilink resolves to the NFC page) and in facts saved
 *     for an accented entity before its page exists.
 *  2. Regression: get_page answering page_not_found ("may be soft-deleted") for `People/Alice-Example`
 *     while put stored `people/alice-example`; two pages that print as `notes/café`; a link to an existing
 *     page listed as wanted; a fact saved for `people/ünal-example` stored under `people/unal-example` and
 *     never shown on the entity card.
 *  3. Existing coverage: every get_page/link/fact test writes and reads lowercase NFC slugs, so the
 *     write-side lowercase in validateSlug hid the read side.
 *  4. Seam: none. Real PGLite engine, registry operations.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { normalizeSlug } from '../src/core/utils.ts';
import { intentDigest } from '../src/core/persistence/journal.ts';
import { normalizeSlugParams, withNormalizedSlugParams, SLUG_PARAMS, SLUG_PARAM_EXEMPT } from '../src/core/ops/slug-params.ts';
import { operations } from '../src/core/operations.ts';
import type { ParamDef } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;

const NFC_CAFE = 'notes/café';
const NFD_CAFE = 'notes/café';
const NFC_ZOE = 'people/zoë-example';
const NFD_ZOE = 'people/zoë-example';
const NFC_UNAL = 'people/ünal-example';
const NFD_UNAL = 'People/Ünal-Example';

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

const page = (title: string, type: string, body: string) => `---\ntitle: ${title}\ntype: ${type}\n---\n${body}\n`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

describe('normalizeSlug', () => {
  test('lowercases, then composes to NFC', () => {
    expect(normalizeSlug('People/Alice-Example')).toBe('people/alice-example');
    expect(normalizeSlug(NFD_CAFE)).toBe(NFC_CAFE);
    expect(normalizeSlug(NFD_UNAL)).toBe(NFC_UNAL);
    expect(normalizeSlug(NFC_CAFE)).toBe(NFC_CAFE);
  });

  test('normalizeSlugParams reaches top-level, array and nested-object slug params and nothing else', () => {
    expect(normalizeSlugParams('get_page', { slug: 'People/X', source_id: 'Wiki' })).toEqual({ slug: 'people/x', source_id: 'Wiki' });
    expect(normalizeSlugParams('put_pages', { pages: [{ slug: NFD_CAFE, content: 'A' }] })).toEqual({ pages: [{ slug: NFC_CAFE, content: 'A' }] });
    expect(normalizeSlugParams('extraction_review', { slugs: ['A/B', 'c/d'], of: 'E/F' })).toEqual({ slugs: ['a/b', 'c/d'], of: 'e/f' });
    expect(normalizeSlugParams('questions_pin', { scope: { entity: 'People/X', slug_prefix: 'Deals/' } }))
      .toEqual({ scope: { entity: 'people/x', slug_prefix: 'deals/' } });
    const untouched = { slug: 'people/x' };
    expect(normalizeSlugParams('get_page', untouched)).toBe(untouched);
    expect(normalizeSlugParams('search', { query: 'People/X' })).toEqual({ query: 'People/X' });
  });
});

/** Every param path of an op, in SLUG_PARAMS notation (`a`, `a[]`, `a[].b`, `a.b`). */
function paramPaths(params: Record<string, ParamDef>, prefix = ''): Array<{ path: string; leaf: string }> {
  return Object.entries(params).flatMap(([name, def]) => {
    const here = `${prefix}${name}`;
    if (def.type === 'array') {
      const items = def.items;
      return items?.properties ? paramPaths(items.properties, `${here}[].`) : [{ path: `${here}[]`, leaf: name }];
    }
    return def.properties ? [{ path: here, leaf: name }, ...paramPaths(def.properties, `${here}.`)] : [{ path: here, leaf: name }];
  });
}

describe('slug param registry', () => {
  test('every op param named like a slug is normalized or exempt with a reason', () => {
    const unclassified = operations.flatMap(op => paramPaths(op.params)
      .filter(({ path, leaf }) => /slug/i.test(leaf) && !(SLUG_PARAMS[op.name] ?? []).includes(path) && !SLUG_PARAM_EXEMPT[op.name]?.[path.replace('[]', '')])
      .map(({ path }) => `${op.name}.${path}`));
    expect(unclassified).toEqual([]);
  });

  test('the slug-carrying params that are not named slug are classified too', () => {
    const carrying: Array<[string, string]> = [['query', 'explain_target'], ['confirm_memory', 'ref'], ['rate_answer', 'pages[].ref'], ['takes_list', 'holder'],
      ['get_calibration_profile', 'holder'], ['resolve_slugs', 'partial'], ['find_pages', 'pattern'], ['add_timeline_entry', 'source'], ['ontology_propose', 'source']];
    const unclassified = carrying.filter(([op, path]) => !(SLUG_PARAMS[op] ?? []).includes(path) && !SLUG_PARAM_EXEMPT[op]?.[path]).map(([op, path]) => `${op}.${path}`);
    expect(unclassified).toEqual([]);
    // Each exemption is a promise that master's output for the param is unchanged: the params are not rewritten.
    for (const [op, path] of carrying) expect(SLUG_PARAMS[op] ?? []).not.toContain(path);
  });

  test('every registry entry names a param the op declares', () => {
    const byName = new Map(operations.map(op => [op.name, new Set(paramPaths(op.params).map(p => p.path))]));
    const stale = Object.entries(SLUG_PARAMS).flatMap(([op, paths]) => paths
      // An array of objects that declares no members (assemble_evidence.hits) is listed as `a[]`.
      .filter(path => !byName.get(op)?.has(path) && !byName.get(op)?.has(path.replace(/\[\]\..*$/, '[]')))
      .map(path => `${op}.${path}`));
    const staleExempt = Object.entries(SLUG_PARAM_EXEMPT).flatMap(([op, params]) =>
      Object.keys(params).filter(name => ![...(byName.get(op) ?? [])].some(path => path.replace('[]', '') === name.replace(/\[\]\..*$/, ''))).map(name => `${op}.${name}`));
    expect({ stale, staleExempt }).toEqual({ stale: [], staleExempt: [] });
  });
});

describe('slug reads use the stored form (pages-01)', () => {
  test('a mixed-case slug reads the page put stored lowercase, on every per-slug read', async () => {
    await call('put_page', { slug: 'companies/acme-example', content: page('Acme Example', 'company', 'Acme.') });
    const put = await call('put_page', { slug: 'People/Alice-Example',
      content: page('Alice Example', 'person', 'Alice Example works with [[companies/acme-example]].\n\n## Timeline\n\n- **2026-01-02** | Joined acme-example') });
    expect(put.slug).toBe('people/alice-example');
    await call('add_tag', { slug: 'PEOPLE/ALICE-EXAMPLE', tag: 'founder' });

    const got = await call('get_page', { slug: 'People/Alice-Example' });
    expect({ slug: got.slug, title: got.title }).toEqual({ slug: 'people/alice-example', title: 'Alice Example' });
    expect(await call<string[]>('get_tags', { slug: 'People/Alice-Example' })).toEqual(['founder']);
    const links = await call<Array<{ to_slug: string }>>('get_links', { slug: 'People/Alice-Example' });
    expect(links.map(l => l.to_slug)).toEqual(['companies/acme-example']);
    const timeline = await call<Array<{ date: string }>>('get_timeline', { slug: 'People/Alice-Example' });
    expect(timeline.length).toBeGreaterThan(0);
  });

  test('a slug that names no page still answers page_not_found, naming the slug as typed (as master does)', async () => {
    const err = await errorOf('get_page', { slug: 'People/Nobody-Example' });
    expect(err?.code).toBe('page_not_found');
    expect(err?.message).toBe('Page not found: People/Nobody-Example');
  });
});

describe('one page per Unicode spelling (pages-05)', () => {
  test('an NFD put lands on the NFC page instead of creating a twin, and either spelling reads it', async () => {
    await call('put_page', { slug: NFC_CAFE, content: page('Cafe', 'note', 'first') });
    const err = await errorOf('put_page', { slug: NFD_CAFE, content: page('Cafe', 'note', 'second') });
    expect(err?.code).toBe('revision_required');
    const listed = await call<Array<{ slug: string }>>('list_pages', { slug_prefix: 'notes/caf' });
    expect(listed.map(p => p.slug)).toEqual([NFC_CAFE]);
    expect((await call('get_page', { slug: NFD_CAFE })).slug).toBe(NFC_CAFE);
  });

  test('a page stored decomposed before this fix still opens with the spelling list printed', async () => {
    await call('put_page', { slug: 'notes/legacy-nfd', content: page('Legacy', 'note', 'old') });
    await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', ['notes/legacy-café', 'notes/legacy-nfd']);
    expect((await call('get_page', { slug: 'notes/legacy-café' })).slug).toBe('notes/legacy-café');
  });

  test('a list_pages continuation cursor is compared as the listing returned it, so no row between the two spellings is skipped', async () => {
    const stored = 'cursor/cafe\u0301';
    await call('put_page', { slug: 'cursor/cafz', content: page('Cafz', 'note', 'z one') });
    await call('put_page', { slug: 'cursor/cafe-x', content: page('Cafe x', 'note', 'x one') });
    await call('put_page', { slug: 'cursor/zzz', content: page('Zzz', 'note', 'z two') });
    await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, 'cursor/cafe-x']);
    await engine.executeRaw("UPDATE pages SET updated_at = TIMESTAMPTZ '2026-02-03 04:05:06+00' WHERE slug LIKE 'cursor/%'");
    const rows = await call<Array<{ slug: string }>>('list_pages', { slug_prefix: 'cursor/', sort: 'updated_asc', updated_after: '2026-02-03T04:05:06.000000Z', updated_after_slug: stored });
    const expected = (await call<Array<{ slug: string }>>('list_pages', { slug_prefix: 'cursor/', sort: 'updated_asc' })).map(r => r.slug).filter(s => s > stored);
    expect(rows.map(r => r.slug)).toEqual(expected);
  });

  test('a decomposed page keeps its tags and timeline on reads that answer an empty list, not page_not_found', async () => {
    const stored = 'notes/legacy-tags-cafe\u0301';
    await call('put_page', { slug: 'notes/legacy-tags', content: page('Legacy tags', 'note', 'old') });
    await call('add_tag', { slug: 'notes/legacy-tags', tag: 'kept' });
    await call('add_timeline_entry', { slug: 'notes/legacy-tags', date: '2026-01-02', summary: 'kept entry' });
    await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, 'notes/legacy-tags']);
    expect(await call<string[]>('get_tags', { slug: stored })).toEqual(['kept']);
    expect((await call<Array<{ summary: string }>>('get_timeline', { slug: stored })).map(e => e.summary)).toEqual(['kept entry']);
  });
});

describe('a request journaled before this change still replays', () => {
  test('put_page keeps the caller-sent slug in the request digest: an identical mixed-case retry replays, a changed body conflicts', async () => {
    const request_id = crypto.randomUUID();
    const first = await call('put_page', { slug: 'People/Replay-Example', content: page('Replay', 'person', 'one'), request_id });
    const again = await call('put_page', { slug: 'People/Replay-Example', content: page('Replay', 'person', 'one'), request_id });
    expect(again.revision).toBe(first.revision);
    const changed = await errorOf('put_page', { slug: 'People/Replay-Example', content: page('Replay', 'person', 'two'), request_id });
    expect(changed?.code).toBe('idempotency_conflict');
  });

  test('the stored request digest covers the slug as the caller spelled it, so rows journaled before this change keep matching', async () => {
    const request_id = crypto.randomUUID();
    const body = page('Digest', 'person', 'same body');
    await call('put_page', { slug: 'People/Digest-Example', content: body, request_id });
    const [row] = (await engine.executeRaw<{ digest: string }>('SELECT digest FROM persistence_requests WHERE request_id = $1::uuid', [request_id])) as unknown as Array<{ digest: string }>;
    const digestFor = (callerSlug: string) => intentDigest({ operation: 'put_page', sourceId: 'default', slug: 'people/digest-example', callerIntent: { slug: callerSlug, content: body } });
    expect(row?.digest).toBe(digestFor('People/Digest-Example'));
    expect(row?.digest).not.toBe(digestFor('people/digest-example'));
  });
});

describe('decomposed body links resolve (graph-10)', () => {
  test('an NFD wikilink to an existing NFC page makes an edge, not a wanted page', async () => {
    await call('put_page', { slug: NFC_ZOE, content: page('Zoe', 'person', 'Zoe.') });
    await call('put_page', { slug: 'people/hal-example', content: page('Hal', 'person', `Hal knows [[${NFD_ZOE}]].`) });
    const links = await call<Array<{ to_slug: string }>>('get_links', { slug: 'people/hal-example' });
    expect(links.map(l => l.to_slug)).toEqual([NFC_ZOE]);
    const wanted = await call<{ targets: Array<{ target: string }> }>('wanted_pages', {});
    expect(wanted.targets.map(t => t.target)).not.toContain(NFC_ZOE);
  });
});

describe('accented entities keep their slug in facts (memory-07)', () => {
  test('a fact saved before the page exists is on the entity card once the page is created', async () => {
    const saved = await call('remember', { fact: 'Unal Example likes golf', provenance: 'chat 2026-11-20', entity: NFD_UNAL });
    expect(saved.entity_slug).toBe(NFC_UNAL);
    await call('put_page', { slug: NFC_UNAL, content: page('Ünal Example', 'person', 'Ünal Example plays golf.') });
    const card = await call('entity', { name: 'Ünal Example' });
    expect({ slug: card.card?.entity?.slug, facts: card.card?.active_fact_count }).toEqual({ slug: NFC_UNAL, facts: 1 });
  });

  test('an accented reference still lands on the accent-folded page an import already created', async () => {
    await call('put_page', { slug: 'people/soren-example', content: page('Soren Example', 'person', 'Imported from a file.') });
    const saved = await call('remember', { fact: 'Soren Example likes chess', provenance: 'chat 2026-11-20', entity: 'people/s\u00f8ren-example' });
    const savedNfd = await call('remember', { fact: 'Soren Example likes go', provenance: 'chat 2026-11-20', entity: 'people/jose\u0301-example' });
    expect({ folded: saved.entity_slug, accented: savedNfd.entity_slug }).toEqual({ folded: 'people/soren-example', accented: 'people/jos\u00e9-example' });
  });

  test('a fact saved under the accent-folded subject before this change is still recalled for the accented reference', async () => {
    const before = await call('remember', { fact: 'Mehmet Example likes tea', provenance: 'chat 2026-11-19', entity: 'people/mehmet-example' });
    expect(before.entity_slug).toBe('people/mehmet-example');
    const accented = 'people/mehm\u00e9t-example';
    const after = await call('remember', { fact: 'Mehmet Example likes jazz', provenance: 'chat 2026-11-20', entity: accented });
    expect(after.entity_slug).toBe(accented);
    const recalled = await call<{ facts?: Array<{ fact: string }> }>('recall', { entity: accented });
    expect((recalled.facts ?? []).map(f => f.fact).sort()).toEqual(['Mehmet Example likes jazz', 'Mehmet Example likes tea']);
  });
});

/** Store `slug` and move it to a decomposed spelling, as a page written before writes composed slugs. */
async function legacyPage(slug: string, stored: string, body: string, sourceId = 'default'): Promise<void> {
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [sourceId]);
  await operationsByName.put_page!.handler({ ...ctx(), sourceId }, { slug, content: page(`Legacy ${slug}`, 'note', body) });
  await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2 AND source_id = $3', [stored, slug, sourceId]);
  // A raw slug update changes the knowledge revision and clears the served-text one; a real legacy page kept both in step.
  await engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = $1 AND source_id = $2', [stored, sourceId]);
}

describe('the legacy-spelling retry obeys the caller\'s source scope', () => {
  test('a composed twin in a source outside the caller\'s scope does not hide the caller\'s decomposed page', async () => {
    const stored = 'notes/scope-cafe\u0301';
    await legacyPage('notes/scope-seed', stored, 'mine', 'scope-y');
    await engine.executeRaw('INSERT INTO tags (page_id, tag) SELECT id, $1 FROM pages WHERE slug = $2 AND source_id = $3', ['mine', stored, 'scope-y']);
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', ['scope-x']);
    await operationsByName.put_page!.handler({ ...ctx(), sourceId: 'scope-x' }, { slug: 'notes/scope-caf\u00e9', content: page('Twin', 'note', 'twin') });
    const asY = { ...ctx(), sourceId: 'scope-y' };
    expect(await operationsByName.get_tags!.handler(asY, { slug: stored })).toEqual(['mine']);
  });

  test('the probe is made inside the caller\'s scope, never across sources', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const spy = { ...engine, getPage: async (slug: string, opts?: Record<string, unknown>) => { seen.push(opts); return null; } };
    const asY = { ...ctx(), engine: spy as never, sourceId: 'scope-y' };
    await withNormalizedSlugParams(operationsByName.get_tags!, async () => [])(asY, { slug: 'Notes/Scope-Probe-Cafe\u0301' }).catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(o => o?.sourceId === 'scope-y')).toBe(true);
  });
});

describe('a put by the exact decomposed spelling is refused: nothing moves and no composed twin is created', () => {
  const stored = 'notes/put-cafe\u0301';
  const composed = 'notes/put-caf\u00e9';
  const REFUSAL = `Page ${stored} is stored under an older decomposed Unicode spelling of its name, so a put by that spelling is refused and nothing was changed. `
    + `To move the page to the normal spelling ${composed}, preview gbrain repair slug-spelling --source default, then run the apply command it prints after the owner agrees; until then the page cannot be replaced by put.`;
  const rows = async () => (await engine.executeRaw<{ slug: string; knowledge_revision: string; compiled_truth: string }>(
    'SELECT slug, knowledge_revision::text AS knowledge_revision, compiled_truth FROM pages WHERE slug IN ($1, $2) ORDER BY slug', [stored, composed]));

  test('every put by that spelling gets the named refusal, and the stored page, its revision and its tags stay as they were', async () => {
    await legacyPage('notes/put-seed', stored, 'before');
    await engine.executeRaw('INSERT INTO tags (page_id, tag) SELECT id, $1 FROM pages WHERE slug = $2', ['kept', stored]);
    const before = await rows();
    const snapshot = await engine.readPageSnapshot(stored, { sourceId: 'default', includeDeleted: true });
    for (const extra of [{}, { expected_revision: snapshot!.revision }, { expected_revision: crypto.randomUUID() }, { force: true }]) {
      const err = await errorOf('put_page', { slug: stored, content: page('Twin', 'note', 'after'), ...extra }) as { code?: string; message?: string; detail?: string } | null;
      expect({ code: err?.code, detail: err?.detail, message: err?.message }).toEqual({ code: 'invalid_params', detail: 'legacy_slug_spelling', message: REFUSAL });
    }
    expect(await rows()).toEqual(before);
    expect(before.map(r => r.slug)).toEqual([stored]);
    expect((await call('get_page', { slug: stored })).compiled_truth).toContain('before');
    expect(await call<string[]>('get_tags', { slug: stored })).toEqual(['kept']);
  });
});

describe('writes that carry no digest over the slug normalize it like their reads', () => {
  test('ontology_propose with a mixed-case entity is read back by ontology_get with the same argument', async () => {
    await call('ontology_propose', { entity: 'People/Onto-Example', dimension: 'role', value: 'advisor' });
    const rows = await call<Array<{ entity_slug?: string; value: string }>>('ontology_get', { entity: 'People/Onto-Example' });
    expect(rows.map(r => r.value)).toEqual(['advisor']);
  });

  test('file_upload, file_register and ontology_propose receive the normal form; a journaled page write receives what was sent', async () => {
    const reached: Record<string, unknown> = {};
    const through = (name: string, key: string) => withNormalizedSlugParams({ ...operationsByName[name]!, mutating: true }, async (_c, p) => { reached[name] = p[key]; return null; });
    await through('file_upload', 'page_slug')(ctx(), { page_slug: 'People/File-Example' });
    await through('file_register', 'page_slug')(ctx(), { page_slug: 'notes/caf\u0065\u0301' });
    await through('ontology_propose', 'entity')(ctx(), { entity: 'People/Onto-Two' });
    await through('put_page', 'slug')(ctx(), { slug: 'People/Put-Example' });
    expect(reached).toEqual({ file_upload: 'people/file-example', file_register: 'notes/caf\u00e9', ontology_propose: 'people/onto-two', put_page: 'People/Put-Example' });
  });
});

describe('assemble_evidence joins on the stored slug', () => {
  test('a decomposed hit finds its own evidence, and a composed twin never returns the other page\'s', async () => {
    const stored = 'notes/ev-cafe\u0301';
    const composed = 'notes/ev-caf\u00e9';
    await legacyPage('notes/ev-seed', stored, 'legacy-only-marker words about the old page');
    await call('put_page', { slug: composed, content: page('Composed twin', 'note', 'composed-only-marker words about the new page') });
    const evidence = async (slug: string) => await call<{ results: Array<{ slug: string; chunk_text: string }>; unresolved: unknown[] }>('assemble_evidence',
      { hits: [{ source_id: 'default', slug, chunk_id: 0 }], return_unit: 'page' });
    const old = await evidence(stored);
    expect(old.unresolved).toEqual([]);
    expect(old.results.map(r => r.chunk_text).join(' ')).toContain('legacy-only-marker');
    expect(old.results.map(r => r.chunk_text).join(' ')).not.toContain('composed-only-marker');
    const twin = await evidence(composed);
    expect(twin.results.map(r => r.chunk_text).join(' ')).toContain('composed-only-marker');
    expect(twin.results.map(r => r.chunk_text).join(' ')).not.toContain('legacy-only-marker');
  });
});

describe('two stored spellings of one slug (ambiguity refusal only where a read found nothing before)', () => {
  const nfd = 'Notes/Ambig-Cafe\u0301';
  const nfc = 'Notes/Ambig-Caf\u00e9';
  const asked = 'notes/ambig-cafe\u0301';
  const REFUSAL = `The slug "${asked}" is ambiguous: this brain stores two pages whose slugs read the same, "${nfd}" (decomposed, with capitals) and "${nfc}" (composed, with capitals), and "${asked}" is neither of them exactly.`;

  test('a spelling that matches neither stored page, lowercased or normalized, is refused with both spellings named', async () => {
    await legacyPage('notes/ambig-seed-a', nfd, 'decomposed body');
    await legacyPage('notes/ambig-seed-b', nfc, 'composed body');
    for (const op of ['get_page', 'get_tags', 'get_timeline']) {
      const err = await errorOf(op, { slug: asked }) as { code?: string; detail?: string; message?: string; suggestion?: string } | null;
      expect({ op, code: err?.code, detail: err?.detail, message: err?.message }).toEqual({ op, code: 'invalid_params', detail: 'ambiguous_slug', message: REFUSAL });
      expect(err?.suggestion).toBe(`Send the exact stored spelling, "${nfd}" or "${nfc}" (copy it from list_pages or search), and nothing is read until then.`);
    }
  });

  test('each exact stored spelling still reads its own page, so the refusal never hides a page', async () => {
    expect((await call('get_page', { slug: nfd })).title).toBe('Legacy notes/ambig-seed-a');
    expect((await call('get_page', { slug: nfc })).title).toBe('Legacy notes/ambig-seed-b');
  });

  test('a read that found a page before still finds that page: the lowercased spelling wins over the normal form, so a capitalised decomposed read of two twins returns the decomposed page', async () => {
    await legacyPage('notes/twin-seed-a', 'notes/twin-cafe\u0301', 'decomposed twin body');
    await legacyPage('notes/twin-seed-b', 'notes/twin-caf\u00e9', 'composed twin body');
    expect((await call('get_page', { slug: 'Notes/Twin-Cafe\u0301' })).title).toBe('Legacy notes/twin-seed-a');
    expect(await call<unknown[]>('get_tags', { slug: 'NOTES/TWIN-CAFE\u0301' })).toEqual([]);
  });

  test('a capitalised composed spelling of two stored twins (composed and decomposed) returns the composed page, as before', async () => {
    await legacyPage('notes/capc-seed-a', 'notes/capc-cafe\u0301', 'decomposed capc body');
    await legacyPage('notes/capc-seed-b', 'notes/capc-caf\u00e9', 'composed capc body');
    expect((await call('get_page', { slug: 'Notes/Capc-Caf\u00e9' })).title).toBe('Legacy notes/capc-seed-b');
  });

  test('one stored spelling that only normalizes to the asked slug is that page', async () => {
    await legacyPage('notes/one-seed', 'Notes/One-Cafe\u0301', 'only one');
    expect((await call('get_page', { slug: 'notes/one-cafe\u0301' })).title).toBe('Legacy notes/one-seed');
  });

  test('a twin the caller cannot read never makes a read ambiguous (no existence oracle)', async () => {
    await legacyPage('notes/hidden-seed', 'Notes/Hidden-Cafe\u0301', 'visible decomposed body');
    await legacyPage('notes/hidden-seed-b', 'Notes/Hidden-Caf\u00e9', 'private twin body');
    await engine.executeRaw(`UPDATE pages SET frontmatter = jsonb_set(COALESCE(frontmatter, '{}'::jsonb), '{visibility}', '"private"') WHERE slug = 'Notes/Hidden-Caf\u00e9'`);
    const remote = { ...ctx(), remote: true } as OperationContext;
    const read = await operationsByName.get_page!.handler(remote, { slug: 'notes/hidden-cafe\u0301' }).then((r: any) => r, (e: { detail?: string }) => e);
    expect((read as { detail?: string }).detail).not.toBe('ambiguous_slug');
    expect((read as { title?: string }).title).toContain('Legacy notes/hidden-seed');
    // The local owner reads both pages, so for the owner the same slug is ambiguous: the private flag is what keeps the remote caller out of it.
    expect((await errorOf('get_page', { slug: 'notes/hidden-cafe\u0301' }))?.detail).toBe('ambiguous_slug');
  });
});

describe('prefixes and file/ontology keys use the stored spelling, normalized as the fallback', () => {
  const seen = async (opName: string, key: string, value: string): Promise<unknown> => {
    let reached: unknown;
    await withNormalizedSlugParams({ ...operationsByName[opName]! }, async (_c, p) => { reached = p[key]; return null; })(ctx(), { [key]: value });
    return reached;
  };

  test('takes_scorecard and get_recent_salience receive the prefix spelling that has pages, never both', async () => {
    await legacyPage('pre/seed-a', 'pre/cafe\u0301-a', 'a');
    await call('put_page', { slug: 'pre/caf\u00e9-b', content: page('B', 'note', 'b') });
    for (const [op, key] of [['takes_scorecard', 'domain_prefix'], ['get_recent_salience', 'slugPrefix']] as const) {
      expect(await seen(op, key, 'pre/cafe\u0301')).toBe('pre/cafe\u0301');
      expect(await seen(op, key, 'pre/caf\u00e9')).toBe('pre/caf\u00e9');
      expect(await seen(op, key, 'Pre/Nothing-Here')).toBe('pre/nothing-here');
    }
  });

  test('file_verify and ontology_get are offered the caller\'s spellings only when no other page owns them', async () => {
    const { legacySpellings } = await import('../src/core/ops/slug-params.ts');
    let offered: string[] = [];
    const probe = (opName: string, key: string) => withNormalizedSlugParams({ ...operationsByName[opName]! }, async (_c, p) => { offered = legacySpellings(String(p[key])); return null; });
    await probe('file_verify', 'slug')(ctx(), { slug: 'Orphan/Cafe\u0301-Files' });
    expect(offered).toEqual(['orphan/caf\u00e9-files', 'Orphan/Cafe\u0301-Files', 'orphan/cafe\u0301-files']);
    await legacyPage('own/seed', 'own/cafe\u0301', 'owned');
    await call('put_page', { slug: 'own/caf\u00e9', content: page('Own twin', 'note', 'twin') });
    await probe('ontology_get', 'entity')(ctx(), { entity: 'own/cafe\u0301' });
    expect(offered).toEqual(['own/cafe\u0301']);
    expect(legacySpellings('anything')).toEqual(['anything']);
  });
});
