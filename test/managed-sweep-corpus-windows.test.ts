/**
 * #5887 on a managed brain: windowed corpus extraction publishes every window
 * through the persistence coordinator, and a resumed session submits only its
 * new window.
 *
 * 1. Protects: each window's facts commit as their own coordinated facts batch
 *    (the batch key digests the window text, so windows never collide), and a
 *    rewrite that appends a turn leaves the finished windows' batches alone.
 * 2. Fails when: the sweep sends the transcript once (head only), re-sends
 *    finished windows after a resume, or writes facts outside the coordinator
 *    (the armed managed writer guard refuses).
 * 3. sweep-corpus-windows.test.ts covers the file-side protocol unmanaged only.
 * 4. No production seam: gateway test transports only.
 *
 * Runs on PGLite; also on Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { CORPUS_CLAIM_SUFFIX, CORPUS_INGESTED_SUFFIX, runMaintenanceSweep } from '../src/core/sweep.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};
const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-managed-sweep-windows-db-'));
let closePostgres: (() => Promise<void>) | undefined;
let inputs: string[] = [];

const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };
beforeAll(async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (request): Promise<ChatResult> => {
    const content = String(request.messages[0].content);
    const text = content.slice(content.indexOf('<turn>\n') + '<turn>\n'.length, content.lastIndexOf('\n</turn>'));
    inputs.push(text);
    const facts = [...new Set(text.match(/\bT\d\d\b/g) ?? [])].map((m) => ({
      fact: `Alice Example owns workstream ${m}`, kind: 'fact', entity: 'people/alice-example', confidence: 0.9, notability: 'high',
    }));
    return { text: JSON.stringify({ facts }), blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
  });
  // Orthogonal vectors per distinct text, so cosine dedup never merges different window facts.
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map((v) => {
    const vec = Array(1536).fill(0);
    vec[[...v].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1536, 7)] = 1;
    return vec;
  }) })) as never);
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  __setChatTransportForTests(null); __setEmbedTransportForTests(null);
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

const body = (tag: string): string => {
  let s = `${tag} `;
  while (s.length < 5000) s += `${tag.toLowerCase()} detail words\n`;
  return s.slice(0, 5000);
};
const corpus = (count: number): string =>
  toCorpusText(Array.from({ length: count }, (_, i) => ({ role: i % 2 === 0 ? 'user' as const : 'assistant' as const, text: body(`T${String(i).padStart(2, '0')}`) })));

test('managed: every window commits its own coordinated facts batch; a resume submits only the new window', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-sweep-windows-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const corpusDir = join(dir, 'corpus'); mkdirSync(corpusDir);
    const sourceId = `windows-${randomUUID().slice(0, 8)}`;
    inputs = [];
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await engine.setConfig('facts.extraction_enabled', 'true');
        await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
        await claimWorktree(engine, sourceId, root);
        const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
          dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'people/alice-example',
          content: '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n', request_id: randomUUID() } });
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await expect(engine.executeRaw(`INSERT INTO facts(source_id,fact,kind,source,visibility) VALUES($1,'uncoordinated','fact','test','private')`,
          [sourceId])).rejects.toThrow(/writer_coordinator_required/);

        const file = join(corpusDir, 'managed-session.txt');
        writeFileSync(file, corpus(3));
        const sweep = () => runMaintenanceSweep(engine, { sourceId, capabilities: KEYED, budgetMs: 120_000 });
        const batches = async () => engine.executeRaw<{ n: string }>(
          `SELECT COUNT(*) AS n FROM persistence_requests WHERE source_id=$1 AND state='committed' AND intent->>'kind'='managed_facts_complete'`,
          [sourceId]).then((r) => Number(r[0].n));
        const active = async () => (await engine.executeRaw<{ fact: string }>(
          `SELECT fact FROM facts WHERE source_id=$1 AND source='sweep:corpus' AND expired_at IS NULL ORDER BY fact`, [sourceId])).map((r) => r.fact);

        const r1 = await sweep();
        expect(r1.corpusIngested).toBe(1);
        expect(inputs.length).toBe(3);
        expect(await batches()).toBe(3);
        expect(await active()).toEqual(['Alice Example owns workstream T00', 'Alice Example owns workstream T01', 'Alice Example owns workstream T02']);

        writeFileSync(file + '.tmp-hook', corpus(4));
        renameSync(file + '.tmp-hook', file);
        rmSync(file + CORPUS_INGESTED_SUFFIX, { force: true });
        rmSync(file + CORPUS_CLAIM_SUFFIX, { force: true });
        const r2 = await sweep();
        expect(r2.corpusIngested).toBe(1);
        expect(inputs.length).toBe(4);
        expect(inputs[3]).toMatch(/^\[assistant\]\nT03 /);
        expect(await batches()).toBe(4);
        expect((await active()).at(-1)).toBe('Alice Example owns workstream T03');
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);

// #6159: on a managed brain the coordinated facts batch carries the session file's write time as
// valid_from (facts-maintenance.ts), without putting it in the batch key.
test('managed: facts from a session file written 8 days ago are dated that day', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-sweep-fact-time-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const corpusDir = join(dir, 'corpus'); mkdirSync(corpusDir);
    const sourceId = `facttime-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await engine.setConfig('facts.extraction_enabled', 'true');
        await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
        await claimWorktree(engine, sourceId, root);
        const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
          dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'people/alice-example',
          content: '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n', request_id: randomUUID() } });
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

        const file = join(corpusDir, 'backdated-session.txt');
        writeFileSync(file, corpus(1));
        const written = new Date(Date.now() - 8 * 86_400_000);
        utimesSync(file, written, written);
        await runMaintenanceSweep(engine, { sourceId, capabilities: KEYED, budgetMs: 120_000 });
        const rows = await engine.executeRaw<{ valid_from: Date }>(
          `SELECT valid_from FROM facts WHERE source_id=$1 AND source='sweep:corpus' AND expired_at IS NULL`, [sourceId]);
        expect(rows).toHaveLength(1);
        expect(new Date(rows[0].valid_from).toISOString().slice(0, 10)).toBe(written.toISOString().slice(0, 10));
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);
