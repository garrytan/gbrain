/**
 * #7003 (GBRA-133 PR 2a.4): `gbrain autopilot --status` graded the daemon's heartbeat (the lock mtime) against
 * 6 x the STATUS caller's `--interval` (default 300 s), but the daemon sleeps its own adaptive interval (2 x its
 * `--interval` on a brain scoring 90 or more), so a healthy daemon started with `--interval 1500` read
 * "NOT ticking" and exited 1 on every long sleep.
 *
 * Protects: the daemon writes a heartbeat sidecar with its own next tick; --status grades from it (stale only once the
 * lock is older than the next tick plus a grace of its base interval), and falls back to the flag rule when the sidecar
 * is absent, written by another pid, or older than the lock (a daemon on an older binary). The issue's case: daemon
 * --interval 1500 at score >= 90 sleeping 3000 s, heartbeat 2700 s old -> fresh; older than 3000 s + its budget -> stale.
 * Fails when: --status ignores the daemon's schedule, trusts a foreign or outdated sidecar, or the daemon writes none.
 * Real daemon processes for the write side (PGLite inline; Postgres dispatch with --no-worker).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyAutopilotStatus } from '../../src/commands/autopilot.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { pathologicalArms } from './harness.ts';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');
const heartbeatModule = () => import('../../src/core/autopilot-heartbeat.ts');
const T0 = Date.parse('2026-10-18T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** The --status verdict for a lock refreshed at T0 (the top of the last tick) and seen ageSeconds later. */
async function grade(ageSeconds: number, sidecar: Record<string, unknown> | null, lockPid: number | null = 4242) {
  const { daemonStaleAfterSeconds } = await heartbeatModule();
  return classifyAutopilotStatus({
    installed: true, installTarget: 'linux-systemd' as never, disabledReason: null, pausedReason: null,
    heartbeatAgeSeconds: ageSeconds, intervalSeconds: 300, lastLog: '',
    daemon: daemonStaleAfterSeconds(sidecar as never, { mtimeMs: T0, pid: lockPid }),
  } as Parameters<typeof classifyAutopilotStatus>[0]);
}

/** Daemon --interval 1500 at score >= 90: a 79 s cycle, then a 3000 s sleep. */
const sleeping = { pid: 4242, written_at: iso(T0 + 79_000), phase: 'sleep', interval_s: 3000, base_interval_s: 1500, next_tick_at: iso(T0 + 79_000 + 3_000_000) };

describe('#7003 autopilot --status grades from the daemon\'s own next tick', () => {
  test('the issue\'s case: a 2700 s old heartbeat during a 3000 s adaptive sleep is fresh; past the next tick plus its budget it is stale', async () => {
    const fresh = await grade(2700, sleeping);
    expect({ state: fresh.state, source: fresh.stale_after_source, next: fresh.next_tick_at }).toEqual({ state: 'fresh', source: 'daemon', next: sleeping.next_tick_at });
    expect(fresh.stale_after_seconds).toBe(79 + 3000 + 1500);
    expect((await grade(79 + 3000 + 1500, sleeping)).state).toBe('fresh');
    expect((await grade(79 + 3000 + 1501, sleeping)).state).toBe('stale');
  });

  test('a cycle in progress grades on 6 x the daemon\'s own base interval, not the caller\'s flag', async () => {
    const cycle = { ...sleeping, written_at: iso(T0 + 1_000), phase: 'cycle', interval_s: null, next_tick_at: null };
    const r = await grade(2700, cycle);
    expect({ state: r.state, source: r.stale_after_source, after: r.stale_after_seconds }).toEqual({ state: 'fresh', source: 'daemon', after: 9000 });
  });

  test('no sidecar, another pid\'s sidecar, or one older than the lock: the flag rule (6 x --interval) as before', async () => {
    for (const sidecar of [null, { ...sleeping, pid: 999 }, { ...sleeping, written_at: iso(T0 - 600_000) }, { ...sleeping, base_interval_s: 'x' }]) {
      const r = await grade(2700, sidecar);
      expect({ state: r.state, source: r.stale_after_source, after: r.stale_after_seconds }).toEqual({ state: 'stale', source: 'flag', after: 1800 });
    }
  });
});

function daemonHome(config: Record<string, unknown>): { home: string; repo: string } {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-7003-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ embedding_disabled: true, self_upgrade: { mode: 'off' }, ...config }));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  return { home, repo };
}

function cliEnv(home: string): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_BANNER: '1' };
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SUPERVISED', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  return env as Record<string, string>;
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe('#7003 the daemon side (' + backend + ')', () => {
    let db: Awaited<ReturnType<typeof isolatedPersistencePostgres>> | null = null;
    let home = '';
    let repo = '';
    beforeAll(async () => {
      db = databaseUrl ? await isolatedPersistencePostgres(databaseUrl) : null;
      ({ home, repo } = daemonHome(db ? { engine: 'postgres', database_url: db.databaseUrl } : { engine: 'pglite', database_path: '' }));
      if (db) return;
      const dbPath = join(home, '.gbrain', 'brain.pglite');
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbPath, embedding_disabled: true, self_upgrade: { mode: 'off' } }));
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dbPath });
      await engine.initSchema();
      await engine.disconnect();
    }, 120_000);
    afterAll(async () => { await db?.close(); if (home) rmSync(home, { recursive: true, force: true }); });

    test('#7003 a running daemon writes its next tick and --status --json grades from it (' + backend + ')', async () => {
      const sidecarPath = join(home, '.gbrain', 'autopilot.heartbeat.json');
      const args = ['autopilot', '--repo', repo, '--interval', '1500', ...(db ? ['--no-worker'] : ['--inline'])];
      const daemon = Bun.spawn({ cmd: [process.execPath, '--no-env-file', CLI, ...args], env: cliEnv(home), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      let output = '';
      const drain = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) output += new TextDecoder().decode(c); };
      const drained = Promise.all([drain(daemon.stdout), drain(daemon.stderr)]);
      try {
        let sidecar: { pid: number; phase: string; next_tick_at: string | null; base_interval_s: number } | null = null;
        for (let i = 0; i < 2_400 && daemon.exitCode === null; i++) {
          if (existsSync(sidecarPath)) { sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')); if (sidecar?.phase === 'sleep') break; }
          await Bun.sleep(50);
        }
        expect(sidecar?.phase, output.slice(-3000)).toBe('sleep');
        expect(sidecar!.pid).toBe(daemon.pid);
        expect(sidecar!.base_interval_s).toBe(1500);
        const lockMtime = statSync(join(home, '.gbrain', 'autopilot.lock')).mtimeMs;
        const status = Bun.spawnSync({ cmd: [process.execPath, '--no-env-file', CLI, 'autopilot', '--status', '--json'], env: cliEnv(home), stdout: 'pipe', stderr: 'pipe' });
        const report = JSON.parse(status.stdout.toString().trim().split('\n').reverse().find(l => l.startsWith('{'))!);
        expect({ source: report.stale_after_source, next: report.next_tick_at }).toEqual({ source: 'daemon', next: sidecar!.next_tick_at });
        expect(report.stale_after_seconds).toBe(Math.ceil((Date.parse(sidecar!.next_tick_at!) - lockMtime) / 1000) + 1500);
      } finally {
        daemon.kill('SIGTERM');
        const killer = setTimeout(() => daemon.kill('SIGKILL'), 45_000);
        await daemon.exited; clearTimeout(killer); await drained;
      }
    }, 240_000);
  });
}
