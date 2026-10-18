/**
 * #6778: a managed facts-absorb job publishes its facts with the job-bounded
 * maintenance wait (MaintenanceWriteWait: 30 s, capped by the job deadline,
 * cut short by the job's abort signal) instead of the fixed 5 s publish wait,
 * and `ingest_log` tells an accepted write that is still committing apart
 * from a refusal and from writer contention before anything was admitted.
 *
 * 1. Protects: a facts write that commits 8 s after admission completes the
 *    job in one attempt with no `facts:absorb` failure row, and the worker
 *    keeps renewing the job's lock while the handler waits; a job deadline
 *    bounds the wait, and the still-pending write is logged
 *    `write_pending_accepted` (19 such rows do not warn the doctor); a busy
 *    canonical writer before admission is logged `write_deferred_unadmitted`
 *    and never as accepted; a `write_pending` error without a real nonterminal
 *    receipt keeps the `write_refused` label.
 * 2. Fails if the publish goes back to the fixed 5 s wait (the delayed commit
 *    fails the attempt with `write_refused: write_pending`), if the job
 *    deadline or receipt check is dropped, or if contention is relabelled.
 * 3. Existing coverage runs the handler only against writes that commit at
 *    once (test/helpers/managed-facts-contract.ts) or refusals
 *    (test/facts-absorb-write-refusal.test.ts).
 * 4. No new production seam: the persistence fault hook stalls publication,
 *    the native worktree lock models contention. The 8 s commit is real time
 *    because awaitWrite has no injectable clock.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { operationsByName } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimPersistenceEffect } from '../src/core/persistence/effect-journal.ts';
import { dispatchFactsBackstopEffect } from '../src/core/persistence/effect-facts.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { UnrecoverableError } from '../src/core/minions/errors.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { makeFactsAbsorbHandler } from '../src/core/minions/handlers/facts-absorb.ts';
import { WRITE_DEFERRED_UNADMITTED, WRITE_PENDING_ACCEPTED, writeFactsAbsorbFailure } from '../src/core/facts/absorb-log.ts';
import { factsExtractionEntry } from '../src/commands/doctor/checks/knowledge-health.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let chatCalls = 0;
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterEach(async () => { installFaultHook(undefined); await disposePersistenceConsumer(engine); });
afterAll(async () => {
  __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway();
  await disposePersistenceConsumer(engine); await engine.disconnect();
});

interface Fixture { sourceId: string; job: { id: number; data: Record<string, unknown> } }

/** A managed source whose committed page write queued one facts-absorb job; `run` gets the job before it runs. */
async function fixture(name: string, run: (f: Fixture) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-6778-'));
  const sourceId = `wait-${name}`;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
      __setChatTransportForTests(async (): Promise<ChatResult> => {
        chatCalls++;
        return { text: JSON.stringify({ facts: [
          { fact: 'Alice-example prefers weekly status reports.', kind: 'preference', entity: 'people/alice-example', confidence: 0.9, notability: 'high' },
          { fact: 'Acme-example measures monthly growth.', kind: 'fact', entity: 'companies/acme-example', confidence: 0.8, notability: 'medium' },
        ] }), blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
      });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.setConfig('facts.extraction_enabled', 'true');
      const root = join(home, 'repo');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      for (const [slug, type, body] of [['people/alice-example', 'person', 'A registered person.'], ['companies/acme-example', 'company', 'A registered company.']]) {
        await engine.putPage(slug, { type, title: slug, compiled_truth: body } as never, { sourceId });
        mkdirSync(join(root, slug.split('/')[0]), { recursive: true });
        writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown((await engine.getPage(slug, { sourceId }))!, []));
      }
      await registerLocalWriter(engine, 'cli');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const ctx = { engine, config: { engine: engine.kind }, remote: false, sourceId, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const body = 'A substantive meeting about the registered entities and their operating preferences. '.repeat(4);
      const content = ['---', 'type: meeting', 'title: Example meeting', '---', '', body].join('\n');
      await operationsByName.put_page.handler(ctx, { slug: 'meetings/example', content, request_id: randomUUID() });
      await disposePersistenceConsumer(engine);
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE kind<>'facts-backstop'");
      const [recorded] = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_effects WHERE source_id=$1 AND kind='facts-backstop'", [sourceId]);
      expect(recorded?.state).toBe('queued');
      const effect = (await claimPersistenceEffect(engine, localHostId()))!;
      expect(effect.kind).toBe('facts-backstop');
      await dispatchFactsBackstopEffect(engine, effect, localHostId());
      const [job] = await engine.executeRaw<{ id: number; data: Record<string, unknown> }>(
        "SELECT id,data FROM minion_jobs WHERE name='facts-absorb' AND data->>'sourceId'=$1", [sourceId]);
      expect(job).toBeDefined();
      chatCalls = 0;
      await run({ sourceId, job: { id: Number(job.id), data: job.data } });
    });
  } finally {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(home, { recursive: true, force: true });
  }
}

