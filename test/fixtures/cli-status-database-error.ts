/** Child-only fault seam: terminate a real PostgreSQL read inside the command's error boundary. */
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runPersistenceAdminCli } from '../../src/commands/persistence-admin.ts';
import { runJobsStats } from '../../src/commands/jobs/stats.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { installStdoutPipeDelivery, finishCliTeardown } from '../../src/core/cli-force-exit.ts';
import { writeFatalCliError } from '../../src/cli/cli-error.ts';

installStdoutPipeDelivery(process.argv.includes('--json') ? { json: 'document' } : {});
const engine = new PostgresEngine();
await engine.connect({ database_url: process.env.DATABASE_URL!, poolSize: 1 });
const args = process.argv.slice(2);
try {
  if (args[0] === 'sources') {
    const original = engine.executeRaw;
    let fired = false;
    engine.executeRaw = async function (this: PostgresEngine, ...input: Parameters<typeof original>) {
      if (!fired) { fired = true; await original.call(this, 'SELECT pg_terminate_backend(pg_backend_pid())'); }
      return original.call(this, ...input);
    } as typeof original;
    try { await runPersistenceAdminCli('writer', args.slice(2), engine); }
    finally { engine.executeRaw = original; }
  } else {
    const queue = new MinionQueue(engine);
    const original = queue.getStats;
    queue.getStats = async function () {
      await engine.executeRaw('SELECT pg_terminate_backend(pg_backend_pid())');
      return original.call(this);
    };
    try { await runJobsStats({ args: args.slice(1), engine, engineOrNull: engine, queue }); }
    finally { queue.getStats = original; }
  }
} catch (error) { process.exitCode = writeFatalCliError(error); }
finally { await finishCliTeardown({ engine, drainTimeoutMs: 1000 }); }
