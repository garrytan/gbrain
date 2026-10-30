/**
 * #7438: the conversation-facts lane never checked the purge ledger, so one
 * extracted claim matching a fact_purges tombstone made the facts insert
 * guard (gbrain_guard_inserted_facts) refuse the whole insert statement after
 * the model call was paid for: the page's other facts were lost, and on a
 * managed brain every page of the same batch request failed with it. A purged
 * claim is now dropped before the insert and counted; the rest publishes.
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

const KEPT = 'Owner Example sends the quarterly plan on Thursday';
const PURGED = 'Alice Example reviews plans on Mondays';
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

const fact = (text: string): ExtractedFact => ({ fact: text, kind: 'fact', confidence: 0.9, entity_slug: null, source: 'test', notability: 'high' } as ExtractedFact);

async function extract(slugs: string[], facts: Record<string, string[]>) {
  await disposePersistenceConsumer(engine);
  let i = 0;
  return runExtractConversationFactsCore(engine, { sourceId: 'default', slugs, sleepMs: 0, overrideDisabled: true, workers: 1,
    extractor: async () => (facts[slugs[Math.min(i++, slugs.length - 1)]!] ?? []).map(fact) });
}

async function purge(text: string, subject = '*') {
  const [{ visibility }] = await engine.executeRaw<{ visibility: string }>(
    `SELECT COALESCE((SELECT value FROM config WHERE key='facts.default_visibility'), 'private') AS visibility`);
  await engine.executeRaw(`INSERT INTO fact_purges(source_id, visibility, subject, fact_hash) VALUES ('default', $1, $2, gbrain_fact_fingerprint($3))`,
    [visibility, subject, text]);
}

async function active(slug: string) {
  return (await engine.executeRaw<{ fact: string }>(
    `SELECT fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1 AND expired_at IS NULL
       AND source LIKE 'cli:extract-conversation-facts%' AND fact NOT LIKE 'EXTRACTION_%' ORDER BY id`, [slug])).map(r => r.fact);
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
    }, 60_000);
    afterEach(async () => { if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; } });

    test('a purged claim is dropped and the page publishes its other facts', async () => {
      await call('put_page', { slug: 'meetings/run-1', content: transcript('Run 1') });
      await purge(PURGED);
      const result = await extract(['meetings/run-1'], { 'meetings/run-1': [KEPT, PURGED] });
      expect(result.pages_failed).toBe(0);
      expect(result.facts_inserted).toBe(1);
      expect(result.facts_skipped_purged).toBe(1);
      expect(await active('meetings/run-1')).toEqual([KEPT]);
    });

    test('a purge on another subject does not drop the claim', async () => {
      await call('put_page', { slug: 'meetings/run-1', content: transcript('Run 1') });
      await purge(PURGED, 'people/bob-example');
      const result = await extract(['meetings/run-1'], { 'meetings/run-1': [KEPT, PURGED] });
      expect(result.facts_inserted).toBe(2);
      expect(result.facts_skipped_purged ?? 0).toBe(0);
      expect(await active('meetings/run-1')).toEqual([KEPT, PURGED]);
    });

    test('a managed batch publishes every page, the purged claim dropped', async () => {
      await managedBrain(async (brain) => {
        const outer = engine;
        engine = brain.engine;
        try {
          for (const [slug, title] of [['meetings/run-1', 'Run 1'], ['meetings/run-2', 'Run 2']]) {
            await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: transcript(title) } });
          }
          await purge(PURGED);
          const result = await extract(['meetings/run-1', 'meetings/run-2'], { 'meetings/run-1': [PURGED, KEPT], 'meetings/run-2': ['Bob Example owns the launch checklist'] });
          expect(result.pages_failed).toBe(0);
          expect(result.pages_processed).toBe(2);
          expect(result.facts_skipped_purged).toBe(1);
          expect(await active('meetings/run-1')).toEqual([KEPT]);
          expect(await active('meetings/run-2')).toEqual(['Bob Example owns the launch checklist']);
        } finally {
          await disposePersistenceConsumer(brain.engine);
          engine = outer;
        }
      }, { databaseUrl: backend === 'postgres' ? requirePostgresTestDatabase() : undefined });
    }, 120_000);
  });
}
