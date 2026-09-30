import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig } from '../../../src/core/config.ts';
import { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { LocalConfigurationError } from '../../../src/core/minions/configuration-error.ts';
import { runChildReadinessEntry } from '../../../src/core/minions/child-readiness.ts';
import { assertWorkerDbReadiness } from '../../../src/core/minions/db-probe.ts';
import { CHILD_ENV } from '../../../src/core/minions/job-isolation.ts';
import { runChildJobEntry } from '../../../src/core/minions/run-child.ts';
import { assertSafeE2eDatabaseUrl } from '../../helpers/db-guard.ts';

const databaseUrl = loadConfig()?.database_url;
if (!databaseUrl) throw new Error('The isolated configuration fixture requires a test database');
assertSafeE2eDatabaseUrl(databaseUrl);
const trace = process.env.GBRAIN_TEST_CHILD_TRACE;
const queueName = process.env.GBRAIN_TEST_CHILD_QUEUE;
if (!trace || !queueName) throw new Error('The isolated configuration fixture requires its trace and queue');
const engine = new PostgresEngine();
await engine.connect({ database_url: databaseUrl, poolSize: 1 });
let code: number;
try {
  if (process.argv.includes('child-readiness')) {
    code = await runChildReadinessEntry(engine, assertWorkerDbReadiness);
    const jobs = await engine.executeRaw<{ id: number; status: string; attempts_started: number }>(
      'SELECT id, status, attempts_started FROM minion_jobs WHERE queue = $1 ORDER BY id', [queueName],
    );
    appendFileSync(trace, JSON.stringify({ kind: 'readiness', code, pid: process.pid, jobs }) + '\n');
  } else {
    const jobId = Number(process.argv[process.argv.indexOf('--job-id') + 1]);
    code = await runChildJobEntry(engine, {
      jobId,
      lockToken: process.env[CHILD_ENV.lockToken]!,
      resultPath: process.env[CHILD_ENV.resultPath]!,
      parentPid: Number(process.env[CHILD_ENV.parentPid]),
    }, {
      resolveHandler: name => name === 'orphans' ? async context => {
        let descendantPid: number | undefined;
        if (process.env.GBRAIN_TEST_CHILD_MODE === 'success-with-live-descendant') {
          const descendant = spawn(process.execPath, ['--no-env-file', '-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          await new Promise<void>((resolve, reject) => {
            descendant.once('spawn', resolve);
            descendant.once('error', reject);
          });
          descendantPid = descendant.pid;
          descendant.unref();
        }
        appendFileSync(trace, JSON.stringify({
          kind: 'handler', id: context.id, pid: process.pid,
          parentPid: Number(process.env[CHILD_ENV.parentPid]),
          lockToken: process.env[CHILD_ENV.lockToken],
          ...(descendantPid ? { descendantPid } : {}),
        }) + '\n');
        if (descendantPid) return { fixtureSuccess: true };
        throw new LocalConfigurationError('postgres_cancellation_unavailable', 'Isolated handler fixture cancellation fault');
      } : undefined,
    });
  }
} finally {
  await engine.disconnect();
}
process.exit(code);
