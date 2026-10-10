/**
 * Forced probe: a request answers while a large effects backlog drains.
 *
 * Protects: a freshly imported PGLite brain carried ~47k queued embedding
 * effects whose chunks `embed --stale` had already embedded. The serve
 * consumer drained them one claim at a time, and PGLite resolves its queries
 * as one microtask chain, so stdin was not read until the drain ended: the
 * first tool call took 230-290 s. Now no-op embedding effects settle in bulk
 * and the drain yields to the event loop between batches, so a tool call
 * issued at any point of the drain answers within DRAIN_ANSWER_BOUND_MS.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { installPageEmbeddings, installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { withEnv } from './helpers/with-env.ts';

/** Queued no-op embedding effects in the backlog (the 55k brain carried 46,685). */
const BACKLOG = 8_000;
/** Every tool call during the drain answers within this. Before the fix one waited for the whole drain. */
const DRAIN_ANSWER_BOUND_MS = 2_000;
const MODEL = 'openai:text-embedding-3-small';

describe('effects drain latency (PGLite)', () => {
  let engine: PGLiteEngine;
  let scratch: string;
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'gbrain-drain-latency-'));
    configureGateway({ embedding_model: MODEL, embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-not-used' } });
    engine = new PGLiteEngine();
    await engine.connect({ database_path: join(scratch, 'brain') }); await engine.initSchema();
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine?.disconnect();
    resetGateway();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  /** One embedded page whose embedding effect is a no-op, cloned into BACKLOG queued requests and effects. */
  async function backlog(): Promise<string> {
    await registerLocalWriter(engine, 'cli');
    const sourceId = 'default';
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
    const slug = 'notes/backlog';
    const authority = await submissionAuthority(ctx, 'put_page', sourceId, source.incarnation, slug);
    await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
      sourceIncarnation: source.incarnation, slug, requestId: randomUUID(), callerIntent: { body: 'b' }, intent: { body: 'b' } });
    const row = (await claimNextWrite(engine, localHostId()))!;
    await publishMutation(engine, row, { observedRevision: null, apply: async tx => {
      await tx.putPage(slug, { type: 'note', title: 'Backlog', compiled_truth: 'Widget Co renewal notes.', timeline: '', frontmatter: {} }, { sourceId }); return {};
    } }, localHostId());
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
    await installPageProjection(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Widget Co renewal notes.' }], { seal: true });
    const sealed = (await readProjectionSnapshot(engine, slug, sourceId))!;
    expect(await installPageEmbeddings(engine, sealed, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Widget Co renewal notes.',
      embedding: new Float32Array(1536).fill(0.1), model: MODEL }], `${MODEL}:1536`)).toBe(true);
    await engine.executeRaw("UPDATE persistence_effects SET state='committed', outcome='{}'::jsonb WHERE kind<>'embedding'");
    // Clone the committed request and its queued no-op effect: every clone is its own request, as an import leaves them.
    const columns = async (table: string, skip: string[]) => (await engine.executeRaw<{ c: string }>(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_name=$1 AND table_schema='public' ORDER BY ordinal_position`, [table]))
      .map(r => r.c).filter(c => !skip.includes(c));
    const requestCols = await columns('persistence_requests', ['id', 'request_id', 'sequence']);
    const effectCols = await columns('persistence_effects', ['id', 'request_id']);
    await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
      await tx.executeRaw(`CREATE TEMP TABLE clone_ids ON COMMIT DROP AS SELECT gen_random_uuid() AS id, gen_random_uuid() AS request_id FROM generate_series(1,${BACKLOG})`);
      await tx.executeRaw(`INSERT INTO persistence_requests (id, request_id, ${requestCols.join(',')})
        SELECT c.id, c.request_id, ${requestCols.map(col => `r.${col}`).join(',')} FROM clone_ids c CROSS JOIN persistence_requests r WHERE r.id=$1::uuid`, [row.id]);
      await tx.executeRaw(`INSERT INTO persistence_effects (request_id, ${effectCols.join(',')})
        SELECT c.id, ${effectCols.map(col => `e.${col}`).join(',')} FROM clone_ids c CROSS JOIN persistence_effects e WHERE e.request_id=$1::uuid AND e.kind='embedding'`, [row.id]);
    });
    const [{ n }] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE kind='embedding' AND state='queued'");
    expect(n).toBe(BACKLOG + 1);
    return slug;
  }

  test(`a tool call answers within ${DRAIN_ANSWER_BOUND_MS} ms while ${BACKLOG} no-op embedding effects drain`, () => withEnv({ GBRAIN_HOME: scratch }, async () => {
    const slug = await backlog();
    // A CLI process (which may print --json on stdout) never writes the drain notice; only serve does.
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const notices: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
      if (String(chunk).includes('phase=effects_drain')) notices.push(String(chunk));
      return stderrWrite(chunk, ...rest);
    }) as typeof process.stderr.write;
    const consumer = startPersistenceConsumer(engine, { engine: 'pglite' });
    consumer.wake();
    // A client calls a tool every 50 ms while the backlog drains: no call may wait past the bound, and neither may
    // the event loop (the gap between one call's answer and the next call starting).
    const queued = async () => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE kind='embedding' AND state<>'committed'"))[0]!.n;
    let worstAnswerMs = 0, worstGapMs = 0, calls = 0, callsDuringDrain = 0;
    const deadline = Date.now() + 120_000;
    try {
      for (let pending = await queued(); pending > 0 && Date.now() < deadline; pending = await queued()) {
        const started = performance.now();
        const answer = await dispatchToolCall(engine, 'get_page', { slug }, { remote: false, sourceId: 'default', config: { engine: 'pglite' } } as never);
        expect(answer.isError).toBeFalsy();
        worstAnswerMs = Math.max(worstAnswerMs, performance.now() - started);
        calls++;
        if (pending < BACKLOG + 1) callsDuringDrain++;
        const slept = performance.now();
        await Bun.sleep(50);
        worstGapMs = Math.max(worstGapMs, performance.now() - slept - 50);
      }
    } finally { process.stderr.write = stderrWrite; }
    console.log(JSON.stringify({ backlog: BACKLOG, calls, calls_during_drain: callsDuringDrain, worst_answer_ms: Math.round(worstAnswerMs), worst_loop_gap_ms: Math.round(worstGapMs) }));
    expect(await queued()).toBe(0);
    expect(callsDuringDrain).toBeGreaterThan(0);
    expect(notices).toEqual([]);
    expect({ worstAnswerMs: Math.round(worstAnswerMs), within: worstAnswerMs < DRAIN_ANSWER_BOUND_MS }).toMatchObject({ within: true });
    expect({ worstGapMs: Math.round(worstGapMs), within: worstGapMs < DRAIN_ANSWER_BOUND_MS }).toMatchObject({ within: true });
    // Every effect settled exactly once.
    const [{ attempts }] = await engine.executeRaw<{ attempts: number }>("SELECT max(attempts)::int AS attempts FROM persistence_effects WHERE kind='embedding'");
    expect(attempts).toBe(1);
  }), 180_000);
});
