/**
 * #9735: a slug move only re-keys a page and the facts that name it; it authors no text, so the page and every fact
 * it re-keys keep the trust tier they had. The tier trigger counts pages.slug and facts.entity_slug as content
 * columns, so a move used to stamp the mover's tier: an owner-tier mover raised an agent-written page and its facts
 * to operator_curated, and a mover with no declared tier lowered them to unknown.
 *
 * The tier is kept inside the engine's slug move, so every caller is covered. The census below pins every call site
 * of updateSlug and the one place a live page's slug is moved by key, so a new caller or a hand-written move shows up
 * here and its author checks it goes through the engine.
 *
 * PGLite, and Postgres when DATABASE_URL is set. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withWriteTrust } from '../src/core/persistence/context.ts';
import type { WriteTrust } from '../src/core/trust/tier.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const AGENT: WriteTrust = { tier: 'agent_written', origin: { channel: 'test:agent' } };
const OWNER: WriteTrust = { tier: 'operator_curated', origin: { channel: 'test:owner' } };

async function seed(engine: BrainEngine, slug: string): Promise<void> {
  await engine.transaction(tx => withWriteTrust(tx, AGENT, async () => {
    await tx.putPage(slug, { type: 'person', title: 'Alice Example', compiled_truth: 'Alice is a founder.', frontmatter: { type: 'person' } });
    await tx.putPage(`${slug}-notes`, { type: 'note', title: 'Notes', compiled_truth: 'Meeting notes.', frontmatter: { type: 'note' } });
    await tx.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug)
      VALUES ('default', $1, 'Alice founded acme-example', 'fact', 'world', 'test', $1),
             ('default', $1, 'Alice met bob-example', 'fact', 'world', 'test', $2)`, [slug, `${slug}-notes`]);
  }));
}

async function tiers(engine: BrainEngine, slug: string): Promise<string[]> {
  const page = await engine.executeRaw<{ trust_tier: string }>("SELECT trust_tier FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  const facts = await engine.executeRaw<{ trust_tier: string }>("SELECT trust_tier FROM facts WHERE source_id='default' AND entity_slug=$1 ORDER BY id", [slug]);
  expect(page).toHaveLength(1);
  expect(facts).toHaveLength(2);
  return [page[0]!.trust_tier, ...facts.map(f => f.trust_tier)];
}

const UPDATE_SLUG_CALLERS = [
  'src/commands/sync/holds.ts',
  'src/commands/sync/rename-collision.ts',
  'src/core/import-file.ts',
  'src/core/persistence/file-repair.ts',
  'src/core/persistence/sync-prepare.ts',
  'src/core/persistence/sync-streamed.ts',
  'src/core/repair/frontmatter.ts',
  'src/core/repair/rename-identity.ts',
  'src/core/repair/slug-spelling.ts',
  'src/core/schema-migrations/v002-slugify-existing-pages.ts',
];

describe('#9735 slug move census', () => {
  // test-reads-source-ok[trust-boundary]: the census pins every slug-move call site so a new one is checked against the tier rule.
  const source = (file: string) => readFileSync(file, 'utf8');
  const files = [...new Bun.Glob('src/**/*.ts').scanSync('.')].filter(file => !file.includes('.generated.')).sort();

  test('every updateSlug caller is listed, and both engines move through the one implementation that keeps the tier', () => {
    // The Rust engine's updateSlug member calls the store's own move, which keeps the tier the same way
    // (test/engine-parity/trust-tier-reads.test.ts pins it on the Rust arm).
    const engines = ['src/core/pglite-engine.ts', 'src/core/postgres-engine.ts', 'src/core/engine-sql/pages.ts', 'src/core/rust-engine/store-members/aliases.ts'];
    const callers = files.filter(file => !engines.includes(file) && /\.updateSlug\(/.test(source(file)));
    expect(callers).toEqual(UPDATE_SLUG_CALLERS);
    for (const engine of ['src/core/pglite-engine.ts', 'src/core/postgres-engine.ts']) {
      expect(source(engine)).toMatch(/async updateSlug\([^)]*\)[^{]*\{[^}]*pagesImpl\.updateSlug\(/);
    }
    expect(source('src/core/engine-sql/pages.ts')).toMatch(/export function updateSlug\([^)]*\)[^{]*\{\s*return withTrustKeep\(tx, \['pages', 'facts'\]/);
  });

  test('only the engine moves a live page to a new slug by its old slug', () => {
    const movers = files.filter(file => /UPDATE pages SET slug\s*=\s*\$1[^`'"]*WHERE slug\s*=/.test(source(file)));
    expect(movers).toEqual(['src/core/engine-sql/pages.ts']);
  });
});

for (const kind of testBackends()) {
  describe(`#9735 a slug move keeps the trust tier of the page and its facts (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({ engine: 'pglite' } as never); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
    });
    afterAll(async () => { await close(); });

    test('an owner-tier mover does not raise an agent-written page or its facts', async () => {
      await seed(engine, 'people/alice-example');
      expect(await tiers(engine, 'people/alice-example')).toEqual(['agent_written', 'agent_written', 'agent_written']);
      const moved = await engine.transaction(tx => withWriteTrust(tx, OWNER, () => tx.updateSlug('people/alice-example', 'people/alice-example-2', { sourceId: 'default' })));
      expect(moved).toBe(1);
      expect(await tiers(engine, 'people/alice-example-2')).toEqual(['agent_written', 'agent_written', 'agent_written']);
    });

    test('a mover with no declared tier does not lower an agent-written page or its facts', async () => {
      await seed(engine, 'people/carol-example');
      const moved = await engine.updateSlug('people/carol-example', 'people/carol-example-2', { sourceId: 'default' });
      expect(moved).toBe(1);
      expect(await tiers(engine, 'people/carol-example-2')).toEqual(['agent_written', 'agent_written', 'agent_written']);
    });
  });
}
