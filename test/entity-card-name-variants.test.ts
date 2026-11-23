/**
 * #7160: the entity card's name-variant arm (nickname, initial, title,
 * reordering, typo, surname) on PGLite. Synthetic names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { readPossibleDuplicates, resolveNameVariant, VARIANT_ROW_COLUMNS } from '../src/core/verbs/entity-variants.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

const person = (slug: string, title: string, extra: Record<string, unknown> = {}) =>
  engine.putPage(slug, { title, type: 'person', compiled_truth: `${title} works at acme-example.`, frontmatter: extra } as never);

beforeEach(async () => {
  await resetPgliteState(engine);
  await person('people/alice-example', 'Alice Example');
  await person('people/robert-thistlewood', 'Robert Thistlewood');
  await person('people/katherine-quillfeather', 'Katherine Quillfeather');
  await person('people/alicia-sample', 'Alicia Sample');
  await person('people/bob-sample', 'Bob Sample');
  await engine.putPage('notes/people-index', { title: 'People index', type: 'note', compiled_truth: 'Alice Example, Robert Thistlewood, Katherine Quillfeather, Alicia Sample.' } as never);
});

const lookup = async (name: string, remote = false) => buildEntityCard(engine, 'default', name, { remote, variants: true });

describe('name variants resolve to the one matching person', () => {
  const cases: Array<[string, string, string]> = [
    ['Allie Example', 'people/alice-example', 'diminutive'],
    ['A. Example', 'people/alice-example', 'initial'],
    ['example alice', 'people/alice-example', 'reordered'],
    ['Example, Alice', 'people/alice-example', 'reordered'],
    ['Dr. Alice Example', 'people/alice-example', 'honorific'],
    ['Alice Exmaple', 'people/alice-example', 'typo'],
    ['Bob Thistlewood', 'people/robert-thistlewood', 'diminutive'],
    ['Thistlewood', 'people/robert-thistlewood', 'surname'],
    ['Kate Quillfeather', 'people/katherine-quillfeather', 'diminutive'],
  ];
  for (const [name, slug, kind] of cases) {
    test(`${name} -> ${slug} (${kind})`, async () => {
      const res = await lookup(name);
      expect(res.found).toBe(true);
      expect(res.card!.entity.slug).toBe(slug);
      expect(res.card!.match).toEqual({ kind: kind as never, via: name });
    });
  }

  test('an exact title keeps resolving without a match annotation', async () => {
    const res = await lookup('Alice Example');
    expect(res.card!.entity.slug).toBe('people/alice-example');
    expect(res.card!.match).toBeUndefined();
  });
});

describe('ambiguity never resolves to a person', () => {
  test('a surname two people share resolves nothing and suggests both', async () => {
    const res = await lookup('Sample');
    expect(res.found).toBe(false);
    expect(res.suggestions!.map(s => s.slug).sort()).toEqual(['people/alicia-sample', 'people/bob-sample']);
  });

  test('a different given name with the same surname is not a variant', async () => {
    const res = await lookup('Margaret Thistlewood');
    expect(res.found).toBe(false);
  });

  test('two typo candidates refuse', async () => {
    await person('people/alice-exampre', 'Alice Exampre');
    const res = await lookup('Alice Exampe');
    expect(res.found).toBe(false);
  });
});

describe('suggestions are entity pages only', () => {
  test('an index page that names the person never appears in did-you-mean', async () => {
    const res = await lookup('Zed Quillfeather');
    expect(res.found).toBe(false);
    expect((res.suggestions ?? []).map(s => s.slug)).not.toContain('notes/people-index');
  });
});

describe('title-prefixed duplicates are reported, never substituted', () => {
  beforeEach(async () => {
    await engine.putPage('people/mayor-thistlewood', { title: 'Mayor Thistlewood', type: 'person', compiled_truth: 'Mayor of a fictional town.' } as never);
  });

  test('the exact stub stays the card and names the person it likely duplicates', async () => {
    const res = await buildEntityCard(engine, 'default', 'Mayor Thistlewood', { remote: false, includeReferences: true, variants: true });
    expect(res.card!.entity.slug).toBe('people/mayor-thistlewood');
    expect(res.card!.possible_duplicates).toEqual([{ slug: 'people/robert-thistlewood', title: 'Robert Thistlewood', reason: 'title_prefix' }]);
  });

  test('the real page lists its prefixed stub', async () => {
    const res = await buildEntityCard(engine, 'default', 'Robert Thistlewood', { remote: false, includeReferences: true, variants: true });
    expect(res.card!.entity.slug).toBe('people/robert-thistlewood');
    expect(res.card!.possible_duplicates).toEqual([{ slug: 'people/mayor-thistlewood', title: 'Mayor Thistlewood', reason: 'title_prefix' }]);
  });

  test('a hyphenated surname pairs both ways', async () => {
    await person('people/ada-quill-example', 'Ada Quill-Example');
    await person('people/mayor-quill-example', 'Mayor Quill-Example');
    const stub = await buildEntityCard(engine, 'default', 'Mayor Quill-Example', { remote: false, includeReferences: true, variants: true });
    expect(stub.card!.possible_duplicates).toEqual([{ slug: 'people/ada-quill-example', title: 'Ada Quill-Example', reason: 'title_prefix' }]);
    const real = await buildEntityCard(engine, 'default', 'Ada Quill-Example', { remote: false, includeReferences: true, variants: true });
    expect(real.card!.possible_duplicates).toEqual([{ slug: 'people/mayor-quill-example', title: 'Mayor Quill-Example', reason: 'title_prefix' }]);
  });

  test('a surname two people share pairs the stub with nobody', async () => {
    await person('people/margaret-thistlewood', 'Margaret Thistlewood');
    const res = await buildEntityCard(engine, 'default', 'Mayor Thistlewood', { remote: false, includeReferences: true, variants: true });
    expect(res.card!.possible_duplicates).toBeUndefined();
    const real = await buildEntityCard(engine, 'default', 'Robert Thistlewood', { remote: false, includeReferences: true, variants: true });
    expect(real.card!.possible_duplicates).toBeUndefined();
  });

  test('a surname query prefers the real person over the title stub', async () => {
    const res = await lookup('Thistlewood');
    expect(res.card?.entity.slug).toBe('people/robert-thistlewood');
  });
});

describe('guesses stay out of proactive cards and across sources', () => {
  test('a card built without variants (context_pack, delta) never resolves a nickname', async () => {
    const res = await buildEntityCard(engine, 'default', 'Allie Example', { remote: false });
    expect(res.found).toBe(false);
  });

  test('one variant match in each of two sources is ambiguous', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('s2', 's2', '{}'::jsonb) ON CONFLICT (id) DO NOTHING");
    await engine.putPage('people/alice-example', { title: 'Alice Example', type: 'person', compiled_truth: 'Another person.' } as never, { sourceId: 's2' });
    const res = await buildEntityCard(engine, 'default', 'Allie Example', { remote: false, variants: true, sources: ['default', 's2'] });
    expect(res.found).toBe(false);
    expect(res.ambiguous).toBe(true);
    expect(res.suggestions!.map(x => x.source_id)).toEqual(['default', 's2']);
  });

  test('an exact name in a later source beats a variant in the home source', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('s2', 's2', '{}'::jsonb) ON CONFLICT (id) DO NOTHING");
    await engine.putPage('people/allie-example', { title: 'Allie Example', type: 'person', compiled_truth: 'Exact.' } as never, { sourceId: 's2' });
    const res = await buildEntityCard(engine, 'default', 'Allie Example', { remote: false, variants: true, sources: ['default', 's2'] });
    expect(res.source_id).toBe('s2');
    expect(res.card!.match).toBeUndefined();
  });
});

describe('read policy', () => {
  test('a remote caller never resolves a private person by variant', async () => {
    await engine.putPage('people/carol-hidden', { title: 'Carol Hidden', type: 'person', compiled_truth: 'Private.', frontmatter: { visibility: 'private' } } as never);
    const local = await lookup('C. Hidden', false);
    expect(local.card?.entity.slug).toBe('people/carol-hidden');
    const remote = await lookup('C. Hidden', true);
    expect(remote.found).toBe(false);
    expect((remote.suggestions ?? []).map(s => s.slug)).not.toContain('people/carol-hidden');
  });

  test('a projection or predicate the typed reads do not serve throws instead of answering no variants', async () => {
    const base = { retirementPrivacy: 'none' as const, entityTypes: new Set(['person']) };
    await expect(resolveNameVariant(engine, 'default', 'Allie Example', { ...base, selectColumns: 'slug, title', privatePredicate: '' }))
      .rejects.toThrow(TypeError);
    await expect(resolveNameVariant(engine, 'default', 'Allie Example', { ...base, selectColumns: VARIANT_ROW_COLUMNS, privatePredicate: ' AND true' }))
      .rejects.toThrow(TypeError);
    const row = { slug: 'people/alice-example', title: 'Alice Example', type: 'person', frontmatter: null };
    await expect(readPossibleDuplicates(engine, 'default', row, { ...base, selectColumns: 'slug, title', privatePredicate: '' }))
      .rejects.toThrow(TypeError);
    const ok = await resolveNameVariant(engine, 'default', 'Allie Example', { ...base, selectColumns: VARIANT_ROW_COLUMNS, privatePredicate: '' });
    expect(ok.hit?.row.slug).toBe('people/alice-example');
  });

  test('entity.name_variants=false turns the arm off', async () => {
    await engine.setConfig('entity.name_variants', 'false');
    const res = await lookup('Allie Example');
    expect(res.found).toBe(false);
  });
});
