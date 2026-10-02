/**
 * #5157 restored-operation journey (CEO-A4, DX-O3(f)(g), DX-O15(a)), shared
 * by the PGLite unit test and the Postgres E2E test.
 *
 * A brain upgraded across v0.50 holds terminal and live legacy keyed rows,
 * an unkeyed live SQL NULL row and an active row the upgrade orphaned.
 * Terminal rows need no operator step. `POST /ingest` returns 409 with a
 * hint; the journey then runs the commands the product prints, verbatim,
 * through the real `gbrain jobs` dispatcher, counts them, and proves
 * restored operation: `/ingest` returns 202, a worker starts and completes
 * the queued synthesize and ingest work, and `search` finds the memory.
 */
import { expect } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrainEngine } from '../../src/core/engine.ts';
import { mountWebhooks } from '../../src/commands/serve-http-webhooks.ts';
import type { ServeHttpContext } from '../../src/commands/serve-http.ts';
import { runJobs } from '../../src/commands/jobs.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import { makeIngestCaptureHandler } from '../../src/core/minions/handlers/ingest-capture.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { assertNoUnreviewedJobs } from '../../src/core/minions/submission-authority.ts';
import { legacyJobAuthorityCheck } from '../../src/commands/doctor/checks/legacy-job-authority.ts';
import { operations } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';

export const JOURNEY_CLIENT = 'journey-client';

