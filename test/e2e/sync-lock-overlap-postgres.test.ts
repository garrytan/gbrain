import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { makeGitFixture } from '../helpers/git-fixture.ts';

const databaseUrl = process.env.DATABASE_URL;
const cli = resolve(import.meta.dir, '../../src/cli.ts');

describe.skipIf(!databaseUrl)('sync lock overlap on Postgres', () => {
  test('held owner excludes every contender, releases, and permits a later sync', async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    const count = Number(process.env.NUM_PARALLEL ?? 4);
    expect(Number.isInteger(count) && count >= 2 && count <= 32).toBe(true);
    const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-lock-test-'));
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const source = `lock-test-${crypto.randomUUID().slice(0, 8)}`;
    const lockKey = `gbrain-sync:${source}`;
    const sql = postgres(databaseUrl!, { max: 2, onnotice: () => {} });
    const children: ReturnType<typeof Bun.spawn>[] = [];
    let barrier: Awaited<ReturnType<typeof sql.reserve>> | undefined;
    const env = {
      PATH: process.env.PATH!, HOME: home, GBRAIN_HOME: home,
      DATABASE_URL: databaseUrl!, GBRAIN_DATABASE_URL: databaseUrl!,
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_GITIGNORE: '1',
    };
    const spawn = (args: string[]) => {
      const proc = Bun.spawn([process.execPath, cli, ...args], {
        cwd: home, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      children.push(proc);
      const result = Promise.all([
        proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
      ]).then(([code, stdout, stderr]) => {
        console.log(`[sync_lock_regression] pid=${proc.pid} rc=${code}\n${stdout}${stderr}`);
        return { code, stdout, stderr };
      });
      return { proc, result };
    };
    const run = async (args: string[]) => {
      const result = await spawn(args).result;
      expect(result.code).toBe(0);
      return result;
    };
    const locks = () => sql`
      SELECT id, holder_pid, acquisition_token FROM gbrain_cycle_locks
      WHERE id = ${lockKey} OR (holder_host = ${hostname()} AND holder_pid = ANY(${children.map(c => c.pid)}::int[]) AND id LIKE 'gbrain-%')
      ORDER BY id
    `;
    try {
      const fixture = await makeGitFixture(repo);
      for (const name of ['page-a', 'page-b']) {
        writeFileSync(join(repo, `${name}.md`), `---\ntitle: Lock fixture ${name}\ntype: note\n---\n\nGeneric lock fixture ${name}.\n`);
      }
      fixture.commitAll('seed lock fixtures');
      await run(['init', '--non-interactive', '--no-embedding', '--url', databaseUrl!]);
      await run(['sources', 'add', source, '--path', repo, '--no-federated']);

      barrier = await sql.reserve();
      await barrier`BEGIN`;
      await barrier`LOCK TABLE pages IN SHARE MODE`;
      const [{ pid: barrierPid }] = await barrier`SELECT pg_backend_pid() AS pid`;
      const args = ['sync', '--source', source, '--repo', repo, '--no-embed', '--no-extract', '--yes', '--json'];
      const owner = spawn(args);
      const deadline = Date.now() + 60_000;
      let held = false;
      while (Date.now() < deadline) {
        const rows = await locks();
        const blocked = await sql`SELECT pid FROM pg_stat_activity WHERE ${barrierPid} = ANY(pg_blocking_pids(pid))`;
        if (rows.some(row => row.id === lockKey && row.holder_pid === owner.proc.pid) && blocked.length > 0) {
          held = true;
          break;
        }
        if (owner.proc.exitCode !== null) break;
        await Bun.sleep(25);
      }
      expect(held).toBe(true);
      const ownership = await locks();
      expect(ownership.length).toBeGreaterThanOrEqual(1);
      console.log(`[sync_lock_regression] owner=${owner.proc.pid} held behind database barrier; starting ${count - 1} contenders`);

      const contenders = Array.from({ length: count - 1 }, () => spawn(args));
      const results = await Promise.race([
        Promise.all(contenders.map(c => c.result)),
        Bun.sleep(30_000).then(() => { throw new Error('contenders queued instead of failing while ownership was held'); }),
      ]);
      for (const result of results) {
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Another sync is in progress');
      }
      expect(owner.proc.exitCode).toBeNull();
      expect(await locks()).toEqual(ownership);

      await barrier`COMMIT`;
      barrier.release();
      barrier = undefined;
      const winner = await owner.result;
      expect(winner.code).toBe(0);
      expect(JSON.parse(winner.stdout).sync_status).toBe('first_sync');
      expect(JSON.parse(winner.stdout).added).toBe(2);
      expect(await locks()).toHaveLength(0);
      const [pages] = await sql`SELECT count(*)::int AS n FROM pages WHERE source_id = ${source}`;
      expect(pages.n).toBe(2);
      const retry = await run(args);
      expect(JSON.parse(retry.stdout).sync_status).toBe('up_to_date');
      expect(await locks()).toHaveLength(0);
      console.log(`[sync_lock_regression] OK — 1 held winner, ${count - 1} lock-busy losers, release and retry verified`);
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      await Promise.all(children.map(child => child.exited));
      if (barrier) {
        await barrier`ROLLBACK`;
        barrier.release();
      }
      await sql`DELETE FROM gbrain_cycle_locks WHERE holder_host = ${hostname()} AND holder_pid = ANY(${children.map(c => c.pid)}::int[])`;
      await sql`DELETE FROM facts WHERE source_id = ${source}`;
      await sql`DELETE FROM sources WHERE id = ${source}`;
      await sql.end();
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
});
