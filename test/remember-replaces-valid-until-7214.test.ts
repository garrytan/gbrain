/**
 * #7214: a replacement closes the retired fact's validity interval. When the
 * replacement starts after the retired fact, the retired row's valid_until is
 * the replacement's valid_from, in the facts table and in the struck fence row,
 * and a re-extraction of the page keeps it. A backdated replacement (starting
 * on or before the retired fact) leaves the interval as it was.
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
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: BrainEngine;

async function call(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, { remote: false });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}
async function remember(fact: string, extra: Record<string, unknown> = {}) {
  return call('remember', { fact, provenance: 'test', entity: 'people/alice-example', ...extra });
}
async function validUntil(id: string): Promise<string | null> {
  const [r] = await engine.executeRaw<{ valid_until: Date | string | null }>('SELECT valid_until FROM facts WHERE id = $1', [Number(id)]);
  return r!.valid_until === null ? null : new Date(r!.valid_until).toISOString().slice(0, 10);
}
async function fenceRows() {
  const page = await call('get_page', { slug: 'people/alice-example', include_content: true });
  return parseFactsFence(String(page.body.content ?? page.body.compiled_truth)).facts;
}

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
      await call('put_page', { slug: 'people/alice-example', content: '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA person.\n' });
    }, 60_000);
    afterEach(async () => { if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; } });

    describe('#7214 remember replaces closes the retired interval', () => {
      test('a later replacement sets valid_until to its valid_from in the row and the fence', async () => {
        const old = await remember('The test charge is 100 units.', { valid_from: '2026-01-01' });
        const res = await remember('The test charge is 200 units.', { valid_from: '2026-03-01', replaces: old.body.id });
        expect(res.body.status).toBe('superseded');
        expect(await validUntil(old.body.id)).toBe('2026-03-01');
        const struck = (await fenceRows()).find(f => f.claim === 'The test charge is 100 units.');
        expect(struck?.active).toBe(false);
        expect(struck?.validUntil).toBe('2026-03-01');
        expect(await validUntil(res.body.id)).toBeNull();
      });

      test('a backdated replacement leaves the retired interval open', async () => {
        const old = await remember('The test charge is 100 units.', { valid_from: '2026-03-01' });
        const res = await remember('The test charge is 200 units.', { valid_from: '2026-01-01', replaces: old.body.id });
        expect(res.body.status).toBe('superseded');
        expect(await validUntil(old.body.id)).toBeNull();
      });
    });

    describe('#7214 insertFact supersede closes the retired interval', () => {
      test('later replacement closes at its valid_from; backdated leaves it open', async () => {
        const a = await engine.insertFact({ fact: 'The test charge is 100 units.', entity_slug: 'people/alice-example', source: 'test', valid_from: new Date('2026-01-01') }, { source_id: 'default' }); // gbrain-allow-direct-insert: #7214 probe of the engine supersede path
        const b = await engine.insertFact({ fact: 'The test charge is 200 units.', entity_slug: 'people/alice-example', source: 'test', valid_from: new Date('2026-03-01') }, { source_id: 'default', supersedeId: a.id }); // gbrain-allow-direct-insert: #7214 probe of the engine supersede path
        expect(b.status).toBe('superseded');
        expect(await validUntil(String(a.id))).toBe('2026-03-01');
        const c = await engine.insertFact({ fact: 'The test charge is 50 units.', entity_slug: 'people/alice-example', source: 'test', valid_from: new Date('2025-06-01') }, { source_id: 'default', supersedeId: b.id }); // gbrain-allow-direct-insert: #7214 probe of the engine supersede path
        expect(c.status).toBe('superseded');
        expect(await validUntil(String(b.id))).toBeNull();
      });
    });
  });
}