/** A minimal `gbrain serve --http` stand-in: the real /ingest route on an ephemeral port. */
export async function startIngestServer(engine: BrainEngine): Promise<{ base: string; stop(): Promise<void> }> {
  const app = express();
  const pass: express.RequestHandler = (_req, _res, next) => next();
  mountWebhooks(app, {
    engine,
    resourceVerifier: {
      verifyAccessToken: async (token: string) => ({ token, clientId: JOURNEY_CLIENT, clientName: 'example-client', scopes: ['read', 'write'], sourceId: 'default', expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
    },
    resourceMetadataUrl: 'http://127.0.0.1/.well-known/oauth-protected-resource',
    ingestRateLimiter: pass,
    githubWebhookLimiter: pass,
    broadcastEvent: () => {},
  } as unknown as ServeHttpContext);
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

export function postIngest(base: string, content: string) {
  return fetch(`${base}/ingest`, { method: 'POST', headers: { authorization: 'Bearer test-only', 'content-type': 'text/markdown' }, body: content });
}

/** Splits one printed `gbrain ...` command into argv, honoring double quotes. */
export function argv(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]!);
}

/** Runs a printed `gbrain jobs …` command verbatim through the real dispatcher. */
export async function runPrinted(engine: BrainEngine, command: string): Promise<{ out: string; err: string; exit: number }> {
  const args = argv(command);
  expect(args.slice(0, 2)).toEqual(['gbrain', 'jobs']);
  const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  _resetCliExitVerdictForTests();
  try { await runJobs(engine, args.slice(2)); } finally { console.log = log; console.error = error; }
  const exit = currentExitCode();
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
  return { out: out.join('\n'), err: err.join('\n'), exit };
}

/** Rewrites rows to what an upgrade across v0.50 leaves behind (the protocol trigger forbids inserting them). */
async function legacy(engine: BrainEngine, id: number, status?: string): Promise<void> {
  if (status === 'active') {
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'active', lock_token = 'pre-upgrade', lock_until = now() + interval '1 hour',
      claim_generation = claim_generation + 1 WHERE id = $1`, [id]);
  } else if (status) {
    await engine.executeRaw('UPDATE minion_jobs SET status = $2 WHERE id = $1', [id, status]);
  }
  await engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL WHERE id = $1', [id]);
}

async function drain(engine: BrainEngine, ids: number[]): Promise<Record<number, string>> {
  const queue = new MinionQueue(engine);
  const worker = new MinionWorker(engine, { pollInterval: 10, healthCheckInterval: 0, stalledInterval: 60_000 });
  worker.register('ingest_capture', makeIngestCaptureHandler(engine));
  worker.register('synthesize', async () => ({ synthesized: true }));
  const running = worker.start();
  const statuses = async () => Object.fromEntries(await Promise.all(ids.map(async id => [id, (await queue.getJob(id))?.status ?? 'missing'])));
  for (let i = 0; i < 400; i++) {
    if (Object.values(await statuses()).every(status => status === 'completed' || status === 'failed')) break;
    await new Promise(r => setTimeout(r, 25));
  }
  worker.stop();
  await running;
  return statuses();
}

export interface JourneyResult { commands: string[] }

/** `gbrain search <query>` through the search operation, as a trusted local caller; returns hit slugs. */
async function searchSlugs(engine: BrainEngine, query: string): Promise<string[]> {
  const op = operations.find(o => o.name === 'search')!;
  const ctx: OperationContext = { engine, config: {} as OperationContext['config'], dryRun: false, remote: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } };
  const result = await op.handler(ctx, { query }) as unknown;
  const rows = (Array.isArray(result) ? result : (result as { results?: unknown[] }).results ?? []) as Array<{ slug?: string }>;
  return rows.map(row => String(row.slug));
}

export async function runLegacyJourney(engine: BrainEngine): Promise<JourneyResult> {
  const queue = new MinionQueue(engine);
  const trusted = { allowProtectedSubmit: true };
  const content = '# Journey capture\n\nThe zebra-journey-marker note survives the v0.50 upgrade.';

  // The capture was queued before the upgrade: its row holds the capture's key.
  let serve = await startIngestServer(engine);
  const first = await postIngest(serve.base, content);
  expect(first.status).toBe(202);
  const captureId = (await first.json() as { job_id: number }).job_id;
  await legacy(engine, captureId);
  const completed = await queue.add('synthesize', { day: 1 }, { idempotency_key: 'dream:synth-v2:journey-done' }, trusted);
  await legacy(engine, completed.id, 'completed');
  const dead = await queue.add('synthesize', { day: 2 }, { idempotency_key: 'dream:synth-v2:journey-dead' }, trusted);
  await legacy(engine, dead.id, 'dead');
  const unkeyed = await queue.add('synthesize', { day: 3 }, {}, trusted);
  await legacy(engine, unkeyed.id);
  const orphan = await queue.add('embed', { orphaned: true });
  await legacy(engine, orphan.id, 'active');

  // Terminal legacy keys need no operator step for application callers.
  expect((await queue.add('synthesize', { day: 1 }, { idempotency_key: 'dream:synth-v2:journey-done' }, trusted)).id).toBe(completed.id);
  const resubmitted = await queue.add('synthesize', { day: 2 }, { idempotency_key: 'dream:synth-v2:journey-dead' }, trusted);
  expect(resubmitted.id).not.toBe(dead.id);

  // Live rows: doctor names the recovery, workers are blocked, and /ingest says 409, never 500.
  expect((await legacyJobAuthorityCheck(engine)).status).toBe('fail');
  await expect(assertNoUnreviewedJobs(engine)).rejects.toThrow('legacy jobs');
  const refused = await postIngest(serve.base, content);
  expect(refused.status).toBe(409);
  const body = await refused.json() as { error: string; hint: string; docs_url: string };
  expect(body.error).toBe('permission_denied');
  expect(body.docs_url).toBe('docs/guides/repair.md#legacy-job-authority');

  const commands: string[] = [];
  // 1. Stop producers and workers: the hint's first instruction.
  expect(body.hint).toStartWith('Stop producers (gbrain serve, gbrain autopilot) and workers');
  await serve.stop();
  commands.push('stop gbrain serve');
  // 2. Cancel the active job the hint names.
  const cancel = /cancel active jobs \((gbrain jobs cancel \d+)\)/.exec(body.hint)?.[1];
  expect(cancel).toBe(`gbrain jobs cancel ${orphan.id}`);
  expect((await runPrinted(engine, cancel!)).exit).toBe(0);
  commands.push(cancel!);
  // 3. Preview with the hint's filled --select.
  const preview = /preview with (gbrain jobs authorize-legacy --select "[^"]+")/.exec(body.hint)?.[1];
  expect(preview).toBe('gbrain jobs authorize-legacy --select "status=waiting|delayed|waiting-children|paused"');
  const previewed = await runPrinted(engine, preview!);
  expect(previewed.exit).toBe(0);
  expect(previewed.out).toContain('(SQL NULL authority, authorizable): 2');
  commands.push(preview!);
  // 4. Apply with the printed --expect.
  const apply = /Apply exactly this set: (.+)$/m.exec(previewed.out)?.[1];
  expect(apply).toMatch(/--expect [a-f0-9]{64} --yes$/);
  expect((await runPrinted(engine, apply!)).exit).toBe(0);
  commands.push(apply!);
  // 5. Restart serve.
  serve = await startIngestServer(engine);
  commands.push('restart gbrain serve');

  await assertNoUnreviewedJobs(engine);
  expect((await legacyJobAuthorityCheck(engine)).status).toBe('ok');
  const accepted = await postIngest(serve.base, content);
  expect(accepted.status).toBe(202);
  expect((await accepted.json() as { job_id: number }).job_id).toBe(captureId);
  await serve.stop();

  // A worker starts and completes the queued synthesize and capture work.
  const statuses = await drain(engine, [captureId, unkeyed.id, resubmitted.id]);
  expect(statuses).toEqual({ [captureId]: 'completed', [unkeyed.id]: 'completed', [resubmitted.id]: 'completed' });

  // 6. search finds the ingested memory.
  const hits = await searchSlugs(engine, 'zebra-journey-marker');
  commands.push('gbrain search zebra-journey-marker');
  expect(hits.some(slug => slug.startsWith('inbox/'))).toBe(true);
  expect(commands.length).toBeLessThanOrEqual(6);
  return { commands };
}

/**
 * DX-O3(g): an unsupported non-NULL row keeps workers blocked after the
 * SQL NULL rows are authorized; its own printed step (local cancel) clears
 * it and a worker starts.
 */
export async function runUnsupportedRowRecovery(engine: BrainEngine): Promise<string[]> {
  const queue = new MinionQueue(engine);
  const trusted = { allowProtectedSubmit: true };
  const legacyRow = await queue.add('synthesize', { day: 4 }, {}, trusted);
  await legacy(engine, legacyRow.id);
  const future = await queue.add('synthesize', { day: 5 }, {}, trusted);
  await engine.executeRaw(`UPDATE minion_jobs SET submission_authority = '{"version":2,"kind":"application"}'::jsonb WHERE id = $1`, [future.id]);

  const doctor = await legacyJobAuthorityCheck(engine);
  const commands: string[] = [];
  const preview = /preview with (gbrain jobs authorize-legacy --select "[^"]+")/.exec(doctor.message)![1]!;
  const previewed = await runPrinted(engine, preview);
  expect(previewed.out).toContain(`Unsupported non-NULL authority (not authorizable; cancel locally): ${future.id}`);
  commands.push(preview);
  const apply = /Apply exactly this set: (.+)$/m.exec(previewed.out)![1]!;
  expect((await runPrinted(engine, apply)).exit).toBe(0);
  commands.push(apply);
  await expect(assertNoUnreviewedJobs(engine)).rejects.toThrow('1 legacy jobs');
  const cancel = new RegExp(`gbrain jobs cancel ${future.id}\\b`).exec(doctor.message)![0];
  expect((await runPrinted(engine, cancel)).exit).toBe(0);
  commands.push(cancel);
  await assertNoUnreviewedJobs(engine);
  expect(await drain(engine, [legacyRow.id])).toEqual({ [legacyRow.id]: 'completed' });
  return commands;
}
