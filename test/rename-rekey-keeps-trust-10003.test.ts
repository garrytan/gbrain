/**
 * #10003: re-keys that follow a rename (the sync rename carry and the rename collision) author no text, so the rows
 * they move keep their stored trust tier instead of dropping to unknown.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withTrustKeep, withWriteTrust } from '../src/core/persistence/context.ts';
import type { WriteTrust } from '../src/core/trust/tier.ts';
import { carryRenameIdentity } from '../src/commands/sync/renames.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';

const AGENT: WriteTrust = { tier: 'agent_written', origin: { channel: 'test:agent' } };

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

async function seedPage(slug: string): Promise<void> {
  await engine.transaction(tx => withWriteTrust(tx, AGENT, async () => {
    await tx.putPage(slug, { type: 'person', title: slug, compiled_truth: `${slug} body.`, frontmatter: { type: 'person' } });
  }));
}
async function seedFact(slug: string): Promise<void> {
  await engine.transaction(tx => withWriteTrust(tx, AGENT, async () => {
    await tx.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug)
      VALUES ('default', $1, 'Fact about ' || $1, 'fact', 'world', 'test', $1)`, [slug]);
  }));
}
const factTiers = async () => (await engine.executeRaw<{ entity_slug: string; trust_tier: string }>(
  "SELECT entity_slug, trust_tier FROM facts WHERE source_id='default' AND entity_slug LIKE 'people/%' ORDER BY entity_slug")).map(r => `${r.entity_slug}: ${r.trust_tier}`);

describe('#10003 rename re-keys keep the trust tier', () => {
  test('carryRenameIdentity keeps the moved fact tier', async () => {
    await seedPage('people/a-old'); await seedPage('people/a-new'); await seedFact('people/a-old');
    await carryRenameIdentity(engine, 'default', 'people/a-old', 'people/a-new');
    const tiers = (await factTiers()).filter(t => t.startsWith('people/a-'));
    expect(tiers).toEqual(['people/a-new: agent_written']);
  });

  test('a rename onto a tombstone keeps the tombstone and its fact at their tier', async () => {
    await seedPage('people/b-old'); await seedPage('people/b-new'); await seedFact('people/b-new');
    await engine.transaction(tx => withTrustKeep(tx, ['pages'], () => tx.softDeletePage('people/b-new', { sourceId: 'default' })));
    let outcome: unknown;
    try { outcome = await renamePageOntoSlug(engine, { sourceId: 'default', oldSlug: 'people/b-old', newSlug: 'people/b-new', to: 'people/b-new.md' }); } catch (error) { outcome = String(error); }
    expect(outcome).toBe('renamed');
    const pages = await engine.executeRaw<{ slug: string; trust_tier: string }>(
      "SELECT slug, trust_tier FROM pages WHERE source_id='default' AND slug LIKE 'people/b-new%' ORDER BY slug");
    expect(pages.map(p => `${p.slug.replace(/\d+$/, 'N')}: ${p.trust_tier}`)).toEqual(['people/b-new: agent_written', 'people/b-new~purged-N: agent_written']);
    expect((await factTiers()).filter(t => t.startsWith('people/b-'))).toEqual([expect.stringMatching(/^people\/b-new~purged-\d+: agent_written$/)]);
  });
});
