/**
 * #7163: identifier-shaped queries get an exact probe before ranking.
 * Pure detection and containment, then the probe on PGLite. Synthetic data.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { identifierKeywordQuery, parseIdentifier, textContainsIdentifier, type IdentifierKind } from '../src/core/search/identifier-query.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { seedPage } from './helpers/keyword-paging-fixture.ts';
import { applyExactLookupTier, structuralExactLookup } from '../src/core/search/exact-lookup.ts';
import type { SearchResult } from '../src/core/types.ts';

describe('parseIdentifier', () => {
  const cases: Array<[string, IdentifierKind | null]> = [
    ['alice@example.com', 'email'],
    ['+1 415 555 0142', 'phone'],
    ['(415) 555-0142', 'phone'],
    ['415.555.0142', 'phone'],
    ['4155550142', 'digits'],
    ['https://example.com/a/b?x=1', 'url'],
    ['example.com', 'url'],
    ['a3f9c2e81b7d', 'hex'],
    ['INV-2026-00417', 'code'],
    ['"INV-2026-00417"', 'code'],
    ['2026-10-20', null],
    ['alice example', null],
    ['vendor switch', null],
    ['deadbeef', null],
    ['12345', null],
  ];
  for (const [q, kind] of cases) test(`${q} -> ${kind}`, () => expect(parseIdentifier(q)?.kind ?? null).toBe(kind));
});

describe('textContainsIdentifier', () => {
  const phone = parseIdentifier('415-555-0142')!;
  test('a phone matches every written format and the country code', () => {
    for (const t of ['call (415) 555-0142 now', 'tel: 415.555.0142', '+1 415 555 0142', 'x 4155550142 y', '+14155550142']) {
      expect(textContainsIdentifier(t, phone)).toBe(true);
    }
  });
  test('a phone does not match other digits or a run that merely contains it', () => {
    expect(textContainsIdentifier('id 941555014299 and 0142', phone)).toBe(false);
    expect(textContainsIdentifier('{"a":415,"b":555,"c":142}', phone)).toBe(false);
  });
  test('other identifiers need word boundaries', () => {
    const code = parseIdentifier('INV-2026-00417')!;
    expect(textContainsIdentifier('Invoice INV-2026-00417 paid', code)).toBe(true);
    expect(textContainsIdentifier('XINV-2026-004170', code)).toBe(false);
    expect(textContainsIdentifier('mail ALICE@example.com.', parseIdentifier('alice@example.com')!)).toBe(true);
  });
  test('the phone keyword query ORs the written forms', () => {
    const q = identifierKeywordQuery(phone);
    expect(q).toContain('4155550142');
    expect(q).toContain('"(415) 555-0142"');
    expect(q).toContain('415.555.0142');
  });
});

describe('identifier probe on PGLite', () => {
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
    await seedPage(engine, 'notes/vendor-contact', 'Front desk line is (415) 555-0142, ask for the billing team.');
    await seedPage(engine, 'notes/invoice-batch', 'Paid INV-2026-00417 on Friday; INV-2026-00418 pending.');
    await seedPage(engine, 'notes/stats-dump', '{"a":415,"b":555,"c":"0142","d":4155,"e":550142} 415 555 0142 not a phone 9415550142x');
    await seedPage(engine, 'notes/private-contact', 'Home line 415-555-0142.', { frontmatter: { visibility: 'private' } });
  });

  const slugs = async (q: string, excludePrivate = false) => (await structuralExactLookup(engine, q, { excludePrivate })).map(h => h.slug);

  test('a phone in another format finds the page that holds it', async () => {
    expect(await slugs('415-555-0142')).toContain('notes/vendor-contact');
    expect(await slugs('+1 415 555 0142')).toContain('notes/vendor-contact');
  });

  test('every hit is stamped as an identifier lookup', async () => {
    const hits = await structuralExactLookup(engine, '415-555-0142', {});
    expect(hits.every(h => h.exact_lookup === 'identifier')).toBe(true);
  });

  test('a code finds its page and not a page with a neighbouring code', async () => {
    expect(await slugs('INV-2026-00417')).toEqual(['notes/invoice-batch']);
    expect(await slugs('INV-2026-00419')).toEqual([]);
  });

  test('a private page is never injected for a caller that excludes private pages', async () => {
    expect(await slugs('415-555-0142', false)).toContain('notes/private-contact');
    expect(await slugs('415-555-0142', true)).not.toContain('notes/private-contact');
  });

  test('a plain-word query runs no identifier probe', async () => {
    expect(await slugs('billing team')).toEqual([]);
  });

  // #7935: the tier promoted its hits in reverse, so the best keyword match landed last of the promoted rows.
  test('promoted identifier hits keep the keyword order, best match first', async () => {
    await seedPage(engine, 'companies/acme-example', 'Acme Example owns acme-example.com. Mail desk@acme-example.com or visit acme-example.com and acme-example.com/support.');
    await seedPage(engine, 'people/alice-example', 'Alice Example works at acme-example.com.');
    await seedPage(engine, 'meetings/2026-04-03', 'Call notes; the agenda link was acme-example.com.');
    const hits = (await structuralExactLookup(engine, 'acme-example.com', {})).map(h => h.slug);
    expect(hits).toHaveLength(3);
    expect(hits[0]).toBe('companies/acme-example');
    const organic = [{ slug: 'notes/vendor-contact', source_id: 'default', score: 0.9, chunk_text: 'x' } as SearchResult,
      { slug: hits[2], source_id: 'default', score: 0.5, chunk_text: 'y' } as SearchResult];
    const out = await applyExactLookupTier(engine, organic, 'acme-example.com', {});
    expect(out.map(r => r.slug)).toEqual([...hits, 'notes/vendor-contact']);
    expect(out[0].score).toBeGreaterThan(out[1].score);
    expect(out[1].score).toBeGreaterThan(out[2].score);
  });
});
