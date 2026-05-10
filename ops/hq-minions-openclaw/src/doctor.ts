import type { AppConfig } from './config.ts';
import { openEngine } from './gbrain.ts';

export type DoctorCheck = {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
};

export async function runDoctor(config: AppConfig): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];

  if (config.databaseUrl.startsWith('postgresql://') || config.databaseUrl.startsWith('postgres://')) {
    checks.push({ name: 'engine', status: 'ok', message: 'Postgres database URL configured.' });
  } else {
    checks.push({ name: 'engine', status: 'fail', message: 'This package requires Postgres for persistent Minions worker operation.' });
  }

  if (process.env.GBRAIN_ALLOW_SHELL_JOBS === '1') {
    checks.push({ name: 'shell_jobs', status: 'fail', message: 'GBRAIN_ALLOW_SHELL_JOBS=1 is not allowed for this package.' });
  } else {
    checks.push({ name: 'shell_jobs', status: 'ok', message: 'Shell jobs disabled.' });
  }

  let engine: Awaited<ReturnType<typeof openEngine>> | null = null;
  try {
    engine = await openEngine(config);
    await engine.executeRaw('SELECT 1', []);
    checks.push({ name: 'connection', status: 'ok', message: 'Database connection ok.' });

    const tables = await engine.executeRaw<{ name: string; exists: boolean }>(
      `SELECT name, to_regclass(name) IS NOT NULL AS exists
       FROM (VALUES ('minion_jobs'), ('minion_inbox'), ('minion_attachments')) AS t(name)`,
      []
    );
    for (const row of tables) {
      checks.push({
        name: `table_${row.name}`,
        status: row.exists ? 'ok' : 'fail',
        message: row.exists ? `${row.name} exists.` : `${row.name} missing. Run gbrain init --url and migrations.`
      });
    }

    const columns = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'minion_jobs'
         AND column_name IN ('quiet_hours', 'stagger_key')`,
      []
    );
    const have = new Set(columns.map(c => c.column_name));
    for (const col of ['quiet_hours', 'stagger_key']) {
      checks.push({
        name: `column_${col}`,
        status: have.has(col) ? 'ok' : 'fail',
        message: have.has(col)
          ? `minion_jobs.${col} exists.`
          : `minion_jobs.${col} missing. Run/fix GBrain migrations before starting worker.`
      });
    }
  } catch (error) {
    checks.push({
      name: 'database',
      status: 'fail',
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (engine) await engine.disconnect().catch(() => undefined);
  }

  try {
    await import('gbrain/minions');
    checks.push({ name: 'minions_export', status: 'ok', message: 'Imported gbrain/minions.' });
  } catch {
    try {
      await import('../../../src/core/minions/index.ts');
      checks.push({ name: 'minions_export', status: 'ok', message: 'Imported local src/core/minions fallback.' });
    } catch (error) {
      checks.push({
        name: 'minions_export',
        status: 'fail',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    ok: checks.every(c => c.status !== 'fail'),
    checks
  };
}
