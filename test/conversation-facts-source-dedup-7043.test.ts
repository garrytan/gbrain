/**
 * #7043 (reported by @mikez93): conversation-fact extraction is an explicit
 * lane, so the capture lanes' duplicate policy never ran on it, and a claim an
 * agent's standing prompt repeated on every run's page was stored once per
 * page. A candidate whose fingerprint matches an active fact of the same
 * source is now skipped, under the capture lane's entity and visibility rules
 * (same entity, or another entity the claim names; a world candidate only
 * against world facts) and with no time bound. The page's own rows that a
 * replacement clears never count, so re-extracting a page keeps its facts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { randomUUID } from 'node:crypto';
import { managedBrain } from './helpers/managed-brain.ts';

let engine: BrainEngine;

const PLAN = 'Owner Example sends the quarterly plan on Thursday';
const transcript = (title: string) => [
  '---', `title: ${title}`, 'type: meeting', 'date: 2026-09-28', '---',
  '**Alice Example:** Can you send me the quarterly plan before the review?',
  '**Owner Example:** Yes, I will send it on Thursday with the finance appendix.',
  '**Alice Example:** Good. I review plans on Mondays, so that works.',
  '**Owner Example:** I will flag any launch date changes in the summary.', '',
].join('\n');

async function call(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, { remote: false });
  return JSON.parse(res.content[0]!.text!) as Record<string, any>;
}

async function extract(slug: string, fact: Partial<ExtractedFact> = {}, force = false) {
  await disposePersistenceConsumer(engine);
  return runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [slug], sleepMs: 0, overrideDisabled: true, force,
    extractor: async () => [{ fact: PLAN, kind: 'commitment', confidence: 0.9, entity_slug: null, source: 'test', notability: 'high', ...fact } as ExtractedFact] });
}

async function active(text: string) {
  return engine.executeRaw<{ id: number; source_markdown_slug: string; entity_slug: string | null; visibility: string }>(
    `SELECT id, source_markdown_slug, entity_slug, visibility FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL ORDER BY id`, [text]);
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
      for (const [slug, title] of [['meetings/run-1', 'Run 1'], ['meetings/run-2', 'Run 2']]) await call('put_page', { slug, content: transcript(title) });
      for (const [slug, title] of [['people/alice-example', 'Alice Example'], ['people/bob-example', 'Bob Example']]) {
        await call('put_page', { slug, content: `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\nA person.\n` });
      }
    }, 60_000);
    afterEach(async () => { if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; } });

    test('a claim another page already states is not stored again', async () => {
      expect((await extract('meetings/run-1')).facts_inserted).toBe(1);
      const second = await extract('meetings/run-2');
      expect(second.pages_failed).toBe(0);
      expect(second.facts_inserted).toBe(0);
      expect((await active(PLAN)).map(r => r.source_markdown_slug)).toEqual(['meetings/run-1']);
    });

    test('re-extracting a page keeps its own fact', async () => {
      await extract('meetings/run-1');
      const again = await extract('meetings/run-1', {}, true);
      expect(again.pages_failed).toBe(0);
      expect((await active(PLAN)).map(r => r.source_markdown_slug)).toEqual(['meetings/run-1']);
    });

    test('a subject-relative claim on another entity is still stored', async () => {
      await extract('meetings/run-1', { fact: 'Prefers tea.', entity_slug: 'people/alice-example' });
      await extract('meetings/run-2', { fact: 'Prefers tea.', entity_slug: 'people/bob-example' });
      expect((await active('Prefers tea.')).map(r => r.entity_slug)).toEqual(['people/alice-example', 'people/bob-example']);
    });

    test('a managed batch skips the copy inside its receipted publication', async () => {
      await managedBrain(async (brain) => {
        const outer = engine;
        engine = brain.engine;
        try {
          for (const [slug, title] of [['meetings/run-1', 'Run 1'], ['meetings/run-2', 'Run 2']]) {
            await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: transcript(title) } });
          }
          expect((await extract('meetings/run-1')).facts_inserted).toBe(1);
          const second = await extract('meetings/run-2');
          expect(second.pages_failed).toBe(0);
          expect((await active(PLAN)).map(r => r.source_markdown_slug)).toEqual(['meetings/run-1']);
        } finally {
          await disposePersistenceConsumer(brain.engine);
          engine = outer;
        }
      }, { databaseUrl: backend === 'postgres' ? requirePostgresTestDatabase() : undefined });
    }, 120_000);

    test('a world candidate is not matched against a private fact', async () => {
      await engine.setConfig('facts.default_visibility', 'private');
      await extract('meetings/run-1');
      await engine.setConfig('facts.default_visibility', 'world');
      await extract('meetings/run-2');
      expect((await active(PLAN)).map(r => r.visibility)).toEqual(['private', 'world']);
    });
  });
}