function jobContext(job: Fixture['job'], deadlineAtMs: number | null): MinionJobContext {
  const signal = new AbortController().signal;
  return { id: job.id, name: 'facts-absorb', data: job.data, attempts_made: 0, signal, deadlineAtMs, shutdownSignal: signal,
    updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] } as MinionJobContext;
}

const absorbRows = (sourceId: string) => engine.executeRaw<{ summary: string }>(
  "SELECT summary FROM ingest_log WHERE source_type='facts:absorb' AND source_id=$1 ORDER BY id", [sourceId]);
const factRequests = (sourceId: string) => engine.executeRaw<{ request_id: string; state: string }>(
  "SELECT request_id,state FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence", [sourceId]);

/** Stall every extract_facts publication at `consumer:prepared` until `release()`; `firstHit` is when the first one arrived. */
function stallFactsPublication() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = { firstHit: 0, release };
  installFaultHook(async (point, detail) => {
    if (point !== 'consumer:prepared' || detail.operation !== 'extract_facts') return;
    state.firstHit ||= performance.now();
    await gate;
  });
  return state;
}

async function waitUntil(pred: () => Promise<boolean>, ms: number): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await pred()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test('a facts write that commits 8 s after admission completes the job in one attempt; the worker renews its lock across the wait', async () => {
  await fixture('delayed', async ({ sourceId, job }) => {
    const stall = stallFactsPublication();
    // The shortest lease a job may carry (5 s, renewed every 2.5 s) and a 1 s stall sweep: a lock that stopped
    // renewing during the 8 s wait would expire and be reclaimed as stalled.
    await engine.executeRaw('UPDATE minion_jobs SET lock_duration_ms=5000 WHERE id=$1', [job.id]);
    const worker = new MinionWorker(engine, { queue: 'default', pollInterval: 50, stalledInterval: 1_000 });
    worker.register('facts-absorb', makeFactsAbsorbHandler(engine));
    const running = worker.start();
    const lockUntil = async () => (await engine.executeRaw<{ lock_until: Date | null }>('SELECT lock_until FROM minion_jobs WHERE id=$1', [job.id]))[0]?.lock_until;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await waitUntil(async () => stall.firstHit > 0, 30_000);
      expect(stall.firstHit).toBeGreaterThan(0);
      releaseTimer = setTimeout(stall.release, 8_000);
      await new Promise(resolve => setTimeout(resolve, 500));
      const early = await lockUntil();
      await new Promise(resolve => setTimeout(resolve, 6_000));
      const late = await lockUntil();
      expect(early).toBeInstanceOf(Date);
      expect(late).toBeInstanceOf(Date);
      expect(new Date(late!).getTime() - new Date(early!).getTime()).toBeGreaterThan(3_000);
      await waitUntil(async () => {
        const [row] = await engine.executeRaw<{ status: string }>('SELECT status FROM minion_jobs WHERE id=$1', [job.id]);
        return row?.status !== 'active' && row?.status !== 'waiting';
      }, 40_000);
      expect(performance.now() - stall.firstHit).toBeGreaterThanOrEqual(8_000);
    } finally {
      if (releaseTimer) clearTimeout(releaseTimer);
      stall.release();
      worker.stop();
      await running;
    }
    const [row] = await engine.executeRaw<{ status: string; attempts_started: number; attempts_made: number; stalled_counter: number; error_text: string | null }>(
      'SELECT status,attempts_started,attempts_made,stalled_counter,error_text FROM minion_jobs WHERE id=$1', [job.id]);
    expect(row).toMatchObject({ status: 'completed', attempts_started: 1, attempts_made: 0, stalled_counter: 0, error_text: null });
    expect(await absorbRows(sourceId)).toEqual([]);
    const requests = await factRequests(sourceId);
    expect(requests.length).toBe(3);
    expect(requests.every(r => r.state === 'committed')).toBe(true);
    expect(chatCalls).toBe(1);
  });
}, 90_000);

