import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { assertWorkerDbReadiness } from '../../src/core/minions/db-probe.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import postgres from '#postgres';
import pkg from '../../package.json';
import driverPackage from '../../vendor/postgres/package.json';

const url = process.env.DATABASE_URL;
assert(url, 'An explicit disposable DATABASE_URL is required');
assertSafeE2eDatabaseUrl(url);
const started = performance.now();
const engine = new PostgresEngine();
await engine.connect({ database_url: url, poolSize: 2 });
let worker: MinionWorker | undefined;
let running: Promise<void> | undefined;
try {
  await assertWorkerDbReadiness(engine);
  const readinessMs = performance.now() - started;
  const controller = new AbortController();
  const cancelling = engine.executeRaw('SELECT pg_sleep(10)', [], { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(cancelling);
  } finally { clearTimeout(timer); }
  assert.equal((await engine.executeRaw<{ n: number }>('SELECT 42::int AS n', [], { signal: new AbortController().signal }))[0]?.n, 42);
  await engine.initSchema();
  const queueName = `driver-smoke-${randomUUID()}`;
  const queue = new MinionQueue(engine);
  await queue.ensureSchema();
  const job = await queue.add('driver-smoke', {}, { queue: queueName });
  worker = new MinionWorker(engine, { queue: queueName, concurrency: 1, pollInterval: 10, maxRssMb: 0, jobIsolation: 'inline' });
  let handled = 0;
  worker.register('driver-smoke', async () => { handled++; return { smoke: true }; });
  running = worker.start();
  const deadline = performance.now() + 20_000;
  let completed = await queue.getJob(job.id);
  while (completed?.status !== 'completed' && performance.now() < deadline) {
    await Bun.sleep(20);
    completed = await queue.getJob(job.id);
  }
  assert.equal(completed?.status, 'completed');
  assert.equal(handled, 1);
  assert.equal(completed?.stalled_counter, 0);
  const driver = postgres(url, { max: 1 });
  try {
    const owner = await driver.reserve();
    assert.equal(typeof owner.discard, 'function');
    owner.release();
  } finally { await driver.end({ timeout: 1 }); }
  console.log(JSON.stringify({ ok: true, gbrain_version: pkg.version, driver_version: driverPackage.version, runtime: Bun.version, platform: `${process.platform}-${process.arch}`, readiness_ms: readinessMs, total_ms: performance.now() - started, job_status: completed.status, handled, attempts_made: completed.attempts_made, stall_count: completed.stalled_counter }));
} finally {
  worker?.stop();
  await running;
  await engine.disconnect();
}
