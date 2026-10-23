/**
 * #7043 (reported by @mikez93): recall and search returned every copy of one
 * claim, so a few copies crowded distinct facts out of the limit. Rows with
 * the same fingerprint in one source and visibility now collapse into one row
 * (hot memory's rule: same entity, or another entity the claim names) that
 * carries every entity slug and how many rows it stands for, before the limit
 * cut. Private and world copies never merge, a remote caller's world-only
 * filter applies first, and subject-relative claims on two entities stay two
 * rows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

let engine: BrainEngine;

async function call(name: string, params: Record<string, unknown>, remote = false) {
  const res = await dispatchToolCall(engine, name, params, { remote, sourceId: 'default' });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any>, meta: res._meta as Record<string, any> | undefined };
}

async function fact(text: string, entity: string, day: string, visibility: 'world' | 'private' = 'world') {
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from, created_at)
    VALUES ('default', $1, $2, 'preference', $3, 'test', $4::timestamptz, $4::timestamptz)`, [entity, text, visibility, `${day}T12:00:00Z`]);
}

const EMAIL = 'Alice Example prefers email.';
const ALICE = 'people/alice-example';
const BOB = 'people/bob-example';

for (const backend of testBackends()) {
  describe(backend, () => {
    let pglite: PGLiteEngine | undefined;
    let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
      else { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
    }, 120_000);
    afterAll(async () => { resetGateway(); __setEmbedTransportForTests(null); await template?.dispose(); await pglite?.disconnect(); });
    beforeEach(async () => {
      if (pglite) { engine = pglite; await disposePersistenceConsumer(engine); await resetPgliteState(pglite); }
      else { const c = await template!.clone(); engine = c.engine; close = c.close; }
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      await call('put_page', { slug: ALICE, content: '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA person.\n' });
      await call('put_page', { slug: BOB, content: '---\ntitle: Bob Example\ntype: person\n---\n# Bob Example\n\nA person.\n' });
      await fact('Alice Example lives in Lisbon.', ALICE, '2026-01-01');
      await fact('Prefers tea.', ALICE, '2026-01-15');
      await fact('Prefers tea.', BOB, '2026-01-16');
      await fact(EMAIL, ALICE, '2026-02-01');
      await fact(EMAIL, ALICE, '2026-02-02');
      await fact(EMAIL, ALICE, '2026-02-03');
      await fact(EMAIL, BOB, '2026-02-04');
      await fact(EMAIL, ALICE, '2026-02-05', 'private');
    }, 60_000);
    afterEach(async () => { if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; } });

    test('recall collapses copies before the limit, so distinct facts are not crowded out', async () => {
      const { body } = await call('recall', { limit: 5 });
      const facts = body.facts as Array<Record<string, any>>;
      expect(facts.map(f => f.fact)).toContain('Alice Example lives in Lisbon.');
      const world = facts.filter(f => f.fact === EMAIL && f.visibility === 'world');
      expect(world).toHaveLength(1);
      expect(world[0]!.collapsed_count).toBe(4);
      expect([...world[0]!.entity_slugs].sort()).toEqual([ALICE, BOB]);
      expect(facts.filter(f => f.fact === EMAIL && f.visibility === 'private')).toHaveLength(1);
      // A subject-relative claim on two entities names neither, so it stays two rows.
      expect(facts.filter(f => f.fact === 'Prefers tea.').map(f => f.entity_slug).sort()).toEqual([ALICE, BOB]);
      expect(facts.filter(f => f.fact === 'Prefers tea.').every(f => f.collapsed_count === undefined)).toBe(true);
      expect(body.total).toBe(5);
      expect(facts.every(f => !('collapsed_ids' in f))).toBe(true);
    });

    test('a remote caller sees only world rows, collapsed among themselves', async () => {
      const { body } = await call('recall', { limit: 5 }, true);
      const facts = body.facts as Array<Record<string, any>>;
      expect(facts.every(f => f.visibility === 'world')).toBe(true);
      const email = facts.filter(f => f.fact === EMAIL);
      expect(email).toHaveLength(1);
      expect(email[0]!.collapsed_count).toBe(4);
    });

    test('recall with a question ranks one row per claim', async () => {
      const { body } = await call('recall', { question: 'Does Alice Example prefer email?', limit: 10 });
      const facts = body.facts as Array<Record<string, any>>;
      const world = facts.filter(f => f.fact === EMAIL && f.visibility === 'world');
      expect(world).toHaveLength(1);
      expect(world[0]!.collapsed_count).toBe(4);
    });

    test('recall by entity collapses the entity\'s copies', async () => {
      const { body } = await call('recall', { entity: ALICE, limit: 3 });
      const facts = body.facts as Array<Record<string, any>>;
      expect(facts.filter(f => f.fact === EMAIL && f.visibility === 'world')).toHaveLength(1);
      expect(facts.map(f => f.fact)).toContain('Prefers tea.');
    });

    test('search saved_facts carry one row per claim and visibility', async () => {
      const res = await call('search', { query: 'Alice Example prefers email' });
      const saved = (res.meta?.retrieval?.saved_facts ?? []) as Array<Record<string, any>>;
      const email = saved.filter(f => f.fact === EMAIL);
      expect(email).toHaveLength(2);
      expect(email.some(f => f.collapsed_count === 4)).toBe(true);
      expect(saved.every(f => !('fact_fingerprint' in f) && !('visibility' in f) && !('collapsed_ids' in f))).toBe(true);
    });
  });
}
