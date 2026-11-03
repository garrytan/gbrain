/**
 * #7778: a page purge tombstoned every fact row of the page, the extraction
 * outcome row included. That row's text (EXTRACTION_COMPLETE) is the same on
 * every conversation page and it has no entity, so the tombstone had subject
 * '*'. Since #7438 the conversation lane leaves out any row matching a
 * tombstone, so afterwards no page of the source could record its outcome:
 * each run re-extracted (and re-paid for) the same pages and the backlog never
 * reached zero. Now the page purge writes no tombstone for an outcome row, and
 * neither the #7438 skip nor the facts insert guard applies to one, so a brain
 * already holding such a tombstone converges on its next run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
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
import { managedBrain } from './helpers/managed-brain.ts';
import { TERMINAL_AUDIT_SOURCE, outcomeMarkerSql } from '../src/core/facts/audit-sources.ts';
import { GUARD_OUTCOME_MARKER_SQL } from '../src/core/facts/insert-guard-schema.ts';

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

/** One run; `calls` counts provider calls (the extractor and the embedding transport). */
async function extract(slugs: string[] | undefined, facts: string[], calls: { n: number }) {
  await disposePersistenceConsumer(engine);
  return runExtractConversationFactsCore(engine, { sourceId: 'default', ...(slugs ? { slugs } : {}), sleepMs: 0, overrideDisabled: true, workers: 1,
    extractor: async () => { calls.n++; return facts.map(fact); } });
}

async function tombstone(text: string, subject = '*') {
  const [{ visibility }] = await engine.executeRaw<{ visibility: string }>(
    `SELECT COALESCE((SELECT value FROM config WHERE key='facts.default_visibility'), 'private') AS visibility`);
  await engine.executeRaw(`INSERT INTO fact_purges(source_id, visibility, subject, fact_hash) VALUES ('default', $1, $2, gbrain_fact_fingerprint($3))`,
    [visibility, subject, text]);
}

async function completed(slugs: string[]) {
  return (await engine.executeRaw<{ slug: string }>(`SELECT DISTINCT source_markdown_slug AS slug FROM facts
    WHERE source_id='default' AND source=$1 AND expired_at IS NULL AND source_markdown_slug = ANY($2::text[]) ORDER BY 1`, [TERMINAL_AUDIT_SOURCE, slugs])).map(r => r.slug);
}

