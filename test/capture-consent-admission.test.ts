/**
 * #6091 / W2.1 publication boundary on a managed brain: managed fact requests
 * from an ambient capture lane carry their provenance, and admission re-checks
 * the capture gate inside its transaction. The ordering contract: `off`
 * applies to every ambient fact request admitted after `config set` commits;
 * requests admitted before it publish.
 *
 * 1. Protects: a provider call in flight when off lands admits nothing; a
 *    request admitted before off still publishes; a stored batch admitted
 *    before off replays its result; a file-refusal follow-up batch (#6048)
 *    attempted after off is refused, with no new extraction.
 * 2. Fails when: admission ignores the setting, or re-checks requests that
 *    were already admitted.
 * 3. capture-consent-gate.serial.test.ts covers the lanes' own gates and the
 *    unmanaged fence-write boundary.
 *
 * Runs on PGLite; also on Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runFactsPipeline, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import { parseCorpusTurns, planCorpusWindows } from '../src/core/context/corpus-windows.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';

const KEYED: CapabilityReport = { embeddings: { available: false }, extraction: { available: true, provider: 'anthropic' }, search: 'keyword-only', mode: 'keyed' };
const COMPANY = { slug: 'companies/acme-example', title: 'Acme Example', type: 'company' };
const SESSION = 'consent-session.txt';

const engines: BrainEngine[] = [];
const dbDir = mkdtempSync(join(tmpdir(), 'gbrain-consent-admission-db-'));
let closePostgres: (() => Promise<void>) | undefined;
let extractions = 0;
let duringCall: (() => Promise<void>) | null = null;

beforeAll(async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    extractions++;
    if (duringCall) await duringCall();
    const facts = [{ fact: `${COMPANY.title} ships the example roadmap`, kind: 'fact', entity: COMPANY.slug, confidence: 0.9, notability: 'high' }];
    return { text: JSON.stringify({ facts }), blocks: [], stopReason: 'end', model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
      usage: { input_tokens: 5, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 } };
  });
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dbDir });
      await engine.initSchema();
      engines.push(engine);
    } else {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engines.push(isolated.engine);
      closePostgres = isolated.close;
    }
  }
}, 120_000);

afterAll(async () => {
  installFaultHook(undefined);
  __setChatTransportForTests(null);
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
  rmSync(dbDir, { recursive: true, force: true });
});

const transcript = () => toCorpusText([
  { role: 'user', text: 'Planning notes for the example roadmap. '.repeat(40) },
  { role: 'assistant', text: 'Summary of the example roadmap discussion. '.repeat(40) },
]);

/** A managed source holding a committed entity page and one corpus transcript, with writeback on. */
async function managedCorpus(engine: BrainEngine, dir: string, opts: { drifted?: boolean } = {}) {
  const root = join(dir, 'checkout'); mkdirSync(root);
  const corpusDir = join(dir, 'sessions'); mkdirSync(corpusDir);
  const sourceId = `consent-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  for (const [key, value] of [['sync.write_through', 'true'], ['facts.extraction_enabled', 'true'], ['dream.synthesize.session_corpus_dir', corpusDir],
    ['facts.default_visibility', 'world'], ['memory.auto_writeback', 'salient']]) await engine.setConfig(key, value);
  await claimWorktree(engine, sourceId, root);
  const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
    dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: COMPANY.slug, request_id: randomUUID(),
    content: `---\ntitle: ${COMPANY.title}\ntype: ${COMPANY.type}\n---\n# ${COMPANY.title}\n` } });
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const pageFile = join(root, `${COMPANY.slug}.md`);
  const pristine = readFileSync(pageFile);
  if (opts.drifted) appendFileSync(pageFile, '\nA local edit nobody imported.\n');
  const raw = transcript();
  writeFileSync(join(corpusDir, SESSION), raw);
  const quiet = () => waitFor(async () => (await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering')`, [sourceId]))[0].n === 0,
  { timeoutMs: 30_000, label: 'fact requests settled' });
  const sweep = async () => {
    await runMaintenanceSweep(engine, { sourceId, capabilities: KEYED, budgetMs: 120_000 });
    await quiet();
  };
  const requests = async () => (await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts'`, [sourceId]))[0].n;
  const facts = async () => (await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM facts WHERE source_id=$1 AND source='sweep:corpus' AND expired_at IS NULL`, [sourceId]))[0].n;
  // The sweep's own window, for a worker that passed its gate before off landed.
  const pipelineCtx: FactsBackstopCtx = { engine, sourceId, sessionId: `sweep:corpus:${SESSION}`, source: 'sweep:corpus', mode: 'inline',
    remote: false, reAdmitFileRefusals: true };
  const firstWindow = planCorpusWindows(parseCorpusTurns(raw), { turn: 0, offset: 0 })[0].text;
  const replay = () => runFactsPipeline(firstWindow, pipelineCtx);
  return { sourceId, sweep, quiet, requests, facts, replay, repair: () => writeFileSync(pageFile, pristine), off: () => engine.setConfig('memory.auto_writeback', 'off') };
}

async function onEachEngine(label: string, body: (engine: BrainEngine, dir: string) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), `gbrain-consent-admission-${label}-`));
    extractions = 0;
    duringCall = null;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, () => body(engine, dir));
    } finally {
      installFaultHook(undefined);
      duringCall = null;
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

describe('managed admission re-checks the capture gate (#6091)', () => {
  test('off set while the provider call is in flight admits no fact request', async () => {
    await onEachEngine('inflight', async (engine, dir) => {
      const w = await managedCorpus(engine, dir);
      duringCall = async () => { await w.off(); };
      await w.sweep();
      expect(extractions).toBe(1);
      expect(await w.requests()).toBe(0);
      expect(await w.facts()).toBe(0);
    });
  }, 180_000);

  test('a request admitted before off still publishes', async () => {
    await onEachEngine('queued', async (engine, dir) => {
      const w = await managedCorpus(engine, dir);
      let flipped = false;
      installFaultHook(async (point, detail) => {
        if (point === 'consumer:prepared' && detail.operation === 'extract_facts' && detail.sourceId === w.sourceId && !flipped) {
          flipped = true;
          await w.off();
        }
      });
      await w.sweep();
      expect(flipped).toBe(true);
      expect(await w.facts()).toBe(1);
    });
  }, 180_000);

  test('a stored batch admitted before off replays its result without a new provider call', async () => {
    await onEachEngine('replay', async (engine, dir) => {
      const w = await managedCorpus(engine, dir);
      await w.sweep();
      expect(await w.facts()).toBe(1);
      await w.off();
      const r = await w.replay();
      expect(r.inserted).toBe(1);
      expect(extractions).toBe(1);
    });
  }, 180_000);

  test('a file-refusal follow-up batch attempted after off is refused, with no new extraction', async () => {
    await onEachEngine('followup', async (engine, dir) => {
      const w = await managedCorpus(engine, dir, { drifted: true });
      await w.sweep();
      const before = await w.requests();
      expect(before).toBe(2);
      w.repair();
      await w.off();
      await expect(w.replay()).rejects.toMatchObject({ code: 'ambient_capture_off' });
      await w.quiet();
      expect(await w.requests()).toBe(before);
      expect(await w.facts()).toBe(0);
      expect(extractions).toBe(1);
    });
  }, 180_000);
});
