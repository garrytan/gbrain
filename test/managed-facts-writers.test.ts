/**
 * #5280 remainder: the facts-family maintenance writers publish through the
 * persistence coordinator on a managed brain instead of refusing with
 * writer_coordinator_required.
 *
 * 1. Protects: extract_facts reconcile (and its soft-deleted-page expiry),
 *    phantom redirect, direct fence writes, Google loops extraction and bulk
 *    conversation fact extraction (core, CLI, cycle phase) each land their
 *    intended rows/files on a managed brain.
 * 2. Fails when: any of these writers takes the legacy path (the managed
 *    writer guard trigger refuses it) or keeps its early refusal.
 * 3. Existing coverage only pinned the refusals
 *    (managed-unsupported-preflight.serial.test.ts).
 * 4. No production seam: model calls use the gateway's test transports and
 *    the conversation core's existing extractor injection.
 *
 * Journaled writers assert a committed persistence request; DB-only derived
 * rows (fence reconcile, conversation facts) assert the committed rows
 * while the managed guard is armed (an uncoordinated write refuses).
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { runExtractConversationFactsCore, runExtractConversationFacts } from '../src/commands/extract-conversation-facts.ts';
import { runPhaseConversationFactsBackfill } from '../src/core/cycle/conversation-facts-backfill.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { runLoopsExtract } from '../src/core/google/loops-extract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-managed-facts-writers-db-'));
let closePostgres: (() => Promise<void>) | undefined;
let chatReply = '{"facts":[]}';

const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };
beforeAll(async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: chatReply, blocks: [], stopReason: 'end', usage,
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }));
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterEach(() => { chatReply = '{"facts":[]}'; });
afterAll(async () => {
  __setChatTransportForTests(null); __setEmbedTransportForTests(null);
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

interface Fixture { engine: BrainEngine; sourceId: string; root: string; put(slug: string, content: string): Promise<void>; }

/** Seeds through ordinary coordinated page writes while unmanaged, then enables managed mode. */
async function managed(seed: (f: Fixture) => Promise<void>, run: (f: Fixture) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-facts-writers-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `facts-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await engine.setConfig('facts.extraction_enabled', 'true');
        await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
        await claimWorktree(engine, sourceId, root);
        const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
          dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        const fixture: Fixture = { engine, sourceId, root, put: async (slug, content) => {
          const prior = await engine.readPageSnapshot(slug, { sourceId });
          await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID(),
            ...(prior ? { expected_revision: prior.revision } : {}) } });
        } };
        await seed(fixture);
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await expect(engine.executeRaw(`INSERT INTO facts(source_id,fact,kind,source,visibility) VALUES($1,'uncoordinated','fact','test','private')`,
          [sourceId])).rejects.toThrow(/writer_coordinator_required/);
        await run(fixture);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const FENCE = (rows: string) => `## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;
const PERSON = (title: string, body = '') => `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\n${body}`;
const CONVERSATION = `---\ntitle: Synthetic chat\ntype: conversation\n---\n${[
  '**Alice Example** (2024-03-15 9:00 AM): I just signed the offer letter for Acme Corp.',
  '**Bob Demo** (2024-03-15 9:01 AM): Congrats! What is the title?',
  '**Alice Example** (2024-03-15 9:02 AM): Staff engineer on the platform team.',
].join('\n')}\n`;

async function facts(engine: BrainEngine, sourceId: string, slug: string) {
  return (await engine.executeRaw<{ id: number; fact: string; row_num: number | null; expired_at: unknown; source: string }>(
    'SELECT id,fact,row_num,expired_at,source FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY row_num NULLS LAST,id', [sourceId, slug])).map(f => ({ ...f, id: Number(f.id), row_num: f.row_num == null ? null : Number(f.row_num) }));
}
async function committed(engine: BrainEngine, sourceId: string, slug: string) {
  return engine.executeRaw<{ state: string; operation: string; kind: string | null }>(
    "SELECT state,operation,intent->>'kind' AS kind FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND state='committed' ORDER BY sequence",
    [sourceId, slug]);
}

test('managed extract_facts reconciles a drifted fence and expires a deleted page\'s facts inside the coordinator capability', async () => {
  await managed(async ({ engine, sourceId, put }) => {
    await put('people/alice-example', PERSON('Alice Example', FENCE([
      '| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |',
      '| 2 | Lives in Paris | fact | 1.0 | world | medium | 2018-01-01 |  | chat |  |'].join('\n'))));
    await put('people/bob-demo', PERSON('Bob Demo', FENCE('| 1 | Plays chess | fact | 1.0 | world | low | 2019-01-01 |  | chat |  |')));
    expect(await facts(engine, sourceId, 'people/alice-example')).toHaveLength(2);
    // Drift: the index lost the fence rows; the other page is deleted with active rows.
    await engine.executeRaw('DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [sourceId, 'people/alice-example']);
    await engine.softDeletePage('people/bob-demo', { sourceId });
  }, async ({ engine, sourceId }) => {
    const result = await runExtractFacts(engine, { sourceId, slugs: ['people/alice-example'] });
    expect(result.factsInserted).toBe(2);
    expect(result.factsExpiredForDeletedPages).toBe(1);
    expect((await facts(engine, sourceId, 'people/alice-example')).map(f => [f.row_num, f.fact, f.expired_at])).toEqual([
      [1, 'Founded Acme', null], [2, 'Lives in Paris', null]]);
    expect((await facts(engine, sourceId, 'people/bob-demo'))[0].expired_at).not.toBeNull();
    expect((await runExtractFacts(engine, { sourceId, slugs: ['people/alice-example'] })).factsInserted).toBe(0);
  });
}, 120_000);

test('managed phantom redirect merges the phantom fence into the canonical page and deletes the phantom through the coordinator', async () => {
  await managed(async ({ engine, sourceId, root, put }) => {
    await put('people/alice-example', PERSON('Alice Example'));
    // A legacy stub phantom: written without put_page provenance stamps, which the residue gate treats as content.
    await engine.putPage('alice', { type: 'person', title: 'alice', compiled_truth: `# alice\n\n${FENCE('| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |')}`.trim(),
      timeline: '', frontmatter: {} }, { sourceId });
    const phantom = (await engine.readPageSnapshot('alice', { sourceId }))!;
    writeFileSync(join(root, 'alice.md'), serializePageToMarkdown(phantom.page, phantom.tags));
    await runExtractFacts(engine, { sourceId, slugs: ['alice'] });
  }, async ({ engine, sourceId, root }) => {
    const [before] = await facts(engine, sourceId, 'alice');
    expect(before?.fact).toBe('Founded Acme');
    const result = await runExtractFacts(engine, { sourceId, brainDir: root });
    expect(result.phantomsRedirected).toBe(1);
    expect(result.warnings.filter(w => w.startsWith('phantom_redirect'))).toEqual([]);
    const moved = await facts(engine, sourceId, 'people/alice-example');
    expect(moved.map(f => [f.id, f.fact, f.expired_at])).toEqual([[before.id, 'Founded Acme', null]]);
    expect(readFileSync(join(root, 'people/alice-example.md'), 'utf8')).toContain('Founded Acme');
    expect(existsSync(join(root, 'alice.md'))).toBe(false);
    expect((await engine.readPageSnapshot('alice', { sourceId, includeDeleted: true }))?.page.deleted_at).not.toBeNull();
    expect(await engine.resolveSlugWithAlias('alice', sourceId)).toBe('people/alice-example');
    expect((await committed(engine, sourceId, 'people/alice-example')).map(r => r.kind)).toContain('managed_maintenance_phantom_merge');
    expect((await committed(engine, sourceId, 'alice')).map(r => r.kind)).toContain('managed_maintenance_phantom_delete');
  });
}, 120_000);

test('managed phantom redirect rechecks eligibility against the snapshot it merges', async () => {
  await managed(async ({ engine, sourceId, root, put }) => {
    await put('people/alice-example', PERSON('Alice Example'));
    await engine.putPage('alice', { type: 'person', title: 'alice', compiled_truth: `# alice\n\n${FENCE('| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |')}`.trim(),
      timeline: '', frontmatter: {} }, { sourceId });
    const phantom = (await engine.readPageSnapshot('alice', { sourceId }))!;
    writeFileSync(join(root, 'alice.md'), serializePageToMarkdown(phantom.page, phantom.tags));
    await runExtractFacts(engine, { sourceId, slugs: ['alice'] });
  }, async ({ engine, sourceId, root, put }) => {
    // After the pass judged the phantom residue-free, an edit adds timeline
    // text and metadata but leaves compiled_truth unchanged.
    const read = engine.readPageSnapshot;
    let edited = false;
    engine.readPageSnapshot = (async function (this: BrainEngine, slug: string, opts?: Parameters<BrainEngine['readPageSnapshot']>[1]) {
      if (this === engine && slug === 'alice' && !edited && new Error().stack?.includes('redirectManagedPhantom')) {
        edited = true;
        const current = (await read.call(this, slug, opts))!;
        await put('alice', serializePageToMarkdown({ ...current.page, frontmatter: { owner_note: 'keep me' },
          timeline: '- **2026-01-01** | Met at the offsite' }, current.tags));
      }
      return read.call(this, slug, opts);
    }) as BrainEngine['readPageSnapshot'];
    let result: Awaited<ReturnType<typeof runExtractFacts>>;
    try { result = await runExtractFacts(engine, { sourceId, brainDir: root }); }
    finally { delete (engine as { readPageSnapshot?: unknown }).readPageSnapshot; }
    expect(edited).toBe(true);
    const alive = await engine.readPageSnapshot('alice', { sourceId, includeDeleted: true });
    expect(alive?.page.deleted_at ?? null).toBeNull();
    expect(alive?.page.timeline).toContain('Met at the offsite');
    expect([result.phantomsRedirected, result.phantomsSkippedDrift]).toEqual([0, 1]);
    expect((await committed(engine, sourceId, 'people/alice-example')).map(r => r.kind)).not.toContain('managed_maintenance_phantom_merge');
  });
}, 120_000);

test('managed direct fence writes publish the fence row and index through the coordinator', async () => {
  await managed(async ({ put }) => { await put('people/alice-example', PERSON('Alice Example')); }, async ({ engine, sourceId, root }) => {
    const result = await writeFactsToFence(engine, { sourceId, localPath: root, slug: 'people/alice-example', resolutionSource: 'exact_page' }, [
      { fact: 'Prefers weekly status reports.', kind: 'preference', source: 'fixture', visibility: 'private', notability: 'medium', embedding: null, sessionId: null }]);
    expect(result.inserted).toBe(1);
    const rows = await facts(engine, sourceId, 'people/alice-example');
    expect(rows.map(f => [f.id, f.fact, f.row_num])).toEqual([[result.ids[0], 'Prefers weekly status reports.', 1]]);
    expect(readFileSync(join(root, 'people/alice-example.md'), 'utf8')).toContain('Prefers weekly status reports.');
    expect((await committed(engine, sourceId, 'people/alice-example')).map(r => r.kind)).toContain('managed_facts_entity');
  });
}, 120_000);

test('managed fence writes keep a fact\'s explicit context in the fence and the index', async () => {
  await managed(async ({ put }) => { await put('people/alice-example', PERSON('Alice Example')); }, async ({ engine, sourceId, root }) => {
    const write = (context: string) => writeFactsToFence(engine, { sourceId, localPath: root, slug: 'people/alice-example', resolutionSource: 'exact_page' }, [
      { fact: 'Prefers weekly status reports.', kind: 'preference', source: 'fixture', context, visibility: 'private', notability: 'medium', embedding: null, sessionId: null }]);
    const first = await write('meetings/review');
    const [row] = await engine.executeRaw<{ context: string | null }>('SELECT context FROM facts WHERE id=$1', [first.ids[0]]);
    expect(row.context).toBe('meetings/review');
    expect(readFileSync(join(root, 'people/alice-example.md'), 'utf8')).toContain('meetings/review');
    // Context is part of the write's identity: a different context is a new write, not a replay.
    expect((await committed(engine, sourceId, '__managed_facts_complete__')).length).toBe(1);
    await write('meetings/other');
    expect((await committed(engine, sourceId, '__managed_facts_complete__')).length).toBe(2);
  });
}, 120_000);

test('managed writeSingleFact supersedes a near-duplicate of the same kind like the unmanaged path', async () => {
  await managed(async ({ engine, put }) => {
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
    await engine.setConfig('embedding_dimensions', '1536');
    await put('people/alice-example', PERSON('Alice Example'));
  }, async ({ engine, sourceId, root }) => {
    const remember = (fact: string) => writeSingleFact(engine, sourceId, { fact, provenance: 'fixture', entity: 'people/alice-example', visibility: 'world' });
    const first = await remember('Alice Example works at Acme.');
    expect(first.status).toBe('inserted');
    const second = await remember('Alice Example works at Beta.');
    expect(second.status).toBe('superseded');
    expect(second.id).not.toBe(first.id);
    const [old] = await engine.executeRaw<{ expired_at: unknown; superseded_by: number | null }>('SELECT expired_at,superseded_by FROM facts WHERE id=$1', [first.id]);
    expect(old.expired_at).not.toBeNull();
    expect(Number(old.superseded_by)).toBe(second.id);
    expect((await facts(engine, sourceId, 'people/alice-example')).filter(f => f.expired_at === null).map(f => f.fact)).toEqual(['Alice Example works at Beta.']);
    expect(readFileSync(join(root, 'people/alice-example.md'), 'utf8')).toMatch(/~~Alice Example works at Acme\.~~/);
  });
}, 120_000);

test('managed Google loops extraction lands its commitment fact through the coordinator', async () => {
  await managed(async ({ engine, put }) => {
    await engine.setConfig('loops.extraction_enabled', 'true');
    await put('people/alice-example', PERSON('Alice Example'));
    await put('emails/example', `---\ntitle: Synthetic exchange\ntype: email\nthread_id: example\nfrom: sender@example.invalid\n---\nI will send the deck by Friday.\n`);
  }, async ({ engine, sourceId, root }) => {
    chatReply = JSON.stringify({ commitments: [{ text: 'Send the deck by Friday', direction: 'owed_by_me',
      counterparty_name: 'people/alice-example', counterparty_email: '', due_iso: '2026-10-02', quote: 'I will send the deck by Friday.' }], decisions_pending: [] });
    const result = await runLoopsExtract(engine, { slug: 'emails/example', sourceId });
    expect(result).toMatchObject({ status: 'extracted', commitments: 1 });
    const [loop] = await engine.executeRaw<{ fact_id: number | null }>('SELECT fact_id FROM open_loops WHERE source_id=$1', [sourceId]);
    const rows = await facts(engine, sourceId, 'people/alice-example');
    expect(rows.map(f => [f.id, f.fact])).toEqual([[Number(loop.fact_id), 'Send the deck by Friday']]);
    expect(readFileSync(join(root, 'people/alice-example.md'), 'utf8')).toContain('Send the deck by Friday');
    expect((await committed(engine, sourceId, 'people/alice-example')).map(r => r.kind)).toContain('managed_facts_entity');
  });
}, 120_000);

const extractor = async () => [{ fact: 'Alice Example joined Acme Corp as a staff engineer.', kind: 'event' as const, entity_slug: null,
  confidence: 1, notability: 'high' as const, source: 'test', visibility: 'private' as const }];

test('managed bulk conversation extraction writes its facts and terminal audit row inside the coordinator capability', async () => {
  await managed(async ({ put }) => { await put('conversations/synthetic-chat', CONVERSATION); }, async ({ engine, sourceId }) => {
    const result = await runExtractConversationFactsCore(engine, { sourceId, overrideDisabled: true, extractor, types: ['conversation'] });
    expect(result.facts_inserted).toBe(1);
    expect(result.pages_failed).toBe(0);
    expect((await facts(engine, sourceId, 'conversations/synthetic-chat')).map(f => [f.fact, f.source])).toEqual([
      ['Alice Example joined Acme Corp as a staff engineer.', 'cli:extract-conversation-facts'],
      ['EXTRACTION_COMPLETE', 'cli:extract-conversation-facts:terminal:v2']]);
    // A forced replay deletes the prior rows first, also inside the capability.
    const replay = await runExtractConversationFactsCore(engine, { sourceId, overrideDisabled: true, extractor, types: ['conversation'], force: true });
    expect(replay.orphan_facts_cleaned).toBe(2);
    expect(await facts(engine, sourceId, 'conversations/synthetic-chat')).toHaveLength(2);
  });
}, 120_000);

test('managed conversation extraction preserves the prior batch when a replacement extraction fails', async () => {
  const slug = 'conversations/synthetic-chat';
  await managed(async ({ engine, sourceId, put }) => {
    await put(slug, CONVERSATION);
    await runExtractConversationFactsCore(engine, { sourceId, overrideDisabled: true, extractor, types: ['conversation'] });
    await put(slug, CONVERSATION.replace('Staff engineer', 'Principal engineer'));
  }, async ({ engine, sourceId }) => {
    const failed = async () => { throw new Error('synthetic provider failure'); };
    const result = await runExtractConversationFactsCore(engine, { sourceId, overrideDisabled: true, extractor: failed, types: ['conversation'] });
    expect(result.pages_failed).toBe(1);
    expect((await facts(engine, sourceId, slug)).map(row => row.fact)).toEqual([
      'Alice Example joined Acme Corp as a staff engineer.', 'EXTRACTION_COMPLETE']);
  });
}, 120_000);

test('managed conversation extraction keeps the prior batch when the page is edited while the model runs, then replaces it', async () => {
  const slug = 'conversations/synthetic-chat';
  await managed(async ({ engine, sourceId, put }) => {
    await put(slug, CONVERSATION);
    await runExtractConversationFactsCore(engine, { sourceId, overrideDisabled: true, extractor, types: ['conversation'] });
    await put(slug, CONVERSATION.replace('Staff engineer', 'Senior engineer'));
  }, async ({ engine, sourceId, put }) => {
    const editing = async () => {
      await put(slug, CONVERSATION.replace('Staff engineer', 'Principal engineer'));
      return [{ ...(await extractor())[0]!, fact: 'Alice Example joined Acme Corp as a principal engineer.' }];
    };
    const raced = await runExtractConversationFactsCore(engine, { sourceId, overrideDisabled: true, extractor: editing, types: ['conversation'] });
    expect(raced.pages_failed).toBe(1);
    expect((await facts(engine, sourceId, slug)).map(row => row.fact)).toEqual([
      'Alice Example joined Acme Corp as a staff engineer.', 'EXTRACTION_COMPLETE']);
    const principal = async () => [{ ...(await extractor())[0]!, fact: 'Alice Example joined Acme Corp as a principal engineer.' }];
    const replay = await runExtractConversationFactsCore(engine, { sourceId, overrideDisabled: true, extractor: principal, types: ['conversation'] });
    expect(replay).toMatchObject({ pages_failed: 0, facts_inserted: 1, orphan_facts_cleaned: 2 });
    expect((await facts(engine, sourceId, slug)).map(row => [row.fact, row.row_num])).toEqual([
      ['Alice Example joined Acme Corp as a principal engineer.', 0], ['EXTRACTION_COMPLETE', 1]]);
  });
}, 120_000);

test('republishing a managed conversation page keeps its extracted facts active and the page complete', async () => {
  // Conversation rows are numbered on the page coordinate but carry no fence;
  // like the legacy fence reconcile (#1928), the canonical projection must not
  // expire them as rows that left a fence.
  await managed(async ({ put }) => { await put('conversations/synthetic-chat', CONVERSATION); }, async ({ engine, sourceId, put }) => {
    await runExtractConversationFactsCore(engine, { sourceId, overrideDisabled: true, extractor, types: ['conversation'] });
    await put('conversations/synthetic-chat', CONVERSATION.replace('Staff engineer', 'A staff engineer'));
    expect((await facts(engine, sourceId, 'conversations/synthetic-chat')).map(f => [f.fact, f.row_num, f.expired_at])).toEqual([
      ['Alice Example joined Acme Corp as a staff engineer.', 0, null], ['EXTRACTION_COMPLETE', 1, null]]);
    // The edit changed the snapshot, so the next run replays the page delete-first.
    const rerun = await runExtractConversationFactsCore(engine, { sourceId, overrideDisabled: true, extractor, types: ['conversation'] });
    expect([rerun.facts_inserted, rerun.orphan_facts_cleaned]).toEqual([1, 2]);
    expect((await facts(engine, sourceId, 'conversations/synthetic-chat')).filter(f => f.expired_at === null).map(f => f.fact)).toEqual([
      'Alice Example joined Acme Corp as a staff engineer.', 'EXTRACTION_COMPLETE']);
  });
}, 120_000);

test('managed phantom redirect defers the phantom delete when the phantom is edited after the merge', async () => {
  await managed(async ({ engine, sourceId, root, put }) => {
    await put('people/alice-example', PERSON('Alice Example'));
    await engine.putPage('alice', { type: 'person', title: 'alice', compiled_truth: `# alice\n\n${FENCE('| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |')}`.trim(),
      timeline: '', frontmatter: {} }, { sourceId });
    const phantom = (await engine.readPageSnapshot('alice', { sourceId }))!;
    writeFileSync(join(root, 'alice.md'), serializePageToMarkdown(phantom.page, phantom.tags));
    await runExtractFacts(engine, { sourceId, slugs: ['alice'] });
  }, async ({ engine, sourceId, root, put }) => {
    // A coordinated edit to the phantom lands right after the merge commits,
    // before the redirect rereads the phantom to delete it.
    const read = engine.readPageSnapshot;
    let edited = false;
    engine.readPageSnapshot = (async function (this: BrainEngine, slug: string, opts?: Parameters<BrainEngine['readPageSnapshot']>[1]) {
      // Transactions inherit this method; only the redirect's own read on the engine triggers the edit.
      if (this === engine && slug === 'alice' && !edited && new Error().stack?.includes('redirectManagedPhantom') && (await engine.executeRaw(
        "SELECT 1 FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_maintenance_phantom_merge' AND state='committed'", [sourceId])).length) {
        edited = true;
        await put('alice', `---\ntitle: alice\ntype: person\n---\n# alice\n\n${FENCE([
          '| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |',
          '| 2 | Moved to Lisbon | fact | 1.0 | world | high | 2020-01-01 |  | chat |  |'].join('\n'))}`);
      }
      return read.call(this, slug, opts);
    }) as BrainEngine['readPageSnapshot'];
    let result: Awaited<ReturnType<typeof runExtractFacts>>;
    try { result = await runExtractFacts(engine, { sourceId, brainDir: root }); }
    finally { delete (engine as { readPageSnapshot?: unknown }).readPageSnapshot; }
    expect(edited).toBe(true);
    const alive = await engine.readPageSnapshot('alice', { sourceId, includeDeleted: true });
    expect(alive?.page.deleted_at ?? null).toBeNull();
    expect([result.phantomsRedirected, result.phantomsSkippedDrift]).toEqual([0, 1]);
    expect(alive?.page.compiled_truth).toContain('Moved to Lisbon');
    expect(readFileSync(join(root, 'alice.md'), 'utf8')).toContain('Moved to Lisbon');
    expect(await committed(engine, sourceId, 'alice').then(rows => rows.filter(r => r.kind === 'managed_maintenance_phantom_delete'))).toEqual([]);
  });
}, 120_000);

const localCtx = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

test('managed conversation extraction publishes nothing for a page purged while the model runs', async () => {
  await managed(async ({ put }) => { await put('conversations/synthetic-chat', CONVERSATION); }, async ({ engine, sourceId }) => {
    const purging = async () => {
      const page = (await engine.readPageSnapshot('conversations/synthetic-chat', { sourceId }))!;
      await submitPageMutation(localCtx(engine, sourceId), { operation: 'delete_page', params: { slug: 'conversations/synthetic-chat',
        purge: true, expected_revision: page.revision, request_id: randomUUID() } });
      return extractor();
    };
    const result = await runExtractConversationFactsCore(engine, { sourceId, overrideDisabled: true, extractor: purging, types: ['conversation'] });
    expect(await engine.readPageSnapshot('conversations/synthetic-chat', { sourceId, includeDeleted: true })).toBeNull();
    expect(await facts(engine, sourceId, 'conversations/synthetic-chat')).toEqual([]);
    expect(result.pages_failed).toBe(1);
  });
}, 120_000);

test('managed conversation extraction publishes nothing into a source archived while the model runs', async () => {
  await managed(async ({ put }) => { await put('conversations/synthetic-chat', CONVERSATION); }, async ({ engine, sourceId }) => {
    const archiving = async () => {
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
        await tx.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
      });
      return extractor();
    };
    try {
      const result = await runExtractConversationFactsCore(engine, { sourceId, overrideDisabled: true, extractor: archiving, types: ['conversation'] });
      expect(await facts(engine, sourceId, 'conversations/synthetic-chat')).toEqual([]);
      expect(result.pages_failed).toBe(1);
    } finally {
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
        await tx.executeRaw('UPDATE sources SET archived=false WHERE id=$1', [sourceId]);
      });
    }
  });
}, 120_000);

