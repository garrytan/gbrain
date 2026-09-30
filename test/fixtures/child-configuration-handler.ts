import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { runChildReadinessEntry } from '../../src/core/minions/child-readiness.ts';
import { assertWorkerDbReadiness } from '../../src/core/minions/db-probe.ts';
import { runChildJobEntry } from '../../src/core/minions/run-child.ts';
import { LocalConfigurationError } from '../../src/core/minions/configuration-error.ts';

const engine = new PGLiteEngine();
await engine.connect({ database_url: '' });
let code = 1;
try {
  if (process.argv.includes('child-readiness')) {
    code = await runChildReadinessEntry(engine, assertWorkerDbReadiness);
  } else {
    await engine.initSchema();
    const queue = new MinionQueue(engine);
    const token = process.env.GBRAIN_JOB_LOCK_TOKEN!;
    const job = await queue.add('sync', {});
    await queue.claim(token, 30_000, 'default', ['sync']);
    code = await runChildJobEntry(engine, {
      jobId: job.id, lockToken: token, resultPath: process.env.GBRAIN_JOB_RESULT_PATH!, parentPid: 0,
    }, {
      resolveHandler: () => async () => { throw new LocalConfigurationError('postgres_cancellation_unavailable', 'fixture capability failure'); },
    });
  }
} finally { await engine.disconnect(); }
process.exit(code);
