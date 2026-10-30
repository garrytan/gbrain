/**
 * GBRA-156: the synthetic corpus the `whois` suites share (PGLite unit suite
 * test/whois.test.ts and the Postgres twin test/e2e/whois-postgres.test.ts).
 * Sources source-a and source-b; source-c is archived.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { normalizeAliasList } from '../../src/core/search/alias-normalize.ts';
import { exactIdentityStatement } from '../../src/core/engine-sql/exact-identity.ts';

/**
 * The plan of a name-and-email candidate read over 5,000 analyzed filler
 * pages (a third with an email, every one with an alias), so the planner
 * prices every probe against a real table: an arm no index serves plans a
 * Seq Scan on pages or page_aliases.
 */
export async function whoisCandidatePlan(engine: BrainEngine): Promise<string> {
  await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, frontmatter)
    SELECT CASE WHEN g % 2 = 0 THEN 'source-a' ELSE 'source-b' END, 'people/filler-' || g, 'person', 'Filler Example ' || g,
           CASE WHEN g % 3 = 0 THEN jsonb_build_object('email', 'filler-' || g || '@widget-co.example') ELSE '{}'::jsonb END
      FROM generate_series(1, 5000) g`);
  await engine.executeRaw(`INSERT INTO page_aliases (source_id, alias_norm, slug)
    SELECT CASE WHEN g % 2 = 0 THEN 'source-a' ELSE 'source-b' END, 'filler alias ' || g, 'people/filler-' || g
      FROM generate_series(1, 5000) g`);
  await engine.executeRaw('ANALYZE pages');
  await engine.executeRaw('ANALYZE page_aliases');
  const { text, params } = exactIdentityStatement({
    probes: {
      titleKeys: ['jose example'], titleRaw: 'José Example', basenames: ['jose-example'],
      aliasKeys: ['jose example', 'alice@acme-example.com'], emails: ['alice@acme-example.com'],
    },
    sourceIds: ['source-a', 'source-b'],
    types: { types: ['person'], per_source: [] },
    remote: { excludePrivate: true },
    limit: 101,
  });
  const rows = await engine.executeRaw<Record<string, string>>('EXPLAIN ' + text, params);
  return rows.map(r => Object.values(r)[0]).join('\n');
}

type Fm = Record<string, unknown>;

export async function seedWhoisFixture(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(
    "INSERT INTO sources(id, name) VALUES ('source-a', 'source-a'), ('source-b', 'source-b'), ('source-c', 'source-c') ON CONFLICT DO NOTHING");
  const page = async (slug: string, type: string, title: string, frontmatter: Fm = {}, sourceId = 'source-a') => {
    await engine.putPage(slug, { type, title, compiled_truth: 'Synthetic page.', timeline: '', frontmatter } as never, { sourceId });
    const aliases = normalizeAliasList(frontmatter.aliases);
    if (aliases.length) await engine.setPageAliases(slug, sourceId, aliases);
  };
  await page('people/jose-example', 'person', 'José Example');
  await page('people/jose-sample', 'person', 'Jose Sample');
  await page('people/lukasz-example', 'person', 'Łukasz Example');
  await page('people/matthew-example', 'person', 'Matthew Example', {}, 'source-a');
  await page('people/robert-example', 'person', 'Robert Example');
  await page('people/kim-example', 'person', 'Kim Example-Acme');
  await page('notes/matt-example-meeting', 'note', 'Matt Example meeting', {});
  await page('notes/jose-example', 'note', 'José Example');
  await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@acme-example.com' });
  await page('people/bob-example', 'person', 'Bob Example', { emails: ['bob@acme-example.com', 'b.example@widget-co.example'] });
  await page('contacts/contact-0001', 'person', 'Dana Example', {
    emails: ['Dana.Example@Acme-Example.com'], aliases: ['Dana.Example@Acme-Example.com', 'Dana Example'],
  });
  await page('people/erin-example', 'person', 'Erin Example', { email: 'erin@acme-example.com' });
  await page('people/e-example', 'person', 'E. Example', { aliases: ['Erin Example', 'erin@acme-example.com'] });
  await page('people/erin-example', 'person', 'Erin Example', {}, 'source-b');
  await page('people/frank-example', 'person', 'Frank Example', { email: 'frank@acme-example.com' }, 'source-b');
  await page('people/grace-example', 'person', 'Grace Example', { email: 'grace@acme-example.com', visibility: 'private' });
  await page('people/heidi-example', 'person', 'Heidi Example', { email: 'heidi@acme-example.com', quarantine: 'synthetic' });
  await page('people/ivan-example', 'person', 'Ivan Example', { email: 'ivan@acme-example.com' });
  await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'people/ivan-example'");
  await page('people/judy-example', 'person', 'Judy Example', { email: 'judy@acme-example.com' }, 'source-c');
  await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'source-c'");
}