test('a Facts fence published on an extracted conversation takes its row numbers from colliding conversation rows', async () => {
  await managed(async ({ put }) => { await put('conversations/synthetic-chat', CONVERSATION); }, async ({ engine, sourceId, put }) => {
    await runExtractConversationFactsCore(engine, { sourceId, overrideDisabled: true, extractor, types: ['conversation'] });
    await put('conversations/synthetic-chat', `${CONVERSATION}\n${FENCE('| 1 | Acme hired a platform team | fact | 1.0 | world | high | 2024-03-15 |  | chat |  |')}`);
    const rows = await facts(engine, sourceId, 'conversations/synthetic-chat');
    expect(rows.filter(f => f.expired_at === null).map(f => [f.fact, f.row_num, f.source])).toEqual([
      ['Alice Example joined Acme Corp as a staff engineer.', 0, 'cli:extract-conversation-facts'],
      ['Acme hired a platform team', 1, 'chat']]);
    expect(rows.find(f => f.fact === 'EXTRACTION_COMPLETE')).toMatchObject({ row_num: null, source: 'cli:extract-conversation-facts:terminal:v2' });
  });
}, 120_000);

test('managed phantom delete moves an edge added to the phantom after its merge', async () => {
  await managed(async ({ engine, sourceId, root, put }) => {
    await put('people/alice-example', PERSON('Alice Example'));
    await put('meetings/offsite', '---\ntitle: Offsite\ntype: meeting\n---\nA planning meeting.');
    await engine.putPage('alice', { type: 'person', title: 'alice', compiled_truth: `# alice\n\n${FENCE('| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |')}`.trim(),
      timeline: '', frontmatter: {} }, { sourceId });
    const phantom = (await engine.readPageSnapshot('alice', { sourceId }))!;
    writeFileSync(join(root, 'alice.md'), serializePageToMarkdown(phantom.page, phantom.tags));
    await runExtractFacts(engine, { sourceId, slugs: ['alice'] });
  }, async ({ engine, sourceId, root }) => {
    const read = engine.readPageSnapshot;
    let linked = false;
    engine.readPageSnapshot = (async function (this: BrainEngine, slug: string, opts?: Parameters<BrainEngine['readPageSnapshot']>[1]) {
      if (this === engine && slug === 'alice' && !linked && new Error().stack?.includes('redirectManagedPhantom') && (await engine.executeRaw(
        "SELECT 1 FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_maintenance_phantom_merge' AND state='committed'", [sourceId])).length) {
        linked = true;
        await engine.addLink('meetings/offsite', 'alice', 'met', 'mentions', 'manual', undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId });
      }
      return read.call(this, slug, opts);
    }) as BrainEngine['readPageSnapshot'];
    let result: Awaited<ReturnType<typeof runExtractFacts>>;
    try { result = await runExtractFacts(engine, { sourceId, brainDir: root }); }
    finally { delete (engine as { readPageSnapshot?: unknown }).readPageSnapshot; }
    expect(linked).toBe(true);
    expect(result.phantomsRedirected).toBe(1);
    const edges = await engine.executeRaw<{ slug: string }>(`SELECT t.slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
      WHERE f.source_id=$1 AND f.slug='meetings/offsite'`, [sourceId]);
    expect(edges.map(e => e.slug)).toEqual(['people/alice-example']);
  });
}, 120_000);

