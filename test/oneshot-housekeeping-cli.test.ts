/**
 * GBRA-156: a one-shot CLI write (`gbrain put`) on a brain with no resident process runs the consumer's housekeeping after
 * its reply: the compaction pass records its run and compacts the receipts past retention. Runs the real CLI as
 * subprocesses on PGLite and on Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');

for (const backend of testBackends()) {
  describe(`one-shot CLI housekeeping (${backend})`, () => {
    let home: string;
    let close: (() => Promise<void>) | undefined;
    let pg: BrainEngine | undefined;
    let pglite: PGLiteEngine;

    async function cli(args: string[], stdin?: string, env: Record<string, string> = {}) {
      const child = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], {
        cwd: home, stdout: 'pipe', stderr: 'pipe', stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
        env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_DISABLE_UPDATE_CHECK: '1', GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', ...env },
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    }
    async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
      if (pg) return pg.executeRaw<T>(text, params);
      const { database_path } = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
      await pglite!.connect({ database_path });
      try { return await pglite!.executeRaw<T>(text, params); } finally { await pglite!.disconnect(); }
    }
    const lastCompaction = async () => (await sql<{ value: string }>("SELECT value FROM config WHERE key='persistence.maintenance.last_compaction'"))[0]?.value;
    const compacted = async () => (await sql<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE compacted'))[0]!.n;

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), `gbrain-oneshot-housekeeping-${backend}-`));
      if (backend === 'postgres') {
        const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        close = isolated.close;
        pg = isolated.engine;
        const [database] = await pg.executeRaw<{ name: string }>('SELECT current_database() AS name');
        const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database!.name}`;
        const init = await cli(['init', '--url', url.toString(), '--non-interactive', '--no-embedding']);
        expect(init.code, init.stderr).toBe(0);
      } else {
        pglite = new PGLiteEngine();
        const init = await cli(['init', '--pglite', '--no-embedding']);
        expect(init.code, init.stderr).toBe(0);
      }
    }, 180_000);
    afterAll(async () => {
      await close?.();
      rmSync(home, { recursive: true, force: true });
    });

    test('each put runs the compaction pass after its reply, compacting the receipts past retention', async () => {
      await sql("INSERT INTO config(key,value) VALUES ('persistence.receipt_retention_days','0') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
      const records: string[] = [];
      for (let i = 0; i < 3; i++) {
        const put = await cli(['put', `notes/housekeeping-${i}`, '--content-origin', 'user_said'], `# Housekeeping ${i}\n\nbody ${i}\n`,
          { GBRAIN_ONESHOT_HOUSEKEEPING_INTERVAL_MS: '0' });
        expect(put.code, put.stderr).toBe(0);
        const record = await lastCompaction();
        expect(record).toBeDefined();
        records.push(record!);
      }
      expect(new Set(records.map(record => JSON.parse(record).at)).size).toBe(3);
      expect(await compacted()).toBeGreaterThanOrEqual(2);
    }, 300_000);
  });
}
