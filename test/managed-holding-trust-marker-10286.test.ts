/**
 * #10286 follow-up: the holding page a managed fact extraction creates on a strict git-canonical source carries the
 * extraction's tier as its marker, never the request's higher page tier, so a rebuild from Git cannot lift the facts on it
 * above the tier they were published at (the extraction's tier is the lower of its declaration and its origin page's
 * current tier, `managedFactsTrust`).
 *
 * PGLite, and Postgres when DATABASE_URL is set. Synthetic data only.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishManagedEntityFacts } from '../src/core/facts/managed-fact-write.ts';
import { UNATTRIBUTED_MEMORY_SLUG } from '../src/core/facts-fence.ts';
import { newHoldingPageFrontmatter } from '../src/core/trust/page-write.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

test('a new holding page is marked at the lower of the writer tier and the extraction tier', () => {
  const row = { id: '00000000-0000-4000-a000-000000000001', operation: 'remember', authority: { remote: true }, intent: {} } as never;
  expect(newHoldingPageFrontmatter(row)).toEqual({ trust_tier: 'agent_written' });
  expect(newHoldingPageFrontmatter(row, 'external_untrusted')).toEqual({ trust_tier: 'external_untrusted' });
  expect(newHoldingPageFrontmatter(row, 'operator_curated')).toEqual({ trust_tier: 'agent_written' });
});

for (const backend of testBackends()) describe(`[${backend}] #10286 a managed extraction's holding page carries the extraction's tier`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('an external_untrusted extraction creates memory/unattributed marked external_untrusted', () => managedBrain(async ({ engine, root }) => {
    await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    const claim = 'The quarterly offsite moved to the second week of May.';
    await publishManagedEntityFacts(engine, 'default', null, [{ fact: claim, kind: 'fact', notability: 'medium', source: 'extraction 2026-11-11',
      visibility: 'world', embedding: null, sessionId: null }], { derivation: { trust: { tier: 'external_untrusted', origin: null }, inputs: [] } });
    await settleManagedGitEffects(engine);
    const [fact] = await engine.executeRaw<{ tier: string }>("SELECT trust_tier AS tier FROM facts WHERE source_id='default' AND fact=$1", [claim]);
    expect(fact!.tier).toBe('external_untrusted');
    const [page] = await engine.executeRaw<{ marker: string | null }>(
      "SELECT frontmatter->>'trust_tier' AS marker FROM pages WHERE source_id='default' AND slug=$1", [UNATTRIBUTED_MEMORY_SLUG]);
    expect(page!.marker).toBe('external_untrusted');
    expect(git(root, 'show', `HEAD:${UNATTRIBUTED_MEMORY_SLUG}.md`)).toContain('trust_tier: external_untrusted');
  }, { databaseUrl, setup: gitRepo }), 120_000);
});