test('a job deadline bounds the publish wait; the pending write is logged as accepted with its receipt, and 19 such rows do not warn', async () => {
  await fixture('deadline', async ({ sourceId, job }) => {
    const stall = stallFactsPublication();
    let error: (Error & { code?: string; writeRequest?: { request_id: string; state: string } }) | null = null;
    try {
      error = await makeFactsAbsorbHandler(engine)(jobContext(job, Date.now() + 2_500)).then(() => null, (e: Error) => e);
      const waited = performance.now() - stall.firstHit;
      expect(stall.firstHit).toBeGreaterThan(0);
      expect(waited).toBeLessThan(4_000);
      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect(error?.code).toBe('write_pending');
      const pending = error!.writeRequest!;
      expect(['queued', 'running', 'recovering']).toContain(pending.state);
      const rows = await absorbRows(sourceId);
      expect(rows).toHaveLength(1);
      expect(rows[0].summary).toStartWith(`${WRITE_PENDING_ACCEPTED}: write_pending (OperationError)`);
      expect(rows[0].summary).toContain(pending.request_id);
      for (let i = 1; i < 19; i++) await writeFactsAbsorbFailure(engine, `meetings/example-${i}`, error, sourceId);
      const summaries = (await absorbRows(sourceId)).map(r => r.summary);
      expect(summaries).toHaveLength(19);
      expect(summaries.every(s => s.startsWith(`${WRITE_PENDING_ACCEPTED}:`))).toBe(true);
      const [check] = await factsExtractionEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[];
      expect(check.status).toBe('ok');
      expect(check.message).toContain(`${sourceId}: 19 ${WRITE_PENDING_ACCEPTED}`);
    } finally { stall.release(); }
    await waitUntil(async () => (await factRequests(sourceId)).every(r => r.state === 'committed'), 30_000);
    expect((await factRequests(sourceId)).map(r => r.state)).toEqual(['committed', 'committed', 'committed']);
    await engine.executeRaw("DELETE FROM ingest_log WHERE source_type='facts:absorb' AND source_id=$1", [sourceId]);
  });
}, 90_000);

test('a busy canonical writer before admission is logged as deferred, never as accepted, and the job retries', async () => {
  await fixture('contended', async ({ sourceId, job }) => {
    const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1_000))!;
    let error: (Error & { code?: string; writeRequest?: unknown }) | null;
    try {
      error = await makeFactsAbsorbHandler(engine)(jobContext(job, null)).then(() => null, (e: Error) => e);
    } finally { await lock.release(); }
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error?.code).toBe('writer_lock_unavailable');
    expect(error?.writeRequest).toBeUndefined();
    expect(chatCalls).toBe(0);
    expect(await factRequests(sourceId)).toEqual([]);
    const summaries = (await absorbRows(sourceId)).map(r => r.summary);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toStartWith(`${WRITE_DEFERRED_UNADMITTED}: writer_lock_unavailable (OperationError)`);
    expect(summaries.some(s => s.startsWith(`${WRITE_PENDING_ACCEPTED}:`))).toBe(false);
    await engine.executeRaw("DELETE FROM ingest_log WHERE source_type='facts:absorb' AND source_id=$1", [sourceId]);
  });
}, 90_000);

test('write_pending without a real nonterminal receipt keeps the write_refused label', async () => {
  const unknown = new OperationError('write_pending', 'The write is accepted and is still pending.');
  Object.assign(unknown, { writeRequest: { request_id: randomUUID(), state: 'queued' },
    receiptFields: { operation: 'extract_facts', source_id: 'default', slug: 'people/alice-example', principal_kind: 'local_cli', principal_id: randomUUID() } });
  await writeFactsAbsorbFailure(engine, 'notes/unreceipted', unknown, 'receipt-check');
  await writeFactsAbsorbFailure(engine, 'notes/no-receipt', new OperationError('write_pending', 'The write is accepted and is still pending.'), 'receipt-check');
  expect((await absorbRows('receipt-check')).map(r => r.summary.split(':')[0])).toEqual(['write_refused', 'write_refused']);
  await engine.executeRaw("DELETE FROM ingest_log WHERE source_type='facts:absorb' AND source_id='receipt-check'");
});
