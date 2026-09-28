import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

describe('supervisor status without a database connection', () => {
  test('the no-pidfile database fallback does not run migrations', async () => {
    const home = mkdtempSync(join(tmpdir(), 'supervisor-status-no-migrate-'));
    const dataDir = join(home, '.gbrain', 'brain.pglite');
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dataDir }));
      const result = await runCli(['jobs', 'supervisor', 'status', '--pid-file', join(home, 'absent.pid'), '--json'], { home, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).running).toBe(false);
      const db = await PGlite.create({ dataDir, extensions: { vector, pg_trgm } });
      try {
        const tables = await db.query<{ pages: string | null }>("SELECT to_regclass('public.pages')::text AS pages");
        expect(tables.rows[0]?.pages).toBeNull();
      } finally { await db.close(); }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 40_000);

  test('a locally live owner remains inspectable while its database is unavailable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'supervisor-offline-status-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
        engine: 'postgres',
        database_url: 'postgresql://127.0.0.1:1/gbrain_test',
      }));
      const pidFile = join(home, 'supervisor.pid');
      writeFileSync(pidFile, `${process.pid}\n`);
      const result = await runCli(['jobs', 'supervisor', 'status', '--pid-file', pidFile, '--json'], {
        home,
        timeoutMs: 10_000,
        env: { GBRAIN_AUDIT_DIR: join(home, 'audit') },
      });
      expect(result.exitCode).toBe(0);
      const status = JSON.parse(result.stdout);
      expect(status.running).toBe(true);
      expect(status.supervisor_pid).toBe(process.pid);
      expect(status.detected_via).toBe('pidfile');
      expect(status.crashes_by_cause).toBeDefined();
      expect(result.stderr).not.toContain('GBRAIN_DB_ACCESS');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