test('managed deleted-page expiry waits for a concurrent restore of that page (Postgres)', async () => {
  await managed(async ({ put }) => {
    await put('people/bob-demo', PERSON('Bob Demo', FENCE('| 1 | Plays chess | fact | 1.0 | world | low | 2019-01-01 |  | chat |  |')));
  }, async ({ engine, sourceId }) => {
    if (engine.kind !== 'postgres') return;
    await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.softDeletePage('people/bob-demo', { sourceId })));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>(resolve => { locked = resolve; });
    const restore = engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
      await tx.lockPageKeys([{ sourceId, slug: 'people/bob-demo' }]);
      await tx.executeRaw('UPDATE pages SET deleted_at=NULL WHERE source_id=$1 AND slug=$2', [sourceId, 'people/bob-demo']);
      locked();
      await gate;
    }));
    await holding;
    const run = runExtractFacts(engine, { sourceId, slugs: [] });
    await new Promise(resolve => setTimeout(resolve, 500));
    release();
    await restore;
    expect((await run).factsExpiredForDeletedPages).toBe(0);
    expect((await facts(engine, sourceId, 'people/bob-demo'))[0].expired_at).toBeNull();
  });
}, 120_000);

test('managed writeSingleFact reports the entity it persisted for an unresolved reference', async () => {
  await managed(async () => {}, async ({ engine, sourceId }) => {
    const written = await writeSingleFact(engine, sourceId, { fact: 'Carol Unknown owns a sailboat.', provenance: 'fixture', entity: 'Carol Unknown' });
    const [row] = await engine.executeRaw<{ entity_slug: string | null }>('SELECT entity_slug FROM facts WHERE id=$1', [written.id]);
    expect(written.entity_slug).toBe(row.entity_slug);
  });
}, 120_000);

