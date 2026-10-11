/**
 * #5152 / #5504(a) — `writeSingleFact` (the helper behind loops extraction)
 * deduplicates exact repeats the way the managed path and the backstop do, and
 * never mints an unprefixed entity slug.
 *
 * Protects: an exact repeat with no entity, or with an entity but no
 * embedding, returns `duplicate` with the first row's id (one row); a
 * different visibility is a different fact; a counterparty the resolver can
 * only slugify (`fallback_slugify`) is stored with `entity_slug = NULL` and
 * still deduplicates; a caller whose trust is unknown or remote never learns
 * that a private-sourced fact exists (its exact repeat inserts), while the
 * local CLI dedups against it; the public `remember` verb on a classic brain
 * already dedups an entity-less repeat.
 * Fails when: the helper runs cosine-only dedup gated on entity + embedding
 * (two rows), or writes the slugified fallback as the entity.
 * Seams: none. PGLite always, Postgres when DATABASE_URL is set.
 * Dedup is sequential: the exact check runs before, not inside, the insert
 * transaction, so two identical submissions racing each other may both insert.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const CLAIM = 'Will send the signed contract by Friday.';

for (const backend of testBackends()) {
  describe(`${backend}: writeSingleFact exact dedup (#5152) and NULL fallback entity (#5504)`, () => {
    let engine: BrainEngine;

    beforeAll(async () => {
      if (backend === 'postgres') {
        const pg = new PostgresEngine();
        await pg.connect({ database_url: requirePostgresTestDatabase() });
        engine = pg;
      } else {
        const lite = new PGLiteEngine();
        await lite.connect({});
        engine = lite;
      }
      await engine.initSchema();
    }, 180_000);

    afterAll(async () => {
      resetGateway();
      await engine.disconnect();
    });

    beforeEach(async () => {
      await engine.executeRaw(`DELETE FROM facts`);
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'people/%'`);
      await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.write_through'`);
    });

    const rows = () => engine.executeRaw<{ id: number; entity_slug: string | null; visibility: string }>(
      'SELECT id::int AS id, entity_slug, visibility FROM facts ORDER BY id');

    test('an exact repeat with no entity is a duplicate of the first row', async () => {
      const first = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', remote: false });
      const second = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', remote: false });
      expect(first).toMatchObject({ status: 'inserted', entity_slug: null });
      expect(second).toMatchObject({ status: 'duplicate', id: first.id, entity_slug: null });
      expect((await rows()).map(r => r.id)).toEqual([first.id]);
    });

    test('an exact repeat with an entity and no embedding is a duplicate; degraded_dedup only means semantic dedup was skipped', async () => {
      await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice.' }, { sourceId: 'default' });
      const first = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', entity: 'people/alice-example', remote: false });
      const second = await writeSingleFact(engine, 'default', { fact: `  ${CLAIM}  `, provenance: 'fixture', entity: 'people/alice-example', remote: false });
      expect(first).toMatchObject({ status: 'inserted', entity_slug: 'people/alice-example', degraded_dedup: true });
      expect(second).toMatchObject({ status: 'duplicate', id: first.id, degraded_dedup: true });
      expect(await rows()).toHaveLength(1);
    });

    test('a different visibility is a different fact', async () => {
      const a = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', visibility: 'private', remote: false });
      const b = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', visibility: 'world', remote: false });
      expect([a.status, b.status]).toEqual(['inserted', 'inserted']);
      expect((await rows()).map(r => r.visibility)).toEqual(['private', 'world']);
    });

    test('a counterparty the resolver can only slugify is stored with no entity and still dedups (#5504)', async () => {
      const first = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', entity: 'Nobody Known', kind: 'commitment', remote: false });
      expect(first).toMatchObject({ status: 'inserted', entity_slug: null });
      expect(await rows()).toEqual([{ id: first.id, entity_slug: null, visibility: 'private' }]);
      const again = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', entity: 'Nobody Known', kind: 'commitment', remote: false });
      expect(again).toMatchObject({ status: 'duplicate', id: first.id, entity_slug: null });
      expect(await rows()).toHaveLength(1);
    });

    test('a remote or unknown caller never dedups against a private-sourced fact; the local CLI does', async () => {
      await engine.putPage('people/secret-example', { type: 'person', title: 'Secret Example', compiled_truth: 'Private.', frontmatter: { visibility: 'private' } }, { sourceId: 'default' });
      const [seed] = await engine.executeRaw<{ id: number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, source_markdown_slug, row_num)
         VALUES ('default', 'people/secret-example', $1, 'fact', 'fixture', 'private', 'people/secret-example', 1) RETURNING id::int AS id`, [CLAIM]);
      for (const remote of [true, undefined]) {
        const untrusted = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', entity: 'people/secret-example', remote });
        expect(untrusted.status).toBe('inserted');
        expect(untrusted.id).not.toBe(seed.id);
        // The copy an untrusted caller wrote has no private provenance page; remove it so the next caller faces only the seed.
        await engine.executeRaw('DELETE FROM facts WHERE id = $1', [untrusted.id]);
      }
      const local = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', entity: 'people/secret-example', remote: false });
      expect(local).toMatchObject({ status: 'duplicate', id: seed.id });
    });

    test('the public remember verb on a classic brain already dedups an entity-less repeat', async () => {
      const opts = { remote: true, transport: 'stdio' as const, sourceId: 'default' };
      const first = JSON.parse((await dispatchToolCall(engine, 'remember', { fact: CLAIM, provenance: 'fixture' }, opts)).content[0].text);
      const second = JSON.parse((await dispatchToolCall(engine, 'remember', { fact: CLAIM, provenance: 'fixture' }, opts)).content[0].text);
      expect(first.status).toBe('inserted');
      expect(second.status).toBe('duplicate');
      expect(second.id).toBe(first.id);
      expect(await rows()).toHaveLength(1);
    });
  });
}
