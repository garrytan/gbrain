/**
 * Child process for `test/e2e/repair-stuck-recovery-postgres.test.ts` (#6650): runs one
 * `gbrain repair stuck-recovery` apply against a Postgres test database and blocks at the named fault seam, so the
 * parent can SIGKILL it there while it holds the worktree lock and the journal is mid-step.
 * Prints one JSON line per event on stdout: `{event:'boundary', point}` or `{event:'done', outcomes}` / `{event:'failure', message}`.
 */
import { readFileSync } from 'node:fs';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { installFaultHook, type FaultPoint } from '../../src/core/persistence/fault-points.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';

interface WorkerConfig { databaseUrl: string; sourceId: string; hash: string; keep: 'prior' | 'disk'; point: FaultPoint }
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (import.meta.main) {
  const config: WorkerConfig = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
  const engine = new PostgresEngine();
  try {
    await engine.connect({ database_url: config.databaseUrl, poolSize: 2 });
    installFaultHook(async point => {
      if (point !== config.point) return;
      emit({ event: 'boundary', point });
      await new Promise(() => {});
    });
    const runner = await repairRunner(engine, { apply: true });
    const result = await runner.run('stuck-recovery', await resolveRepairScope(engine, config.sourceId),
      { sourceFlag: config.sourceId, explicit: true, expect: config.hash, keep: config.keep });
    emit({ event: 'done', outcomes: result.outcomes ?? {} });
    await engine.disconnect();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown worker failure';
    emit({ event: 'failure', message: message.replaceAll(config.databaseUrl, '[test database]') });
    process.exit(1);
  }
}
