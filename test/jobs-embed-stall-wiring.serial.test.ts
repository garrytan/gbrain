/**
 * #4599 (X6) — the `embed` Minion handler must FAIL THE JOB when the embed
 * result carries reason 'stall_timeout'.
 *
 * The contract: core returns an error RESULT (never process.exit below the
 * CLI layer); the handler layer converts it into a thrown error via
 * `assertEmbedNotStalled` so the queue marks the job failed and schedulers
 * can classify/back off. Deleting the assertEmbedNotStalled call in
 * src/commands/jobs.ts's `embed` handler makes the stalled job return
 * "success" — this suite fails in that world.
 *
 * Handler-level: invokes the REAL registered handler (registerBuiltinHandlers
 * → worker.handlers), mocking only runEmbedCore (module mock — hence
 * .serial.test.ts per docs/TESTING.md).
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

// Bind the real module first so the mock preserves every other export the
// jobs registry (or sibling handlers) may reach for.
const realEmbed = await import('../src/commands/embed.ts');
let nextEmbedResult: Record<string, unknown> = {};
mock.module('../src/commands/embed.ts', () => ({
  ...realEmbed,
  runEmbedCore: async () => nextEmbedResult,
}));

const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { MinionWorker } = await import('../src/core/minions/worker.ts');
const { registerBuiltinHandlers } = await import('../src/commands/jobs.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let handler: (job: unknown) => Promise<Record<string, unknown>>;

function baseEmbedResult(): Record<string, unknown> {
  return {
    embedded: 7,
    skipped: 0,
    would_embed: 0,
    total_chunks: 7,
    pages_processed: 2,
    failures: 0,
    failure_samples: [],
    dryRun: false,
    chunkless_pages_healed: 0,
  };
}

function fakeJob(data: Record<string, unknown>): Record<string, unknown> {
  const controller = new AbortController();
  return {
    id: 1,
    name: 'embed',
    data,
    attempts_made: 0,
    signal: controller.signal,
    deadlineAtMs: null,
    shutdownSignal: controller.signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const worker = new MinionWorker(engine, { concurrency: 1 });
  await registerBuiltinHandlers(worker, engine);
  const registered = (worker as unknown as {
    handlers: Map<string, (j: unknown) => Promise<Record<string, unknown>>>;
  }).handlers.get('embed');
  if (!registered) throw new Error('embed handler not registered');
  handler = registered;
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('embed Minion handler — stall_timeout fails the job (#4599 X6)', () => {
  test("reason: 'stall_timeout' → the handler THROWS (job marked failed)", async () => {
    nextEmbedResult = { ...baseEmbedResult(), failures: 1, reason: 'stall_timeout' };

    await expect(handler(fakeJob({ stale: true }))).rejects.toThrow(/stall_timeout/);
  });

  test('the thrown error carries the banked progress for operator triage', async () => {
    nextEmbedResult = { ...baseEmbedResult(), failures: 1, reason: 'stall_timeout' };

    await expect(handler(fakeJob({ stale: true }))).rejects.toThrow(/embedded=7/);
  });

  test('control: a clean result (no reason) resolves with the embed report', async () => {
    nextEmbedResult = baseEmbedResult();

    const res = await handler(fakeJob({ stale: true }));
    expect(res.embedded).toBe(7);
    expect(res.dry_run).toBe(false);
    expect(res.failures).toBe(0);
  });
});
