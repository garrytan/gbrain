import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const REPO = resolve(import.meta.dir, '..');
const SCRIPT = join(REPO, 'scripts', 'smoke-test.sh');
const tempDirs: string[] = [];

function runSmoke(opts: { supervisorRunning: boolean; legacyPid?: number; configUrlOnly?: boolean; embeddingStatus?: string; path?: string }) {
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
    printf '%s\\n' "{\\"schema_version\\":1,\\"effective_engine\\":\\"postgres\\",\\"db_url_source\\":\\"$SMOKE_DB_URL_SOURCE\\"}"
    exit 0 ;;
  *" doctor --json "*)
    printf '%s\\n' "{\\"checks\\":[{\\"name\\":\\"connection\\",\\"status\\":\\"ok\\"}$SMOKE_EMBEDDING_CHECK],\\"health_score\\":97}"
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
      GBRAIN_DATABASE_URL: opts.configUrlOnly ? '' : 'postgres://smoke.invalid/brain',
      DATABASE_URL: '',
      SMOKE_DB_URL_SOURCE: opts.configUrlOnly ? 'config-file' : 'env:GBRAIN_DATABASE_URL',
      SMOKE_EMBEDDING_CHECK: opts.embeddingStatus ? `,{"name":"embedding_provider","status":"${opts.embeddingStatus}"}` : '',
      GBRAIN_SMOKE_LOG: join(dir, 'smoke.log'),
      GBRAIN_SMOKE_WORKER_PID_FILE: workerPid,
      GBRAIN_BRAIN_PATH: dir,
      OPENAI_API_KEY: opts.embeddingStatus ? '' : 'test-only-placeholder',
      VOYAGE_API_KEY: '',
      SMOKE_BUN_CALLS: calls,
      SMOKE_WORKER_STARTED: workerStarted,
      SMOKE_SUPERVISOR_RUNNING: opts.supervisorRunning ? '1' : '0',
      PATH: opts.path ?? process.env.PATH,
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

