import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const REPO = resolve(import.meta.dir, '..');
const SCRIPT = join(REPO, 'scripts', 'smoke-test.sh');
const tempDirs: string[] = [];

function runSmoke(opts: { supervisorRunning: boolean; legacyPid?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-smoke-worker-'));
  tempDirs.push(dir);
  const fakeBun = join(dir, 'bun');
  const calls = join(dir, 'bun-calls.log');
  const workerStarted = join(dir, 'worker-started');
  const workerPid = join(dir, 'legacy-worker.pid');

  writeFileSync(fakeBun, `#!/bin/sh
printf '%s\\n' "$*" >> "$SMOKE_BUN_CALLS"
case " $* " in
  *" --help "*) exit 0 ;;
  *" engine status --json "*)
    printf '%s\\n' '{"schema_version":1,"effective_engine":"postgres","db_url_source":"env:GBRAIN_DATABASE_URL"}'
    exit 0 ;;
  *" doctor --json "*)
    printf '%s\\n' '{"checks":[{"name":"connection","status":"ok"}],"health_score":97}'
    exit 0 ;;
  *" doctor "*) printf '%s\\n' 'GBrain Health Check' 'Health score: 97'; exit 0 ;;
  *" jobs supervisor status --json "*)
    if [ "$SMOKE_SUPERVISOR_RUNNING" = 1 ]; then
      printf '%s\\n' '{"running":true,"detected_via":"pidfile"}'
      exit 0
    fi
    exit 1 ;;
  *" jobs work "*) : > "$SMOKE_WORKER_STARTED"; exit 0 ;;
esac
exit 0
`);
  chmodSync(fakeBun, 0o755);
  if (opts.legacyPid) writeFileSync(workerPid, `${opts.legacyPid}\n`);

  const result = spawnSync('bash', [SCRIPT], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      HOME: dir,
      GBRAIN_BUN_PATH: fakeBun,
      GBRAIN_DIR_OVERRIDE: REPO,
      GBRAIN_DATABASE_URL: 'postgres://smoke.invalid/brain',
      GBRAIN_SMOKE_LOG: join(dir, 'smoke.log'),
      GBRAIN_SMOKE_WORKER_PID_FILE: workerPid,
      GBRAIN_BRAIN_PATH: dir,
      OPENAI_API_KEY: 'test-only-placeholder',
      SMOKE_BUN_CALLS: calls,
      SMOKE_WORKER_STARTED: workerStarted,
      SMOKE_SUPERVISOR_RUNNING: opts.supervisorRunning ? '1' : '0',
    },
  });
  return { ...result, calls, workerStarted, workerPid };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('smoke-test worker health (#4175)', () => {
  test('a healthy native supervisor prevents a duplicate unmanaged worker', () => {
    const result = runSmoke({ supervisorRunning: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('health score: 97/100');
    expect(result.stderr).not.toContain('invalid option');
    expect(result.stdout).toContain('GBrain worker (supervisor-managed)');
    expect(readFileSync(result.calls, 'utf8')).toContain('jobs supervisor status --json');
    expect(existsSync(result.workerStarted)).toBe(false);
    expect(existsSync(result.workerPid)).toBe(false);
  }, 30_000);

  test('a missing worker fails with an explicit native repair and never starts one', () => {
    const result = runSmoke({ supervisorRunning: false });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('gbrain jobs supervisor start --detach');
    expect(existsSync(result.workerStarted)).toBe(false);
    expect(existsSync(result.workerPid)).toBe(false);
  }, 30_000);

  test('a supervisor plus a live legacy PID is reported as a duplicate', () => {
    const result = runSmoke({ supervisorRunning: true, legacyPid: process.pid });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('duplicate supervisor + legacy worker');
    expect(existsSync(result.workerStarted)).toBe(false);
  }, 30_000);
});
