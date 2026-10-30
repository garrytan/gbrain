/**
 * GBRA-156: `whois`, the exact identity lookup, on PGLite.
 *
 * Protects: an email or name resolves only on an exact match (email, title or
 * declared alias, ignoring case, accents, width forms and surrounding quotes),
 * never on a fuzzy, nickname, typo or partial one; ambiguity and an empty
 * result are explicit; and a remote caller never sees a page in an ungranted
 * source, a private or quarantined page, a deleted page or an archived source.
 * The Postgres twin is test/e2e/whois-postgres.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { seedWhoisFixture, whoisCandidatePlan } from './helpers/whois-fixture.ts';

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
  await seedWhoisFixture(engine);
});

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as never,
    config: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    dryRun: false,
    remote: false,
    ...overrides,
  } as OperationContext;
}
const local = () => ctxOf();
const remote = () => ctxOf({ remote: true, transport: 'stdio', sourceId: 'source-a', auth: { allowedSources: ['source-a'] } as never });

interface Match { slug: string; source_id: string; title: string; type: string; match: string }
interface Result { query_kind: string; matches: Match[]; ambiguous: boolean; types_status: string; note?: string }
const whois = async (ctx: OperationContext, params: Record<string, unknown>) =>
  await operationsByName['whois']!.handler(ctx, params) as Result;
const hits = (r: Result) => r.matches.map(m => `${m.source_id}:${m.slug}:${m.match}`);

describe('whois matches exactly, ignoring case, accents, width and quotes', () => {
  test.each([
    ['unaccented query, accented title', 'Jose Example', 'source-a:people/jose-example:title'],
    ['accented query, unaccented title', 'José Sample', 'source-a:people/jose-sample:title'],
    ['upper case', 'JOSÉ EXAMPLE', 'source-a:people/jose-example:title'],
    ['mixed case', 'jOsE eXaMpLe', 'source-a:people/jose-example:title'],
    ['full-width forms and an ideographic space', 'Ｊｏｓｅ\u3000Ｅｘａｍｐｌｅ', 'source-a:people/jose-example:title'],
    ['surrounding quotes and whitespace', '  "José Example"  ', 'source-a:people/jose-example:title'],
    ['typographic quotes', '\u201cJose Example\u201d', 'source-a:people/jose-example:title'],
    ['decomposed accent in the query', 'Jose\u0301 Example', 'source-a:people/jose-example:title'],
    ['stroke letter', 'Lukasz Example', 'source-a:people/lukasz-example:title'],
  ])('%s', async (_label, query, expected) => {
    const res = await whois(local(), { query });
    expect(res.query_kind).toBe('name');
    expect(hits(res)).toEqual([expected]);
    expect(res.ambiguous).toBe(false);
  });

  test.each([
    ['frontmatter email, query in another case', 'Alice@ACME-Example.com', 'source-a:people/alice-example:email'],
    ['second address of an emails list', 'b.example@widget-co.example', 'source-a:people/bob-example:email'],
    ['angle brackets around the address', '<alice@acme-example.com>', 'source-a:people/alice-example:email'],
    ['mixed-case stored address declared as an alias (contact shape)', 'dana.example@acme-example.com', 'source-a:contacts/contact-0001:email'],
  ])('email: %s', async (_label, query, expected) => {
    const res = await whois(local(), { query });
    expect(res.query_kind).toBe('email');
    expect(hits(res)).toEqual([expected]);
  });

  test('a declared alias matches and is labeled alias; titles rank before aliases; ambiguity is explicit', async () => {
    const res = await whois(local(), { query: 'erin example' });
    expect(hits(res)).toEqual([
      'source-a:people/erin-example:title',
      'source-b:people/erin-example:title',
      'source-a:people/e-example:alias',
    ]);
    expect(res.ambiguous).toBe(true);
  });

  test('an email match ranks before an alias holding the same address', async () => {
    const res = await whois(local(), { query: 'ERIN@acme-example.com', source_id: 'source-a' });
    expect(hits(res)).toEqual(['source-a:people/erin-example:email', 'source-a:people/e-example:alias']);
    expect(res.ambiguous).toBe(true);
  });

  test('source_id narrows the lookup to one source', async () => {
    expect(hits(await whois(local(), { query: 'Erin Example', source_id: 'source-b' }))).toEqual(['source-b:people/erin-example:title']);
  });
});

describe('whois never matches a near name', () => {
  test.each([
    ['short given name', 'Matt Example'],
    ['nickname', 'Rob Example'],
    ['typo', 'Jose Exampel'],
    ['surname alone', 'Example'],
    ['given name alone', 'José'],
    ['reordered name', 'Example, José'],
    ['first word of a title', 'Matthew'],
    ['the slug basename but not the title', 'Kim Example'],
    ['different address', 'alice@acme-example.co'],
    ['address local part only', 'alice'],
  ])('%s: explicit empty result, not an error', async (_label, query) => {
    const res = await whois(local(), { query });
    expect(res.matches).toEqual([]);
    expect(res.ambiguous).toBe(false);
  });

  test('a page whose body or longer title mentions the name is not a match', async () => {
    expect(hits(await whois(local(), { query: 'Matt Example', types: ['note', 'person'] }))).toEqual([]);
  });
});

describe('whois type filter', () => {
  test('defaults to the schema pack entity types; types widens or narrows it', async () => {
    expect(hits(await whois(local(), { query: 'Jose Example' }))).toEqual(['source-a:people/jose-example:title']);
    expect(hits(await whois(local(), { query: 'Jose Example', types: ['note'] }))).toEqual(['source-a:notes/jose-example:title']);
    const both = await whois(local(), { query: 'Jose Example', types: ['person', 'note'] });
    expect(hits(both)).toEqual(['source-a:notes/jose-example:title', 'source-a:people/jose-example:title']);
    expect(both.ambiguous).toBe(true);
  });

  test('invalid parameters are refused', async () => {
    for (const params of [{ query: '' }, { query: '  ""  ' }, { query: 'x'.repeat(321) }, { query: 'Jose Example', types: [] }, { query: 'Jose Example', types: ['bad type'] }]) {
      await expect(whois(local(), params)).rejects.toBeInstanceOf(OperationError);
    }
  });
});

describe('whois candidate read', () => {
  test('every probe is served by an index: no sequential scan of pages or page_aliases', async () => {
    const plan = await whoisCandidatePlan(engine);
    expect(plan).not.toMatch(/Seq Scan on (pages|page_aliases)\b/);
    for (const index of ['idx_pages_source_title_lower', 'idx_pages_slug_basename', 'idx_pages_frontmatter']) expect(plan).toContain(index);
    expect(plan).toMatch(/(on|using) page_aliases_\w+/);
  });
});

describe('whois read safety', () => {
  test('a local caller sees every live page; deleted pages and archived sources never match', async () => {
    expect(hits(await whois(local(), { query: 'frank@acme-example.com' }))).toEqual(['source-b:people/frank-example:email']);
    expect(hits(await whois(local(), { query: 'grace@acme-example.com' }))).toEqual(['source-a:people/grace-example:email']);
    expect(hits(await whois(local(), { query: 'Heidi Example' }))).toEqual(['source-a:people/heidi-example:title']);
    expect(hits(await whois(local(), { query: 'ivan@acme-example.com' }))).toEqual([]);
    expect(hits(await whois(local(), { query: 'Judy Example' }))).toEqual([]);
  });

  test('a remote caller never sees a page in an ungranted source', async () => {
    expect(hits(await whois(remote(), { query: 'frank@acme-example.com' }))).toEqual([]);
    expect(hits(await whois(remote(), { query: 'Frank Example', source_id: '__all__' }))).toEqual([]);
    expect(hits(await whois(remote(), { query: 'Erin Example' }))).toEqual(['source-a:people/erin-example:title', 'source-a:people/e-example:alias']);
    await expect(whois(remote(), { query: 'Frank Example', source_id: 'source-b' })).rejects.toMatchObject({ code: 'permission_denied' });
    const scalar = ctxOf({ remote: true, transport: 'stdio', sourceId: 'source-a' });
    expect(hits(await whois(scalar, { query: 'Frank Example' }))).toEqual([]);
  });

  test('a remote caller never sees a private or quarantined page, by email, title or alias', async () => {
    for (const query of ['grace@acme-example.com', 'Grace Example', 'heidi@acme-example.com', 'Heidi Example']) {
      const res = await whois(remote(), { query });
      expect(res.matches).toEqual([]);
      expect(JSON.stringify(res)).not.toContain('people/grace-example');
      expect(JSON.stringify(res)).not.toContain('people/heidi-example');
    }
  });
});
