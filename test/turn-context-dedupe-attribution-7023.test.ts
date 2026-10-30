/**
 * #7023: the per-turn block renders each hot fact with the shared
 * renderFactLine, and the cross-turn dedupe key is that rendered line, so an
 * assistant-attributed or external_untrusted fact injected once this session
 * is not injected on every later prompt, and an assistant claim keeps its
 * `(assistant said)` prefix instead of reading as the user's.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { assembleTurnContext, renderFactLine, type TurnContextFact } from '../src/core/context/turn-context.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';

let engine: BrainEngine;

const ASSISTANT_FACT = 'ASSISTANT-FACT the launch moves to acme-example week';
const EXTERNAL_FACT = 'EXTERNAL-FACT the vendor invoice is due monthly';

async function seedHotFacts() {
  await engine.insertFact(
    { fact: ASSISTANT_FACT, kind: 'fact', entity_slug: 'people/alice-example', source: 'test', visibility: 'world', attributed_to: 'assistant' },
    { source_id: 'default' },
  );
  const ext = await engine.insertFact(
    { fact: EXTERNAL_FACT, kind: 'fact', entity_slug: 'companies/acme-example', source: 'test', visibility: 'world' },
    { source_id: 'default' },
  );
  await engine.executeRaw(`UPDATE facts SET trust_tier = 'external_untrusted' WHERE id = $1`, [ext.id]);
}

const factLines = (text: string) => text.split('\n').filter((l) => l.includes('-FACT '));

for (const backend of testBackends()) {
  describe(backend, () => {
    let pglite: PGLiteEngine | undefined;
    let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
      else { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
    }, 120_000);
    afterAll(async () => { await template?.dispose(); await pglite?.disconnect(); });
    beforeEach(async () => {
      __resetHotMemoryCacheForTests();
      // Targeted deletes, not resetPgliteState: that also empties trust_policy_state, and hot memory reads nothing without its row.
      if (pglite) { engine = pglite; await engine.executeRaw('DELETE FROM facts'); await engine.executeRaw('DELETE FROM pages'); }
      else { const c = await template!.clone(); engine = c.engine; close = c.close; }
    }, 60_000);
    afterEach(async () => { if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; } });

    test('the first block keeps the assistant prefix and wraps the external fact as data', async () => {
      await seedHotFacts();
      const first = await assembleTurnContext(engine, { sourceId: 'default', window: [] });
      expect(first.factsCount).toBe(2);
      const lines = factLines(first.text);
      expect(lines.length).toBe(2);
      expect(lines.find((l) => l.includes(ASSISTANT_FACT))!.startsWith('- (assistant said) ')).toBe(true);
      const external = lines.find((l) => l.includes(EXTERNAL_FACT))!;
      expect(external.startsWith('- <external-data trust="external_untrusted"')).toBe(true);
      expect(external).toContain(`${EXTERNAL_FACT}</external-data> [companies/acme-example] (`);
    });

    test('assistant-attributed and external_untrusted facts injected once are not injected again', async () => {
      await seedHotFacts();
      const first = await assembleTurnContext(engine, { sourceId: 'default', window: [] });
      expect(first.factsCount).toBe(2);
      __resetHotMemoryCacheForTests();
      const next = await assembleTurnContext(engine, {
        sourceId: 'default',
        window: [{ role: 'user', text: 'no entities here, just vibes' }],
        priorContextText: first.text,
      });
      expect(next.factsCount).toBe(0);
      expect(next.text).not.toContain(ASSISTANT_FACT);
      expect(next.text).not.toContain(EXTERNAL_FACT);
    });

    test('a fact injected before labels existed still matches its unlabeled line', async () => {
      await seedHotFacts();
      const unlabeled = (fact: string, slug: string, attributed_to?: TurnContextFact['attributed_to']) =>
        renderFactLine({ id: 0, fact, kind: 'fact', entity_slug: slug, confidence: 0.5, attributed_to });
      const prior = [unlabeled(ASSISTANT_FACT, 'people/alice-example', 'assistant'), unlabeled(EXTERNAL_FACT, 'companies/acme-example')].join('\n');
      const next = await assembleTurnContext(engine, { sourceId: 'default', window: [], priorContextText: prior });
      expect(next.factsCount).toBe(0);
    });
  });
}
