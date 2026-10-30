/**
 * #7432: a top-level `entity` on a `remember` items batch is the default
 * subject for every item that names none, like top-level provenance, kind,
 * ttl and visibility; an item's own `entity` wins.
 *
 * Fails when: the batch drops the top-level entity, so the items save with
 * `entity_slug: null` and a `NO_ENTITY` warning.
 * The facts name nobody, so entity inference cannot fill the subject in.
 * Seams: none; the real remember operation on an unmanaged brain, keyless.
 * PGLite always, Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SHARED = 'people/alice-example';
const OWN = 'people/bob-example';

beforeAll(() => { configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} }); });
afterAll(() => { resetGateway(); });

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`remember items with a top-level entity (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (databaseUrl) {
        ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      await engine.putPage(SHARED, { type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example' });
      await engine.putPage(OWN, { type: 'person', title: 'Bob Example', compiled_truth: '# Bob Example' });
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('items without an entity inherit it; an item with its own entity keeps it', async () => {
      const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
      const out = await operationsByName.remember!.handler(ctx, {
        entity: SHARED,
        provenance: 'synthetic session',
        items: [
          { fact: 'Prefers written agendas.' },
          'Ships the synthetic report every Friday.',
          { fact: 'Reviews the synthetic budget.', entity: OWN },
        ],
      }) as { saved: number; failed: number; items: Array<{ status: string; entity_slug?: string | null; warnings?: string[] }> };

      expect(out.failed).toBe(0);
      expect(out.saved).toBe(3);
      expect(out.items.map(item => item.entity_slug)).toEqual([SHARED, SHARED, OWN]);
      expect(out.items.flatMap(item => item.warnings ?? [])).not.toContain('NO_ENTITY');
      const rows = await engine.executeRaw<{ fact: string; entity_slug: string | null }>(
        'SELECT fact, entity_slug FROM facts WHERE expired_at IS NULL ORDER BY id');
      expect(rows.map(row => row.entity_slug)).toEqual([SHARED, SHARED, OWN]);
    }, 120_000);

    for (const remote of [false, true]) {
      test(`content_origin and valid_from reach every item as they reach a single fact (remote=${remote})`, async () => {
        const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'default' } as unknown as OperationContext;
        const fact = (text: string) => engine.executeRaw<{ trust_tier: string; valid_from: string }>(
          'SELECT trust_tier, valid_from::text AS valid_from FROM facts WHERE fact=$1 AND expired_at IS NULL', [text]);
        await operationsByName.remember!.handler(ctx, { fact: `Single synthetic tool claim ${remote}.`, entity: SHARED, provenance: 'synthetic tool',
          content_origin: 'tool_output', valid_from: '2026-03-01' });
        const [single] = await fact(`Single synthetic tool claim ${remote}.`);
        expect(single!.trust_tier).toBe('external_untrusted');
        const out = await operationsByName.remember!.handler(ctx, { entity: SHARED, provenance: 'synthetic tool', content_origin: 'tool_output', valid_from: '2026-03-01',
          items: [`Batched synthetic tool claim ${remote}.`, { fact: `Per-item synthetic tool claim ${remote}.`, content_origin: 'tool_output', valid_from: '2026-03-02', entity: OWN }] }) as { failed: number };
        expect(out.failed).toBe(0);
        const [batched] = await fact(`Batched synthetic tool claim ${remote}.`);
        const [perItem] = await fact(`Per-item synthetic tool claim ${remote}.`);
        expect(batched).toEqual(single);
        expect(perItem!.trust_tier).toBe('external_untrusted');
        expect(perItem!.valid_from.startsWith('2026-03-02')).toBe(true);
      }, 120_000);
    }
  });
}