test('managed extract-conversation-facts CLI extracts instead of refusing', async () => {
  await managed(async ({ put }) => { await put('conversations/synthetic-chat', CONVERSATION); }, async ({ engine, sourceId }) => {
    chatReply = JSON.stringify({ facts: [{ fact: 'Alice Example joined Acme Corp.', kind: 'event', entity: null, confidence: 1, notability: 'high' }] });
    await runExtractConversationFacts(engine, ['--source-id', sourceId, '--slug', 'conversations/synthetic-chat', '--override-disabled']);
    expect((await facts(engine, sourceId, 'conversations/synthetic-chat')).map(f => f.fact)).toEqual(['Alice Example joined Acme Corp.', 'EXTRACTION_COMPLETE']);
  });
}, 120_000);

test('managed conversation_facts_backfill phase extracts instead of refusing', async () => {
  await managed(async ({ engine, put }) => {
    await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
    await put('conversations/synthetic-chat', CONVERSATION);
  }, async ({ engine, sourceId }) => {
    chatReply = JSON.stringify({ facts: [{ fact: 'Alice Example joined Acme Corp.', kind: 'event', entity: null, confidence: 1, notability: 'high' }] });
    const phase = await runPhaseConversationFactsBackfill(engine);
    expect(phase.status).toBe('ok');
    expect((phase.details.per_source as Record<string, { facts_inserted: number }>)[sourceId].facts_inserted).toBe(1);
    expect((await facts(engine, sourceId, 'conversations/synthetic-chat')).map(f => f.fact)).toEqual(['Alice Example joined Acme Corp.', 'EXTRACTION_COMPLETE']);
  });
}, 120_000);
