import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine, NewFact } from '../src/core/engine.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { submitManagedConversationFacts } from '../src/core/persistence/conversation-facts.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { conversationSnapshotVersionToken } from '../src/core/conversation-parser/snapshot.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-conversation-facts-'));
let engine: BrainEngine;

beforeAll(async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: 'host' }, async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.putPage('conversations/managed-example', { type: 'conversation', title: 'Managed example',
    compiled_truth: '**Alice Example** (2026-01-01 9:00 AM): We shipped a durable archive.\n**Bob Demo** (2026-01-01 9:05 AM): The archive stays available.', timeline: '', frontmatter: {} });
  await engine.putPage('conversations/stale-managed-example', { type: 'conversation', title: 'Stale example',
    compiled_truth: '**Alice Example** (2026-01-01 9:00 AM): We shipped a durable archive.\n**Bob Demo** (2026-01-01 9:05 AM): The archive stays available.', timeline: '', frontmatter: {} });
  await engine.putPage('conversations/retried-managed-example', { type: 'conversation', title: 'Retried example',
    compiled_truth: 'A transcript snapshot for retry.', timeline: '', frontmatter: {} });
  writeFileSync(join(home, 'managed-transcript.txt'), 'Alice Example: original transcript.');
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [home]);
  await engine.putPage('conversations/sidecar-managed-example', { type: 'conversation', title: 'Sidecar example',
    compiled_truth: 'summary', timeline: '', frontmatter: { raw_transcript: 'managed-transcript.txt' } });
  writeFileSync(join(home, 'managed-transcript.txt'), '**Alice Example** (2026-01-01 9:00 AM): We shipped a durable archive.\n**Bob Demo** (2026-01-01 9:05 AM): The archive stays available.');
  await engine.insertFacts([{ fact: 'prior fact', kind: 'fact', entity_slug: null, source: 'cli:extract-conversation-facts',
    source_session: 'cli:extract-conversation-facts:conversations/sidecar-managed-example', confidence: 1,
    row_num: 0, source_markdown_slug: 'conversations/sidecar-managed-example' }], { source_id: 'default' });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}), 120_000);

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await (engine as any)?.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

test('managed extraction journals one page batch with its terminal row and skips unchanged content on replay', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  await engine.executeRaw("DELETE FROM facts WHERE source_markdown_slug='conversations/managed-example'");
  const run = () => runExtractConversationFactsCore(engine, {
    sourceId: 'default', slug: 'conversations/managed-example', sleepMs: 0, managedJournalWrites: true,
    extractor: async () => [{ fact: 'A durable archive shipped', kind: 'fact', entity_slug: null, source: 'test', confidence: 1 }],
  });
  const first = await run();
  expect(first).toMatchObject({ pages_processed: 1, facts_inserted: 1, pages_failed: 0 });
  const facts = await engine.executeRaw<{ source: string; row_num: number }>("SELECT source,row_num FROM facts WHERE source_markdown_slug='conversations/managed-example' ORDER BY row_num");
  expect(facts).toEqual([
    { source: 'cli:extract-conversation-facts', row_num: 0 },
    { source: 'cli:extract-conversation-facts:terminal:v2', row_num: 1 },
  ]);
  expect(await engine.executeRaw("SELECT state,intent->>'kind' AS kind FROM persistence_requests WHERE operation='extract_facts' AND slug='conversations/managed-example'")).toEqual([{ state: 'committed', kind: 'managed_conversation_facts_page' }]);
  const [request] = await engine.executeRaw<any>("SELECT * FROM persistence_requests WHERE operation='extract_facts' AND slug='conversations/managed-example'");
  const intent = request.intent;
  await submitManagedConversationFacts(engine, { sourceId: 'default', slug: 'conversations/managed-example', pageId: request.page_id,
    expectedRevision: intent.expectedRevision, contentToken: intent.contentToken, facts: intent.facts,
    outcome: intent.outcome, outcomeSession: intent.outcomeSession, terminal: intent.terminal, auditContext: intent.auditContext });
  expect(await engine.executeRaw("SELECT id FROM facts WHERE source_markdown_slug='conversations/managed-example'")).toHaveLength(2);
  expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE operation='extract_facts' AND slug='conversations/managed-example'")).toHaveLength(1);
  const second = await run();
  expect(second.pages_skipped_completed).toBe(1);
  expect(await engine.executeRaw("SELECT id FROM facts WHERE source_markdown_slug='conversations/managed-example'")).toHaveLength(2);
  await disposePersistenceConsumer(engine);
}));

test('managed extraction replay ignores run metadata and publishes one snapshot batch', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'conversations/retried-managed-example';
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  if (!snapshot) throw new Error('retry fixture page missing');
  const facts: NewFact[] = [{ fact: 'A durable archive shipped', kind: 'fact', entity_slug: null, source: 'cli:extract-conversation-facts', confidence: 1 }];
  const request = { sourceId: 'default', slug, pageId: snapshot.page.id, expectedRevision: snapshot.revision,
    contentToken: conversationSnapshotVersionToken(snapshot.page, snapshot.page.compiled_truth ?? ''), facts,
    outcome: 'complete' as const, terminal: true };

  await submitManagedConversationFacts(engine, { ...request, outcomeSession: 'run:first', auditContext: 'audit:first' });
  await submitManagedConversationFacts(engine, { ...request, outcomeSession: 'run:retry', auditContext: 'audit:retry' });

  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE operation=$1 AND slug=$2', ['extract_facts', slug])).toHaveLength(1);
  expect(await engine.executeRaw('SELECT source,row_num FROM facts WHERE source_markdown_slug=$1 ORDER BY row_num', [slug])).toEqual([
    { source: 'cli:extract-conversation-facts', row_num: 0 },
    { source: 'cli:extract-conversation-facts:terminal:v2', row_num: 1 },
  ]);
  expect(await engine.executeRaw("SELECT id FROM facts WHERE source_markdown_slug=$1 AND source='cli:extract-conversation-facts:terminal:v2'", [slug])).toHaveLength(1);
  await disposePersistenceConsumer(engine);
}));