describe('smoke-test database and embedding sources (#5063)', () => {
  test('a configured database URL and a keyless embedding provider doctor accepts both pass', () => {
    const result = runSmoke({ supervisorRunning: true, configUrlOnly: true, embeddingStatus: 'ok' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('health score: 97/100');
    expect(result.stdout).toContain('Embedding provider (doctor embedding_provider: ok)');
  }, 30_000);

  test('a failing doctor embedding_provider check still fails the smoke test', () => {
    const result = runSmoke({ supervisorRunning: true, embeddingStatus: 'fail' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('doctor embedding_provider failed');
  }, 30_000);
});

const NO_TIMEOUT_TOOLS = ['timeout', 'gtimeout'];

/**
 * process.env.PATH with the named tools made unreachable, the way a stock
 * macOS host looks without GNU coreutils: a directory that holds any of them
 * is swapped for a mirror of symlinks to everything else in it.
 */
function pathHiding(hidden: string[], extraFront: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-smoke-path-'));
  tempDirs.push(root);
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean).map((dir, index) => {
    if (!existsSync(dir)) return dir;
    const names = readdirSync(dir);
    if (!names.some(name => hidden.includes(name))) return dir;
    const mirror = join(root, `mirror-${index}`);
    mkdirSync(mirror);
    for (const name of names) if (!hidden.includes(name)) symlinkSync(join(dir, name), join(mirror, name));
    return mirror;
  });
  return [...extraFront, ...dirs].join(':');
}

/** Run a bash snippet with the smoke script's with_deadline function defined, in a scratch cwd. */
function withDeadlineShell(snippet: string, path: string) {
  const fn = readFileSync(SCRIPT, 'utf8').match(/^with_deadline\(\) \{\n[\s\S]*?\n\}\n/m);
  expect(fn, 'scripts/smoke-test.sh defines with_deadline').not.toBeNull();
  const cwd = mkdtempSync(join(tmpdir(), 'gbrain-smoke-deadline-'));
  tempDirs.push(cwd);
  const begin = performance.now();
  const out = spawnSync('bash', ['-c', `${fn![0]}\n${snippet}`], { cwd, encoding: 'utf8', timeout: 25_000, env: { ...process.env, PATH: path } });
  return { ...out, cwd, ms: performance.now() - begin };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('smoke-test checks stay bounded without a timeout binary (#5248)', () => {
  test('the whole smoke run passes on a PATH with neither timeout nor gtimeout', () => {
    const path = pathHiding(NO_TIMEOUT_TOOLS);
    expect(spawnSync('bash', ['-c', 'command -v timeout || command -v gtimeout'], { env: { PATH: path } }).status).not.toBe(0);
    const result = runSmoke({ supervisorRunning: true, path });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('not found');
    expect(result.stdout).toContain('health score: 97/100');
    expect(result.stdout).toContain('GBrain worker (supervisor-managed)');
    const calls = readFileSync(result.calls, 'utf8');
    for (const bounded of ['--help', 'engine status --json', 'doctor --json', 'jobs supervisor status --json']) {
      expect(calls).toContain(bounded);
    }
  }, 30_000);

  test('a command still running at the deadline is stopped and reported as 124', () => {
    const run = withDeadlineShell(`with_deadline 1 sh -c 'echo $$ > child.pid; exec sleep 30'; echo "rc=$?"`, pathHiding(NO_TIMEOUT_TOOLS));
    expect(run.stdout.trim()).toBe('rc=124');
    expect(run.ms).toBeLessThan(5_000);
    expect(alive(Number(readFileSync(join(run.cwd, 'child.pid'), 'utf8')))).toBe(false);
  }, 30_000);

  test('a command that ignores TERM is killed', () => {
    const run = withDeadlineShell(`with_deadline 1 sh -c 'trap "" TERM; echo $$ > child.pid; exec sleep 30'; echo "rc=$?"`, pathHiding(NO_TIMEOUT_TOOLS));
    expect(run.stdout.trim()).toBe('rc=124');
    expect(run.ms).toBeLessThan(6_000);
    expect(alive(Number(readFileSync(join(run.cwd, 'child.pid'), 'utf8')))).toBe(false);
  }, 30_000);

  test('a command that finishes in time returns its own status at once, even close to the limit', () => {
    const run = withDeadlineShell(
      `with_deadline 20 sh -c 'exit 7'; echo "a=$?"; with_deadline 20 true; echo "b=$?"; with_deadline 2 sh -c 'sleep 1; exit 5'; echo "c=$?"`,
      pathHiding(NO_TIMEOUT_TOOLS),
    );
    expect(run.stdout.trim().split('\n')).toEqual(['a=7', 'b=0', 'c=5']);
    expect(run.ms).toBeLessThan(4_000);
  }, 30_000);

  test('arguments reach the command exactly as given and are never evaluated', () => {
    const run = withDeadlineShell(`with_deadline 5 printf '%s|' 'two words' '$(touch injected)' '; touch injected2' '*'`, pathHiding(NO_TIMEOUT_TOOLS));
    expect(run.stdout).toBe('two words|$(touch injected)|; touch injected2|*|');
    expect(existsSync(join(run.cwd, 'injected'))).toBe(false);
    expect(existsSync(join(run.cwd, 'injected2'))).toBe(false);
  }, 30_000);

  test('an installed timeout or gtimeout does the bounding instead of the fallback', () => {
    const fakes = mkdtempSync(join(tmpdir(), 'gbrain-smoke-fake-timeout-'));
    tempDirs.push(fakes);
    for (const tool of NO_TIMEOUT_TOOLS) {
      mkdirSync(join(fakes, tool));
      writeFileSync(join(fakes, tool, tool), `#!/bin/sh\necho "${tool}:$*"\n`);
      chmodSync(join(fakes, tool, tool), 0o755);
    }
    const both = withDeadlineShell('with_deadline 9 echo hi', pathHiding(NO_TIMEOUT_TOOLS, [join(fakes, 'timeout'), join(fakes, 'gtimeout')]));
    expect(both.stdout.trim()).toBe('timeout:9 echo hi');
    const homebrewOnly = withDeadlineShell('with_deadline 9 echo hi', pathHiding(NO_TIMEOUT_TOOLS, [join(fakes, 'gtimeout')]));
    expect(homebrewOnly.stdout.trim()).toBe('gtimeout:9 echo hi');
  }, 30_000);
});
