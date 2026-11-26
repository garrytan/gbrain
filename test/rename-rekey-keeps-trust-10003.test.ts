/**
 * #10003: slug re-keys that follow a rename author no text, so the rows they move keep their stored trust tier. The
 * tier trigger counts pages.slug and facts.entity_slug / source_markdown_slug as content, and these paths run with no
 * declared tier, so every row they moved used to drop to `unknown`: the sync rename carry, a rename onto a tombstone
 * (the tombstone and the facts keyed to it) and `gbrain repair facts-rehome`. moveSlugBindings keeps the tier itself,
 * so every caller is covered.
 *
 * PGLite, and Postgres when DATABASE_URL is set. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withTrustKeep, withWriteTrust } from '../src/core/persistence/context.ts';
import { maintenanceTransaction } from '../src/core/persistence/attribution.ts';
import { moveSlugBindings } from '../src/core/page-state/rename-alias.ts';
import { carryRenameIdentity } from '../src/commands/sync/renames.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { factsRehomeRepair } from '../src/core/repair/facts-rehome.ts';
import type { RepairItem } from '../src/core/repair/core.ts';
import type { WriteTrust } from '../src/core/trust/tier.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const AGENT: WriteTrust = { tier: 'agent_written', origin: { channel: 'test:agent' } };

for (const kind of testBackends()) {
  describe(`#10003 rename re-keys keep the trust tier (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close(); });

    const page = (slug: string) => engine.transaction(tx => withWriteTrust(tx, AGENT, () =>
      tx.putPage(slug, { type: 'person', title: slug, compiled_truth: `${slug} body.`, frontmatter: { type: 'person' } })));
    const fact = async (slug: string, rowNum: number | null = null) => Number((await engine.transaction(tx => withWriteTrust(tx, AGENT, () =>
      tx.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, row_num)
        VALUES ('default', $1, 'A fact about ' || $1, 'fact', 'world', 'test', CASE WHEN $2::int IS NULL THEN NULL ELSE $1 END, $2::int) RETURNING id`, [slug, rowNum]))))[0]!.id);
    const factRow = async (id: number) => (await engine.executeRaw<{ entity_slug: string; trust_tier: string }>(
      'SELECT entity_slug, trust_tier FROM facts WHERE id = $1', [id]))[0];

    test('moveSlugBindings keeps the tier of every fact it re-keys, whatever tier the caller declared', async () => {
      const id = await fact('people/dana-old', 1);
      await maintenanceTransaction(engine, tx => moveSlugBindings(tx, 'default', 'people/dana-old', 'people/dana-new'));
      expect(await factRow(id)).toEqual({ entity_slug: 'people/dana-new', trust_tier: 'agent_written' });
    });

    test('the sync rename carry keeps the moved fact tier', async () => {
      await page('people/a-old'); await page('people/a-new');
      const id = await fact('people/a-old', 1);
      await carryRenameIdentity(engine, 'default', 'people/a-old', 'people/a-new');
      expect(await factRow(id)).toEqual({ entity_slug: 'people/a-new', trust_tier: 'agent_written' });
    });

    test('a rename onto a tombstone keeps the tombstone and its fact at their tier', async () => {
      await page('people/b-old'); await page('people/b-new');
      const id = await fact('people/b-new', 1);
      await engine.transaction(tx => withTrustKeep(tx, ['pages'], () => tx.softDeletePage('people/b-new', { sourceId: 'default' })));
      expect(await renamePageOntoSlug(engine, { sourceId: 'default', oldSlug: 'people/b-old', newSlug: 'people/b-new', to: 'people/b-new.md' })).toBe('renamed');
      const pages = await engine.executeRaw<{ slug: string; trust_tier: string }>(
        "SELECT slug, trust_tier FROM pages WHERE source_id = 'default' AND slug LIKE 'people/b-new%' ORDER BY slug");
      expect(pages.map(p => `${p.slug.replace(/\d+$/, 'N')}: ${p.trust_tier}`)).toEqual(['people/b-new: agent_written', 'people/b-new~purged-N: agent_written']);
      expect(await factRow(id)).toEqual({ entity_slug: expect.stringMatching(/^people\/b-new~purged-\d+$/), trust_tier: 'agent_written' });
    });

    test('facts-rehome keeps the tier of the facts it moves onto the target page', async () => {
      await page('people/carol-example');
      const id = await fact('people/carol');
      const ctx = { engine, sourceId: 'default', remote: false, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const entity = { source_id: 'default', slug: 'people/carol', ids: [id], fenced: 0, class: 'rehome' as const, target: 'people/carol-example' };
      const item = { cursor: { phase: 1, id: 0 }, source_id: 'default', slug: 'people/carol', chars: 0, action: 'rehome',
        change: { from: 'people/carol', to: 'people/carol-example' }, entity, hash: 'test', last: false } as unknown as RepairItem;
      expect(await factsRehomeRepair.apply(ctx, item)).toMatchObject({ applied: true, outcome: 'rehomed' });
      expect(await factRow(id)).toEqual({ entity_slug: 'people/carol-example', trust_tier: 'agent_written' });
    });
  });
}
