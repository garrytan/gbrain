/**
 * GBRA-156: `whois` on real Postgres. The unit suite (test/whois.test.ts)
 * pins matching, ambiguity, validation and the remote read contract on
 * PGLite; this proves the same statement on pgvector Postgres: exact matches
 * through every probe, no near-name match, a remote caller blind to
 * ungranted sources and private or quarantined pages, and index-served
 * candidate arms.
 *
 * Gated by DATABASE_URL — skips gracefully without real Postgres.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { seedWhoisFixture, whoisCandidatePlan } from '../helpers/whois-fixture.ts';

const SKIP = !hasDatabase();
const describePg = SKIP ? describe.skip : describe;

function mkCtx(overrides: Record<string, unknown> = {}) {
  return { engine: getEngine(), config: {} as never, logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    dryRun: false, remote: false, ...overrides } as never;
}
const remote = () => mkCtx({ remote: true, transport: 'stdio', sourceId: 'source-a', auth: { allowedSources: ['source-a'] } });

interface Result { matches: Array<{ slug: string; source_id: string; match: string }>; ambiguous: boolean }
const whois = (ctx: unknown, params: Record<string, unknown>) => operationsByName['whois']!.handler(ctx as never, params) as Promise<Result>;
const hits = (r: Result) => r.matches.map(m => `${m.source_id}:${m.slug}:${m.match}`);

describePg('whois on real Postgres (GBRA-156)', () => {
  beforeAll(async () => {
    await setupDB();
    await seedWhoisFixture(getEngine());
  }, 240_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('accents, case, width forms and quotes fold; email compares whole addresses case-insensitively', async () => {
    for (const query of ['Jose Example', 'JOSÉ EXAMPLE', 'Ｊｏｓｅ\u3000Ｅｘａｍｐｌｅ', '  "José Example"  ']) {
      expect(hits(await whois(mkCtx(), { query }))).toEqual(['source-a:people/jose-example:title']);
    }
    expect(hits(await whois(mkCtx(), { query: 'José Sample' }))).toEqual(['source-a:people/jose-sample:title']);
    expect(hits(await whois(mkCtx(), { query: 'Lukasz Example' }))).toEqual(['source-a:people/lukasz-example:title']);
    expect(hits(await whois(mkCtx(), { query: 'Alice@ACME-Example.com' }))).toEqual(['source-a:people/alice-example:email']);
    expect(hits(await whois(mkCtx(), { query: 'b.example@widget-co.example' }))).toEqual(['source-a:people/bob-example:email']);
    expect(hits(await whois(mkCtx(), { query: 'dana.example@acme-example.com' }))).toEqual(['source-a:contacts/contact-0001:email']);
  });

  test('aliases match as alias, ranked after titles and emails, and ambiguity is explicit', async () => {
    const byName = await whois(mkCtx(), { query: 'erin example' });
    expect(hits(byName)).toEqual(['source-a:people/erin-example:title', 'source-b:people/erin-example:title', 'source-a:people/e-example:alias']);
    expect(byName.ambiguous).toBe(true);
    expect(hits(await whois(mkCtx(), { query: 'erin@acme-example.com', source_id: 'source-a' })))
      .toEqual(['source-a:people/erin-example:email', 'source-a:people/e-example:alias']);
  });

  test('near names never match and the result is an explicit empty list', async () => {
    for (const query of ['Matt Example', 'Rob Example', 'Jose Exampel', 'Example', 'Kim Example', 'alice@acme-example.co']) {
      expect(await whois(mkCtx(), { query })).toMatchObject({ matches: [], ambiguous: false });
    }
  });

  test('a remote caller never sees an ungranted source, a private or quarantined page, a deleted page or an archived source', async () => {
    expect(hits(await whois(mkCtx(), { query: 'frank@acme-example.com' }))).toEqual(['source-b:people/frank-example:email']);
    expect(hits(await whois(mkCtx(), { query: 'Grace Example' }))).toEqual(['source-a:people/grace-example:title']);
    for (const query of ['frank@acme-example.com', 'Frank Example', 'grace@acme-example.com', 'Grace Example', 'heidi@acme-example.com', 'Heidi Example', 'ivan@acme-example.com', 'Judy Example']) {
      const res = await whois(remote(), { query });
      expect(res.matches).toEqual([]);
      expect(JSON.stringify(res)).not.toMatch(/frank-example|grace-example|heidi-example|ivan-example|judy-example/);
    }
    await expect(whois(remote(), { query: 'Frank Example', source_id: 'source-b' })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(hits(await whois(remote(), { query: 'Erin Example' }))).toEqual(['source-a:people/erin-example:title', 'source-a:people/e-example:alias']);
  });

  test('every probe is served by an index: no sequential scan of pages or page_aliases', async () => {
    const plan = await whoisCandidatePlan(getEngine());
    expect(plan).not.toMatch(/Seq Scan on (pages|page_aliases)\b/);
    for (const index of ['idx_pages_source_title_lower', 'idx_pages_slug_basename', 'idx_pages_frontmatter']) expect(plan).toContain(index);
    expect(plan).toMatch(/(on|using) page_aliases_\w+/);
  });
});
