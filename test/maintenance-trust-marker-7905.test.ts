/**
 * #7905: a derived page that a maintenance job publishes (a patterns child's staged page, a concept, a claim-source
 * rewrite: operation submit_job with a derivation declaration) carries the lower-only trust marker in its canonical
 * file, as a content write does, so re-reading the repository does not raise it.
 *
 * 1. Protects: the database row of a derived page is capped at its declared tier (at most agent_written), and the
 *    committed file now says so with a `trust_tier` marker. Rebuilding a brain from the repository (the owner import
 *    path: ownerSourceGateInput over the file's markers) stores the page at that tier, never at the source default
 *    (operator_curated). A forged higher marker in the child's content is lowered; an unchanged republication is a
 *    no-op.
 * 2. Fails when: a submit_job page publishes without the marker, so a re-read rates model-written text above
 *    agent_written.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set; a repository-backed managed brain (a repo-less brain
 *    has no file to re-read). No embedding, no model calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { maintenancePreflight, publishMaintenancePages } from '../src/core/persistence/prepared-maintenance.ts';
import { stampPageTrustMarker } from '../src/core/trust/page-write.ts';
import { declareDerivation } from '../src/core/trust/taint.ts';
import type { TrustTier } from '../src/core/trust/tier.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const tierOf = async (engine: BrainEngine, slug: string) =>
  (await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]))[0]?.trust_tier;

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`[${backend}] #7905 derived maintenance pages keep their tier when the repository is re-read`, () => {
    let rebuildEngine: PGLiteEngine;
    beforeAll(async () => {
      if (backend === 'pglite') { rebuildEngine = new PGLiteEngine(); await rebuildEngine.connect({}); await rebuildEngine.initSchema(); }
    }, 120_000);
    afterAll(async () => { if (backend === 'pglite') await rebuildEngine.disconnect(); });

    /** A fresh brain of the same engine that imports one committed file the way `gbrain import` / sync of the repository does. */
    const rebuildFrom = async (root: string, slug: string) => {
      const fresh = backend === 'postgres' ? await isolatedPersistencePostgres(databaseUrl!)
        : (await resetPgliteState(rebuildEngine), { engine: rebuildEngine, close: async () => {} });
      try {
        const result = await importFromFile(fresh.engine, join(root, `${slug}.md`), `${slug}.md`, { noEmbed: true });
        expect(result.status).toBe('imported');
        return await tierOf(fresh.engine, slug);
      } finally { await fresh.close(); }
    };

    const cases: Array<{ name: string; tier: TrustTier; content: string }> = [
      { name: 'a child-written page with no markers', tier: 'agent_written', content: '---\ntitle: Pattern\ntype: note\n---\nModel-written text.\n' },
      { name: 'a child-written page that forges a higher marker', tier: 'agent_written', content: '---\ntitle: Pattern\ntype: note\ntrust_tier: user_confirmed\n---\nModel-written text.\n' },
      { name: 'a page derived from external input', tier: 'external_untrusted', content: '---\ntitle: Digest\ntype: note\n---\nSummary of a captured email.\n' },
    ];
    for (const { name, tier, content } of cases) {
      test(`${name}: the file carries the ${tier} marker and a rebuild from the repository stores ${tier}`, () => managedBrain(async ({ engine, root }) => {
        const slug = 'wiki/notes/derived-example';
        const authority = (await maintenancePreflight(engine, 'default'))!;
        const derivation = declareDerivation({ tier, origin: { channel: 'derive:patterns' } }, []);
        const [outcome] = await publishMaintenancePages(engine, authority, [{ slug, content, expectedRevision: null, derivation }]);
        expect(outcome).not.toHaveProperty('error');
        await settleManagedGitEffects(engine);
        expect(await tierOf(engine, slug)).toBe(tier);
        expect(await rebuildFrom(root, slug)).toBe(tier);
        expect(parseMarkdown(readFileSync(join(root, `${slug}.md`), 'utf8'), slug).frontmatter.trust_tier).toBe(tier);
      }, { databaseUrl }), 120_000);
    }

    test('republishing the same derived content is a no-op: no new revision', () => managedBrain(async ({ engine }) => {
      const slug = 'wiki/notes/derived-noop';
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const derivation = declareDerivation({ tier: 'agent_written', origin: { channel: 'derive:patterns' } }, []);
      const content = '---\ntitle: Pattern\ntype: note\n---\nModel-written text.\n';
      await publishMaintenancePages(engine, authority, [{ slug, content, expectedRevision: null, derivation }]);
      await settleManagedGitEffects(engine);
      const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      const [outcome] = await publishMaintenancePages(engine, authority, [{ slug, content, expectedRevision: before.revision, derivation }]);
      expect(outcome).not.toHaveProperty('error');
      expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision).toBe(before.revision);
    }, { databaseUrl }), 120_000);
  });
}

// Value: protects=the marker rule's exclusions and lower-only cap on the derivation branch; fails_when=the fence-edit or declaration guard is dropped, or the stored tier no longer caps; why_new=the managed cases above cover declared submit_job pages only; seam=none; no_claim=none beyond protects
describe('#7905 stampPageTrustMarker: which writes stamp, and at what tier', () => {
  const derivation = declareDerivation({ tier: 'agent_written', origin: { channel: 'derive:patterns' } }, []);
  const trust = { tier: 'agent_written' as const, origin: { channel: 'derive:patterns' } };
  const stamp = (row: Record<string, unknown>, stored: TrustTier | null = null) => {
    const fm: Record<string, unknown> = {};
    stampPageTrustMarker(row as never, fm, trust, stored);
    return fm.trust_tier;
  };

  test('a declared maintenance page stamps the declared tier', () => {
    expect(stamp({ operation: 'submit_job', intent: { kind: 'managed_maintenance_page', derivation } })).toBe('agent_written');
  });
  test('a maintenance write with no derivation declaration stamps nothing', () => {
    expect(stamp({ operation: 'submit_job', intent: { kind: 'managed_maintenance_page' } })).toBeUndefined();
  });
  test('a fence edit keeps the page tier even when it carries a derivation declaration', () => {
    expect(stamp({ operation: 'submit_job', intent: { kind: 'managed_facts_entity', derivation } })).toBeUndefined();
    expect(stamp({ operation: 'takes_add', intent: { derivation } })).toBeUndefined();
  });
  test('a declared republication onto a lower stored tier keeps the lower tier', () => {
    expect(stamp({ operation: 'submit_job', intent: { kind: 'managed_maintenance_page', derivation } }, 'external_untrusted')).toBe('external_untrusted');
  });
});
