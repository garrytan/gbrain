/**
 * W9F item 7: `gbrain jobs supervisor stop` verifies the drain against the
 * run's own audit rows and real process identity.
 *
 * Protects: a worker pid recycled by an unrelated process (start time differs
 * from the one recorded at spawn) is not "still running"; a supervisor started
 * before the ISO-week boundary keeps its earlier `worker_spawned` rows, so a
 * live worker spawned last week is reported `worker_still_running`, never
 * `drained`; a run with no `started` row on record is `unverified`; a PID file
 * whose pid now belongs to another process is never signaled; audit rows from
 * before exits carried a pid pair with spawns by order, with a warning.
 * Fails when: stop checks every spawn pid of the supervisor pid in the
 * current week's file only (the pre-fix behavior: false `worker_still_running`
 * on a recycled pid, false `drained` across a week boundary or with a pruned
 * audit) or SIGTERMs whatever process holds a stale PID file's pid.
 *
 * The "supervisor" is a `sleep` that exits on SIGTERM; its audit rows are
 * written by the test into a temp GBRAIN_AUDIT_DIR.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { computeSupervisorAuditFilename } from '../src/core/minions/handlers/supervisor-audit.ts';
import { processStartTime } from '../src/core/pglite-lock.ts';

const linuxOnly = process.platform === 'linux' ? describe : describe.skip;
let home: string;
const spawned: Array<ReturnType<typeof Bun.spawn>> = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'sup-stop-identity-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') }));
});
afterAll(() => {
  for (const p of spawned) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  rmSync(home, { recursive: true, force: true });
});

function sleeper(): number {
  const proc = Bun.spawn({ cmd: ['sleep', '300'], stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  spawned.push(proc);
  return proc.pid;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const WEEK_MS = 7 * 86_400_000;
let caseNo = 0;

/** Writes `weeks[i]` (oldest first, the last entry is this week) to the audit dir and runs stop. */
async function runStop(supervisorPid: number, weeks: Array<Array<Record<string, unknown>>>, pidFileBody = String(supervisorPid)) {
  const auditDir = join(home, `audit-${++caseNo}`);
  mkdirSync(auditDir, { recursive: true });
  const now = Date.now();
  weeks.forEach((rows, i) => {
    if (!rows.length) return;
    const at = new Date(now - (weeks.length - 1 - i) * WEEK_MS);
    writeFileSync(join(auditDir, computeSupervisorAuditFilename(at)),
      rows.map(r => JSON.stringify({ ts: at.toISOString(), supervisor_pid: supervisorPid, ...r })).join('\n') + '\n');
  });
  const pidFile = join(home, `sup-${caseNo}.pid`);
  writeFileSync(pidFile, pidFileBody);
  const result = await runCli(['jobs', 'supervisor', 'stop', '--json', '--pid-file', pidFile],
    { home, timeoutMs: 60_000, env: { GBRAIN_AUDIT_DIR: auditDir } });
  const line = result.stdout.split('\n').find(l => l.startsWith('{'));
  return { exitCode: result.exitCode, payload: line ? JSON.parse(line) : null, stderr: result.stderr };
}

const tail = [{ event: 'shutting_down' }, { event: 'stopped', drained: true }];

linuxOnly('jobs supervisor stop identity and run scope (W9F item 7)', () => {
  test('a recycled worker pid (different start time) does not count as a live worker', async () => {
    const recycled = sleeper();
    const sup = sleeper();
    const out = await runStop(sup, [[
      { event: 'started', queue: 'default' },
      { event: 'worker_spawned', pid: recycled, pid_start: '1' },
      ...tail,
    ]]);
    expect(out.payload?.reason, out.stderr).toBe('drained');
    expect(out.exitCode).toBe(0);
  }, 90_000);

  test('a live worker spawned before the week boundary is still running, not drained', async () => {
    const worker = sleeper();
    const sup = sleeper();
    const out = await runStop(sup, [
      [{ event: 'started', queue: 'default' }, { event: 'worker_spawned', pid: worker, pid_start: processStartTime(worker) }],
      tail,
    ]);
    expect(out.payload?.reason, out.stderr).toBe('worker_still_running');
    expect(out.payload?.live_worker_pids).toEqual([worker]);
    expect(out.exitCode).toBe(1);
  }, 90_000);

  test('weeks of uptime: rows from the run started weeks ago pair across files and drain', async () => {
    const reused = sleeper();
    const sup = sleeper();
    const out = await runStop(sup, [
      [{ event: 'started', queue: 'default' }],
      [{ event: 'worker_spawned', pid: reused, pid_start: '1' }],
      [{ event: 'worker_exited', pid: reused }, { event: 'worker_spawned', pid: 999_999_901 }],
      [{ event: 'worker_exited', pid: 999_999_901 }, ...tail],
    ]);
    expect(out.payload?.reason, out.stderr).toBe('drained');
    expect(out.exitCode).toBe(0);
  }, 90_000);

  test('a run whose started row was pruned is unverified, never drained', async () => {
    const sup = sleeper();
    const out = await runStop(sup, [tail]);
    expect(out.payload?.reason, out.stderr).toBe('unverified');
    expect(out.payload?.drained).toBe(false);
    expect(out.payload?.audit_files).toHaveLength(1);
    expect(out.exitCode).toBe(1);
  }, 90_000);

  test('a stale PID file whose pid belongs to another process is never signaled', async () => {
    const unrelated = sleeper();
    const out = await runStop(unrelated, [], `${unrelated}\n1\n`);
    expect(out.payload?.reason, out.stderr).toBe('stale_pid_file');
    expect(out.payload?.stopped).toBe(false);
    expect(alive(unrelated)).toBe(true);

    const legacyFile = await runStop(unrelated, [[{ event: 'started', queue: 'default', supervisor_start: '1' }]]);
    expect(legacyFile.payload?.reason, legacyFile.stderr).toBe('stale_pid_file');
    expect(alive(unrelated)).toBe(true);
  }, 90_000);

  test('legacy exit rows without a pid pair with spawns by order and warn', async () => {
    const recycled = sleeper();
    const sup = sleeper();
    const out = await runStop(sup, [[
      { event: 'started', queue: 'default' },
      { event: 'worker_spawned', pid: recycled },
      { event: 'worker_exited', code: 0 },
      ...tail,
    ]]);
    expect(out.payload?.reason, out.stderr).toBe('drained');
    expect(out.payload?.warnings).toEqual(['legacy_exit_pairing']);
    expect(out.exitCode).toBe(0);
  }, 90_000);
});
