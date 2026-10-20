/**
 * #7002 (GBRA-133 PR 2a.4): an idle `gbrain jobs work` never started a persistence consumer (jobs/work.ts), so
 * when the serve on a host stopped, queued persistence effects waited for some later process to start one, although
 * the 0.60.117.0 notice says a jobs worker "promotes itself when that owner lapses". Phase 1 reproduced it on
 * Postgres (a request queued 30 s beside an idle worker).
 *
 * Protects: on Postgres a worker joins the existing consumer election at boot, before any job runs: alone it becomes
 * the full consumer; beside a live owner it waits (waiter_only) and promotes when that owner stops. Its row goes away
 * when it exits. persistence.single_consumer is unchanged. PGLite keeps draining in the foreground and starts nothing.
 * Fails when: an idle worker has no consumer row, a second worker does not take over after the first stops, or a
 * stopped worker leaves its row. Real `gbrain jobs work` processes; asserts on the consumer rows (states), never on
 * elapsed time. PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { pathologicalArms } from './harness.ts';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');
interface ConsumerRow { pid: number; kind: string; mode: string }

function brainHome(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-7002-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ embedding_disabled: true, ...config }));
  return home;
}

function spawnWorker(home: string, extraEnv: Record<string, string> = {}): { child: Subprocess<'ignore', 'pipe', 'pipe'>; output: () => Promise<string> } {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_BANNER: '1', ...extraEnv };
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_JOB_CHILD_CLI', 'GBRAIN_SUPERVISED']) delete env[key];
  const child = Bun.spawn({ cmd: [process.execPath, '--no-env-file', CLI, 'jobs', 'work', '--max-rss', '0', '--health-interval', '0'],
    env: env as Record<string, string>, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let text = '';
  const drain = async (stream: ReadableStream<Uint8Array>) => { for await (const chunk of stream) text += new TextDecoder().decode(chunk); };
  const done = Promise.all([drain(child.stdout), drain(child.stderr)]);
  return { child, output: async () => { if (child.exitCode !== null || child.signalCode) await done; return text; } };
}

async function stop(child: Subprocess): Promise<number | null> {
  if (child.exitCode === null) child.kill('SIGTERM');
  const killer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  try { return await child.exited; } finally { clearTimeout(killer); }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe('#7002 a resident jobs worker joins the persistence-consumer election at boot (' + backend + ')', () => {
    if (backend === 'pglite') {
      // The whole run happens in beforeAll so each PGLite open sits beside the hook that owns it; the test asserts.
      let home = '';
      let run: { code: number | null; text: string; rows: ConsumerRow[] } | null = null;
      beforeAll(async () => {
        home = brainHome({ engine: 'pglite', database_path: '' });
        const path = join(home, '.gbrain', 'brain.pglite');
        writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: path, embedding_disabled: true }));
        const engine = new PGLiteEngine();
        await engine.connect({ database_path: path });
        await engine.initSchema();
        await engine.disconnect();
        const { child, output } = spawnWorker(home);
        const code = await stop_after_exit(child);
        const after = new PGLiteEngine();
        await after.connect({ database_path: path });
        try { run = { code, text: await output(), rows: await after.executeRaw<ConsumerRow>("SELECT pid, kind, mode FROM persistence_consumers WHERE kind='jobs'") }; }
        finally { await after.disconnect(); }
      }, 180_000);
      afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

      test('PGLite: jobs work drains the queue in the foreground and exits; no consumer is left behind', () => {
        expect(run!.code, run!.text).toBe(0);
        expect(run!.text).toContain('drained');
        expect(run!.rows).toEqual([]);
      });
      return;
    }

    const withPostgresHome = async (run: (h: { home: string; rows: () => Promise<ConsumerRow[]>;
      waitFor: (what: string, check: (r: ConsumerRow[]) => boolean, diag: () => Promise<string>) => Promise<ConsumerRow[]> }) => Promise<void>) => {
      const db = await isolatedPersistencePostgres(databaseUrl!);
      const home = brainHome({ engine: 'postgres', database_url: db.databaseUrl });
      const rows = () => db.engine.executeRaw<ConsumerRow>("SELECT pid, kind, mode FROM persistence_consumers WHERE kind='jobs' ORDER BY started_at");
      const waitFor = async (what: string, check: (r: ConsumerRow[]) => boolean, diag: () => Promise<string>) => {
        for (let i = 0; i < 1_200; i++) { const r = await rows(); if (check(r)) return r; await Bun.sleep(50); }
        throw new Error('timed out waiting for ' + what + ': ' + JSON.stringify(await rows()) + '\n' + (await diag()).slice(-3000));
      };
      try { await run({ home, rows, waitFor }); } finally { await db.close(); rmSync(home, { recursive: true, force: true }); }
    };

    test('an idle worker runs a persistence consumer from boot, before any job, and its row goes with the process', async () => {
      await withPostgresHome(async ({ home, rows, waitFor }) => {
        const a = spawnWorker(home);
        try {
          await waitFor('the idle worker to run a consumer', r => r.some(x => x.pid === a.child.pid && x.mode === 'full'), a.output);
          expect(await stop(a.child)).toBe(0);
          expect(await rows()).toEqual([]);
          expect(await a.output()).toMatch(/sync-queue wake: listen \(direct_session\)|sync-queue wake: poll every \d+ ms \(transaction_pooler\)/);
        } finally { await stop(a.child); }
      });
    }, 300_000);

    test('with persistence.single_consumer on, a second idle worker waits beside the first and takes over when it stops', async () => {
      await withPostgresHome(async ({ rows, home, waitFor }) => {
        const env = { GBRAIN_SINGLE_CONSUMER: '1' };
        const a = spawnWorker(home, env);
        let b: ReturnType<typeof spawnWorker> | null = null;
        try {
          await waitFor('the first idle worker to become the full consumer', r => r.some(x => x.pid === a.child.pid && x.mode === 'full'), a.output);
          b = spawnWorker(home, env);
          // A waiter-only consumer claims nothing and has no heartbeat row; it says whom it defers to.
          for (let i = 0; i < 1_200 && !(await b.output()).includes('reason=waiter_only'); i++) await Bun.sleep(50);
          expect(await b.output()).toContain('reason=waiter_only message="deferring to jobs pid ' + a.child.pid + ' on this host');
          expect((await rows()).map(x => [x.pid, x.mode])).toEqual([[a.child.pid, 'full']]);
          expect(await stop(a.child)).toBe(0);
          await waitFor('the second worker to take over', r => r.some(x => x.pid === b!.child.pid && x.mode === 'promoted') && !r.some(x => x.pid === a.child.pid), b.output);
          expect(await stop(b.child)).toBe(0);
          expect(await rows()).toEqual([]);
        } finally {
          await stop(a.child);
          if (b) await stop(b.child);
        }
      });
    }, 300_000);
  });
}

async function stop_after_exit(child: Subprocess): Promise<number | null> {
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try { return await child.exited; } finally { clearTimeout(killer); }
}
