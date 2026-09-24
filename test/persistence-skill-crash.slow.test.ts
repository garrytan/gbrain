import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const worker = join(import.meta.dir, 'fixtures/persistence-skill-worker.ts');

test('independent SIGKILL bundle publication and repeated restoration preserve receipts and quotas', async () => {
  for (const kind of process.env.DATABASE_URL ? ['pglite', 'postgres'] : ['pglite']) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-bundle-crash-'));
    const configPath = join(home, 'worker.json');
    const database = `gbrain_test_bundle_${randomUUID().replaceAll('-', '')}`;
    let admin: ReturnType<typeof postgres> | undefined;
    let databaseUrl: string | undefined;
    if (kind === 'postgres') {
      assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
      admin = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
      await admin.unsafe(`CREATE DATABASE ${database}`);
      const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; databaseUrl = url.toString();
    }
    const config = { engine: kind, database_path: join(home, 'db'), database_url: databaseUrl, root: join(home, 'root'), sourceId: 'crash-example' };
    writeFileSync(configPath, JSON.stringify(config));
    mkdirSync(join(home, '.gbrain')); writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify(config));
    const env = { ...process.env, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SWEEP: '0' };
    const run = async (mode: string, name = '', boundary = '') => {
      const child = Bun.spawn([process.execPath, worker, mode, configPath, name, boundary], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
      const errors = new Response(child.stderr).text();
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      let output = '';
      try {
        for await (const bytes of child.stdout) {
          output += new TextDecoder().decode(bytes);
          if (boundary && output.includes(`"boundary":"${boundary}"`)) { child.kill('SIGKILL'); break; }
        }
        const code = await child.exited;
        const stderr = await errors;
        if (boundary) { expect(output).toContain(`"boundary":"${boundary}"`); expect(code).not.toBe(0); }
        else { expect({ code, stderr }).toMatchObject({ code: 0 }); }
        return output;
      } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } }
    };
    try {
      await run('initialize');
      const boundaries = ['prepared', 'before_publication', 'before_file:0', 'staging_flushed:0', 'after_file:0',
        'staging_flushed:1', 'after_file:1', 'before_file:2', 'after_file:2', 'after_publication', 'before_commit', 'after_commit',
        'file_replaced:0', 'file_replaced:1', 'file_replaced:2', 'directory_flushed:0', 'directory_flushed:1', 'directory_flushed:2'];
      for (const [index, boundary] of boundaries.entries()) {
        const name = `boundary-${index}`;
        await run('publish', name, boundary);
        if (boundary === 'after_publication') {
          await run('recover', name, 'restoration_staging_flushed:0');
          await run('recover', name, 'restoration_file_replaced:0');
          await run('recover', name, 'after_restore:0');
          await run('recover', name, 'restoration_file_replaced:1');
          await run('recover', name, 'after_restore:1');
          await run('recover', name, 'restoration_staging_flushed:2');
          await run('recover', name, 'restoration_file_replaced:2');
          await run('recover', name, 'after_restore:2');
        }
        const result = await run('recover', name);
        expect(result).toContain('"committed":true'); expect(result).toContain('"replay_preserved":true');
      }
    } finally {
      if (admin) { await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end(); }
      rmSync(home, { recursive: true, force: true });
    }
  }
}, 360_000);
