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
import { normalizeSlugParams, SLUG_PARAMS, SLUG_PARAM_EXEMPT } from '../src/core/ops/slug-params.ts';
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

async function errorOf(name: string, params: Record<string, unknown>): Promise<{ code?: string; message?: string } | null> {
  try { await call(name, params); return null; } catch (e) { return e as { code?: string; message?: string }; }
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

  test('every registry entry names a param the op declares', () => {
    const byName = new Map(operations.map(op => [op.name, new Set(paramPaths(op.params).map(p => p.path))]));
    const stale = Object.entries(SLUG_PARAMS).flatMap(([op, paths]) => paths
      // An array of objects that declares no members (assemble_evidence.hits) is listed as `a[]`.
      .filter(path => !byName.get(op)?.has(path) && !byName.get(op)?.has(path.replace(/\[\]\..*$/, '[]')))
      .map(path => `${op}.${path}`));
    const staleExempt = Object.entries(SLUG_PARAM_EXEMPT).flatMap(([op, params]) =>
      Object.keys(params).filter(name => ![...(byName.get(op) ?? [])].some(path => path.replace('[]', '') === name)).map(name => `${op}.${name}`));
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

  test('a slug that names no page still answers page_not_found, naming the stored form', async () => {
    const err = await errorOf('get_page', { slug: 'People/Nobody-Example' });
    expect(err?.code).toBe('page_not_found');
    expect(err?.message).toBe('Page not found: people/nobody-example');
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
});
