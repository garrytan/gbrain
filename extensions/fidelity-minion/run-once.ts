import { loadConfig } from '../../src/core/config.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue, MinionWorker } from '../../src/core/minions/index.ts';
import { GUARDED_MAINTENANCE_CAPABILITY, probeLiveFullConsumer } from '../../src/core/persistence/consumer-heartbeat.ts';
import { hostIdFor } from '../../src/core/persistence/identity.ts';
import { readWriteSwitchSnapshot } from '../../src/core/persistence/switches.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { fidelityQueue, JOB, registerFidelityMinion } from './handler.ts';

// The native persistence coordinator recognizes the first positional command
// as a resident jobs producer and delegates to the healthy serve owner.
const [command, sourceId, topic, ...extra] = process.argv.slice(2);
const config = loadConfig();
if (command !== 'jobs' || extra.length || !sourceId || !topic || !/^[a-z0-9][a-z0-9-]*$/.test(topic) ||
    config?.engine !== 'postgres' || !config.database_url) {
  throw new Error('Usage: fidelity-minion jobs SOURCE TOPIC with a configured PostgreSQL brain');
}
const engine = new PostgresEngine();
await engine.connect({ database_url: config.database_url, poolSize: 6 });
const target = { sourceId, topic };
const name = fidelityQueue(target);
const queue = new MinionQueue(engine);
const worker = new MinionWorker(engine, { queue: name, pollInterval: 50 });
registerFidelityMinion(worker, engine, target);
let task: Promise<void> | undefined;
try {
  const { switches, preparation } = await readWriteSwitchSnapshot(engine);
  const owner = await probeLiveFullConsumer(engine, hostIdFor(engine), undefined, { ceilingMs: preparation.ceilingMs });
  if (!switches.single_consumer || owner?.kind !== 'serve' || owner.mode !== 'full' || !owner.capabilities?.includes(GUARDED_MAINTENANCE_CAPABILITY)) {
    throw new Error('Fidelity Minion requires a healthy HTTP Serve owner with guarded maintenance support');
  }
  task = worker.start();
  const job = await queue.add(JOB, target, { queue: name, max_attempts: 1, timeout_ms: 25000 });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await queue.getJob(job.id);
    if (result && ['completed', 'failed', 'dead', 'cancelled'].includes(result.status)) {
      console.log(JSON.stringify({ id: result.id, status: result.status, result: result.result, error: result.error_text }));
      const outcome = result.result?.status;
      process.exitCode = result.status === 'completed' && (outcome === 'published' || outcome === 'unchanged') ? 0 : 1;
      break;
    }
    await Bun.sleep(100);
  }
  if (Date.now() >= deadline) throw new Error(`Job ${job.id} did not settle`);
} finally {
  worker.stop();
  await task;
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
}