async function markerTombstones() {
  const [row] = await engine.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n FROM fact_purges
    WHERE source_id='default' AND fact_hash IN (gbrain_fact_fingerprint('EXTRACTION_COMPLETE'), gbrain_fact_fingerprint('EXTRACTION_NOT_APPLICABLE'))`);
  return Number(row?.n ?? 0);
}

/** Seeds the pre-#7778 wildcard marker tombstone, then runs twice: the first run completes both pages, the second makes no provider call. */
async function convergesDespiteMarkerTombstone(put: (slug: string, title: string) => Promise<void>) {
  const slugs = ['meetings/run-1', 'meetings/run-2'];
  for (const [i, slug] of slugs.entries()) await put(slug, `Run ${i + 1}`);
  await tombstone('EXTRACTION_COMPLETE');
  const first = { n: 0 };
  const run1 = await extract(slugs, [KEPT], first);
  expect(run1.pages_failed).toBe(0);
  expect(run1.facts_skipped_purged ?? 0).toBe(0);
  expect(run1.pages_processed).toBe(2);
  expect(first.n).toBeGreaterThan(0);
  expect(await completed(slugs)).toEqual(slugs);
  const second = { n: 0 };
  const run2 = await extract(undefined, [KEPT], second);
  expect(run2.pages_processed).toBe(0);
  expect(run2.pages_failed).toBe(0);
  expect(second.n).toBe(0);
  expect(await markerTombstones()).toBe(1);
}

test('the insert guard spells out the same outcome-marker predicate as audit-sources.ts', () => {
  expect(GUARD_OUTCOME_MARKER_SQL).toBe(outcomeMarkerSql('i'));
});

for (const backend of testBackends()) {
  describe(backend, () => {
    let pglite: PGLiteEngine | undefined;
    let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
    let close: (() => Promise<void>) | undefined;
    let embedCalls = 0;
    beforeAll(async () => {
      if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
      else { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
    }, 120_000);
    afterAll(async () => { resetGateway(); __setEmbedTransportForTests(null); await template?.dispose(); await pglite?.disconnect(); });
    beforeEach(async () => {
      if (pglite) { engine = pglite; await disposePersistenceConsumer(engine); await resetPgliteState(pglite); }
      else { const c = await template!.clone(); engine = c.engine; close = c.close; }
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      embedCalls = 0;
      __setEmbedTransportForTests(async () => { embedCalls++; throw new Error('no provider call is expected'); });
    }, 60_000);
    afterEach(async () => {
      expect(embedCalls).toBe(0);
      if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; }
    });

    test('repo-less brain: a wildcard EXTRACTION_COMPLETE tombstone no longer keeps pages from completing', async () => {
      await convergesDespiteMarkerTombstone(async (slug, title) => { await call('put_page', { slug, content: transcript(title) }); });
    });

    test('managed brain: the batch publishes each outcome row despite the tombstone', async () => {
      await managedBrain(async (brain) => {
        const outer = engine;
        engine = brain.engine;
        try {
          await convergesDespiteMarkerTombstone(async (slug, content) => {
            await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: transcript(content) } });
          });
        } finally {
          await disposePersistenceConsumer(brain.engine);
          engine = outer;
        }
      }, { databaseUrl: backend === 'postgres' ? requirePostgresTestDatabase() : undefined });
    }, 120_000);

    test('a page purge tombstones the page\'s claims but not its outcome row; other pages still complete', async () => {
      await call('put_page', { slug: 'meetings/purged', content: transcript('Purged') });
      await extract(['meetings/purged'], [PURGED], { n: 0 });
      expect(await completed(['meetings/purged'])).toEqual(['meetings/purged']);
      const snapshot = await engine.readPageSnapshot('meetings/purged', { sourceId: 'default', includeDeleted: true });
      const purge = await call('delete_page', { slug: 'meetings/purged', purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision });
      expect(purge.status).toBe('purged');
      const [claim] = await engine.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n FROM fact_purges WHERE source_id='default' AND fact_hash=gbrain_fact_fingerprint($1)`, [PURGED]);
      expect(Number(claim?.n)).toBe(1);
      expect(await markerTombstones()).toBe(0);
      await call('put_page', { slug: 'meetings/next', content: transcript('Next') });
      const run1 = await extract(['meetings/next'], [KEPT, PURGED], { n: 0 });
      expect(run1.facts_skipped_purged).toBe(1);
      expect(await completed(['meetings/next'])).toEqual(['meetings/next']);
      const second = { n: 0 };
      expect((await extract(undefined, [KEPT], second)).pages_processed).toBe(0);
      expect(second.n).toBe(0);
    });

    test('a user claim with the marker text keeps the #7438 skip; forget and purge leave outcome rows alone', async () => {
      await tombstone('EXTRACTION_COMPLETE');
      await call('put_page', { slug: 'meetings/run-1', content: transcript('Run 1') });
      const run = await extract(['meetings/run-1'], [KEPT, 'EXTRACTION_COMPLETE'], { n: 0 });
      expect(run.facts_skipped_purged).toBe(1);
      expect(run.facts_inserted).toBe(1);
      const [marker] = await engine.executeRaw<{ id: number | string }>(`SELECT id FROM facts WHERE source_id='default' AND source=$1 AND expired_at IS NULL`, [TERMINAL_AUDIT_SOURCE]);
      expect(marker).toBeDefined();
      const forgot = await call('forget_fact', { id: Number(marker!.id), request_id: randomUUID() });
      expect(forgot.withdrawn ?? false).toBe(false);
      const purged = await dispatchToolCall(engine, 'purge_fact', { id: Number(marker!.id), dry_run: true }, { remote: false });
      expect(purged.isError).toBe(true);
      expect(purged.content[0]!.text).toContain('fact_not_found');
      const [withdrawals] = await engine.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n FROM fact_withdrawals WHERE source_id='default'`);
      expect(Number(withdrawals?.n)).toBe(0);
      expect(await completed(['meetings/run-1'])).toEqual(['meetings/run-1']);
    });

    test('the facts insert guard exempts only the exact outcome row: another claim under the audit source is still refused', async () => {
      await call('put_page', { slug: 'meetings/run-1', content: transcript('Run 1') });
      await extract(['meetings/run-1'], [KEPT], { n: 0 });
      await tombstone(PURGED);
      await tombstone('EXTRACTION_COMPLETE');
      const insert = (text: string) => engine.executeRaw(`INSERT INTO facts(source_id, source_markdown_slug, row_num, fact, kind, visibility, source, confidence, notability)
        SELECT source_id, source_markdown_slug, 1000 + row_num, $1, kind, visibility, source, confidence, notability FROM facts
        WHERE source_id='default' AND source=$2 AND expired_at IS NULL LIMIT 1`, [text, TERMINAL_AUDIT_SOURCE]);
      await expect(insert(PURGED)).rejects.toThrow(/purged_content/);
      await insert('EXTRACTION_COMPLETE');
    });
  });
}
