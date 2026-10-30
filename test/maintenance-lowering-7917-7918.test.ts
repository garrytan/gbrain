/**
 * #7917 / #7918 part 2: a maintenance publication that lowers a page files a `lower_page` proposal, and a derivation
 * declaration that is present but unreadable fails closed at `unknown`.
 *
 * 1. Protects: a declared maintenance write over a page the owner wrote (a patterns grounding repair outside the output
 *    prefix) lowers the page and files one pending `lower_page` proposal the owner sees in `gbrain trust review`, on a
 *    managed repository brain (the coordinator's maintenance publication) and on a repo-less brain (the unmanaged
 *    derived transaction). A maintenance write whose declaration is present but malformed publishes at `unknown`, the
 *    committed file carries the `unknown` marker, and the marker rule stamps it; it never falls back to the request's
 *    channel or the source default.
 * 2. Fails when: a maintenance lowering files no proposal, or an unreadable declaration rates the write by its channel.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set; repository-backed (managed) and repo-less brains. No
 *    embedding, no model calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withTrustPromotion } from '../src/core/persistence/context.ts';
import { maintenancePreflight, publishMaintenancePages } from '../src/core/persistence/prepared-maintenance.ts';
import { stampPageTrustMarker } from '../src/core/trust/page-write.ts';
import { declareDerivation, derivedMaintenanceTransaction } from '../src/core/trust/taint.ts';
import { compareTrust, storedTrustTier } from '../src/core/trust/tier.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const OWNER_PAGE = '---\ntitle: Acme Example\ntype: company\n---\nOwner notes.\n';
const GROUNDED = '---\ntitle: Acme Example\ntype: company\n---\nOwner notes.\n\nA grounded line a derivation wrote.\n';
const derivation = declareDerivation({ tier: 'agent_written', origin: { channel: 'derive:patterns' } }, []);
const UNREADABLE = { tier: 'agent_written', origin: { channel: 'derive:patterns' }, inputs: [{ table: 'not_a_table', id: 1 }] };

const tierOf = async (engine: BrainEngine, slug: string) => storedTrustTier(
  (await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]))[0]?.trust_tier);
/** The owner's confirmation of a page (the fixture stands in for gbrain trust confirm). */
const confirmTier = (engine: BrainEngine, slug: string, managed: boolean) => {
  const raise = (tx: BrainEngine) => withTrustPromotion(tx, 'user_confirmed', () =>
    tx.executeRaw("UPDATE pages SET trust_tier = 'operator_curated' WHERE source_id = 'default' AND slug = $1", [slug]));
  return managed ? withManagedFixtureWrite(engine, ['default'], raise) : engine.transaction(raise);
};
const proposalsOf = (engine: BrainEngine, slug: string) => engine.executeRaw<{ action: string; proposer: string; status: string }>(
  `SELECT tp.action, tp.proposer, tp.status FROM trust_proposals tp JOIN pages p ON tp.target_table = 'pages' AND tp.target_id = p.id
    WHERE p.source_id = 'default' AND p.slug = $1 ORDER BY tp.id`, [slug]);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`[${backend}] #7917 #7918 managed maintenance publications (repository brain)`, () => {
    const seedOwnerPage = async (ctx: Parameters<Parameters<typeof managedBrain>[0]>[0]['ctx'], slug: string) => {
      await operationsByName.put_page.handler(ctx, { slug, content: OWNER_PAGE });
      await settleManagedGitEffects(ctx.engine);
      await confirmTier(ctx.engine, slug, true);
      return (await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    };

    test('a declared maintenance write that lowers an owner page files one pending lower_page proposal', () => managedBrain(async ({ engine, ctx }) => {
      const slug = 'companies/acme-example';
      const before = await seedOwnerPage(ctx, slug);
      const prior = await tierOf(engine, slug);
      expect(compareTrust(prior, 'agent_written')).toBeGreaterThan(0);
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const [outcome] = await publishMaintenancePages(engine, authority, [{ slug, content: GROUNDED, expectedRevision: before.revision, derivation }]);
      expect(outcome).not.toHaveProperty('error');
      await settleManagedGitEffects(engine);
      expect(await tierOf(engine, slug)).toBe('agent_written');
      const proposals = await proposalsOf(engine, slug);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ action: 'lower_page', status: 'pending' });
      expect(proposals[0]!.proposer).toStartWith('derived_page:');
    }, { databaseUrl }), 120_000);

    test('a present but unreadable declaration publishes at unknown and the file carries the unknown marker', () => managedBrain(async ({ engine, ctx, root }) => {
      const slug = 'companies/acme-unreadable';
      const before = await seedOwnerPage(ctx, slug);
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const [outcome] = await publishMaintenancePages(engine, authority, [{ slug, content: GROUNDED, expectedRevision: before.revision, derivation: UNREADABLE as never }]);
      expect(outcome).not.toHaveProperty('error');
      await settleManagedGitEffects(engine);
      expect(await tierOf(engine, slug)).toBe('unknown');
      expect(parseMarkdown(readFileSync(join(root, `${slug}.md`), 'utf8'), slug).frontmatter.trust_tier).toBe('unknown');
      expect((await proposalsOf(engine, slug)).map(p => p.action)).toEqual(['lower_page']);
    }, { databaseUrl }), 120_000);
  });

  describe(`[${backend}] #7917 unmanaged derived transactions (repo-less brain)`, () => {
    let pglite: PGLiteEngine;
    let engine: BrainEngine;
    let close: () => Promise<void> = async () => {};
    beforeAll(async () => {
      if (backend === 'pglite') { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
    }, 120_000);
    afterAll(async () => { if (backend === 'pglite') await pglite.disconnect(); else await close(); });
    beforeEach(async () => {
      if (backend === 'pglite') { await resetPgliteState(pglite); engine = pglite; }
      else { await close(); ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!)); }
    }, 120_000);

    test('a derived rewrite of an owner page lowers it and files one pending lower_page proposal', async () => {
      const slug = 'companies/acme-repo-less';
      await importFromContent(engine, slug, OWNER_PAGE, { sourceId: 'default', noEmbed: true });
      await confirmTier(engine, slug, false);
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      const trust = { tier: 'agent_written' as const, origin: { channel: 'derive:patterns' } };
      await derivedMaintenanceTransaction(engine, { trust, inputs: [] }, async tx => {
        await importFromContent(tx, slug, GROUNDED, { sourceId: 'default', noEmbed: true, preserveGateMarkers: true });
        return { result: undefined, rows: [{ table: 'pages' as const, id: Number(snapshot.page.id), sourceId: 'default',
          prior: { slug, tier: 'operator_curated' as const, revision: snapshot.revision } }] };
      });
      expect(await tierOf(engine, slug)).toBe('agent_written');
      const proposals = await proposalsOf(engine, slug);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ action: 'lower_page', status: 'pending', proposer: 'derived_page:derive:patterns' });
    }, 120_000);
  });
}

// Value: protects=the marker rule fails closed on an unreadable declaration; fails_when=the guard reads only well-formed declarations again; why_new=the managed case above covers the file, this pins the rule's own tier; seam=none; no_claim=none beyond protects
describe('#7918 stampPageTrustMarker: an unreadable derivation declaration still stamps', () => {
  test('a maintenance write carrying a malformed declaration stamps the write tier', () => {
    const fm: Record<string, unknown> = {};
    stampPageTrustMarker({ operation: 'submit_job', intent: { kind: 'managed_maintenance_page', derivation: UNREADABLE } } as never, fm,
      { tier: 'unknown', origin: { channel: 'derivation_unreadable' } }, 'operator_curated');
    expect(fm.trust_tier).toBe('unknown');
  });
});