function editPageAfterPreparation(slug: string, changes: Record<string, unknown>): void {
  let publicationNext = false;
  startPersistenceConsumer(engine, { engine: engine.kind } as any, { publicationHooks: { boundary: async (name, row) => {
    if (name !== 'prepared' || row.slug !== slug || publicationNext) return;
    publicationNext = true;
    await engine.transaction((tx: BrainEngine) => withCoordinatedWrite(tx, ['default'], async () => {
      if (typeof changes.compiled_truth !== 'string') throw new Error('fixture edit must change compiled_truth');
      const updated = await tx.executeRaw('UPDATE pages SET compiled_truth=$1 WHERE source_id=$2 AND slug=$3 RETURNING id',
        [changes.compiled_truth, 'default', slug]);
      if (!updated.length) throw new Error(`page disappeared: ${slug}`);
    }));
  } } });
}

test('managed publication conflicts atomically after a page edit; a fresh revision with the same sidecar token succeeds', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'conversations/sidecar-managed-example';
  const before = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  if (!before) throw new Error('fixture page missing');
  const originalToken = conversationSnapshotVersionToken(before.page, '**Alice Example** (2026-01-01 9:00 AM): We shipped a durable archive.\n**Bob Demo** (2026-01-01 9:05 AM): The archive stays available.');
  editPageAfterPreparation(slug, { compiled_truth: 'metadata edit ignored by sidecar parser' });
  await expect(runExtractConversationFactsCore(engine, { sourceId: 'default', slug, sleepMs: 0, managedJournalWrites: true,
    extractor: async () => [{ fact: 'stale extracted fact', kind: 'fact', entity_slug: null, source: 'test', confidence: 1 }] }))
    .rejects.toMatchObject({ code: 'revision_conflict' });
  expect(await engine.executeRaw("SELECT fact,row_num FROM facts WHERE source_markdown_slug=$1 ORDER BY row_num", [slug])).toEqual([{ fact: 'prior fact', row_num: 0 }]);
  expect(await engine.executeRaw("SELECT id FROM facts WHERE source_markdown_slug=$1 AND source='cli:extract-conversation-facts:terminal:v2'", [slug])).toHaveLength(0);
  expect(await engine.executeRaw("SELECT state,error_code FROM persistence_requests WHERE operation='extract_facts' AND slug=$1", [slug])).toEqual([{ state: 'conflict', error_code: 'revision_conflict' }]);

  const edited = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  if (!edited) throw new Error('edited page missing');
  expect(conversationSnapshotVersionToken(edited.page, '**Alice Example** (2026-01-01 9:00 AM): We shipped a durable archive.\n**Bob Demo** (2026-01-01 9:05 AM): The archive stays available.')).toBe(originalToken);
  expect(edited.revision).not.toBe(before.revision);
  const completed = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug, sleepMs: 0, managedJournalWrites: true,
    extractor: async () => [{ fact: 'fresh extracted fact', kind: 'fact', entity_slug: null, source: 'test', confidence: 1 }] });
  expect(completed).toMatchObject({ pages_processed: 1, pages_failed: 0 });
  expect(await engine.executeRaw("SELECT state,error_code FROM persistence_requests WHERE operation='extract_facts' AND slug=$1 ORDER BY sequence", [slug]))
    .toEqual([{ state: 'conflict', error_code: 'revision_conflict' }, { state: 'committed', error_code: null }]);
  expect(await engine.executeRaw("SELECT source,row_num FROM facts WHERE source_markdown_slug=$1 ORDER BY row_num", [slug])).toEqual([
    { source: 'cli:extract-conversation-facts', row_num: 0 },
    { source: 'cli:extract-conversation-facts:terminal:v2', row_num: 1 },
  ]);
  await disposePersistenceConsumer(engine);
}));

test('managed publication rejects a changed page through the journal consumer', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'conversations/stale-managed-example';
  editPageAfterPreparation(slug, { compiled_truth: 'page changed after preparation' });
  await expect(runExtractConversationFactsCore(engine, { sourceId: 'default', slug, sleepMs: 0, managedJournalWrites: true,
    extractor: async () => [{ fact: 'must not publish', kind: 'fact', entity_slug: null, source: 'test', confidence: 1 }] }))
    .rejects.toMatchObject({ code: 'revision_conflict' });
  expect(await engine.executeRaw("SELECT id FROM facts WHERE source_markdown_slug=$1", [slug])).toHaveLength(0);
  expect(await engine.executeRaw("SELECT id FROM facts WHERE source_markdown_slug=$1 AND source='cli:extract-conversation-facts:terminal:v2'", [slug])).toHaveLength(0);
  expect(await engine.executeRaw("SELECT state,error_code FROM persistence_requests WHERE operation='extract_facts' AND slug=$1", [slug]))
    .toEqual([{ state: 'conflict', error_code: 'revision_conflict' }]);
  await disposePersistenceConsumer(engine);
}));
