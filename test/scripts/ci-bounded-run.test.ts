/**
 * scripts/ci-bounded-run.ts: a CI setup command runs in its own process group,
 * an attempt that stalls (still running at its bound, or silent for the idle
 * bound) is ended (SIGTERM to the group, then SIGKILL after the grace period),
 * retried once, and a second failure stops with a named `::error::`. A slow
 * attempt that keeps printing runs to the total budget instead of being
 * restarted. Each case runs a real command that really stalls or crawls.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { runBounded } from '../../scripts/ci-bounded-run.ts';

const ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'ci-bounded-run.ts');
/** Running, as opposed to gone or a zombie: a killed grandchild is a zombie until init reaps it, and `kill -0`
 * still answers for a zombie, so the state field of /proc/<pid>/stat decides (Z and X are dead). */
const alive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!);
  } catch {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
};

describe.skipIf(process.platform === 'win32')('scripts/ci-bounded-run.ts', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'gbrain-ci-bounded-')); dirs.push(dir); return dir; };

  /** A command whose attempts follow `plan` (stall, fail or ok), leaving a backgrounded grandchild on a stall. */
  function stub(dir: string, plan: string[]): string {
    writeFileSync(join(dir, 'plan'), `${plan.join('\n')}\n`);
    const path = join(dir, 'setup');
    writeFileSync(path, `#!/bin/sh
n=$(cat '${dir}/count' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${dir}/count'
case "$(sed -n "\${n}p" '${dir}/plan')" in
  stall) sleep 60 & echo $! >> '${dir}/grandchildren'; sleep 60 ;;
  fail) echo 'E: Unable to fetch some archives' >&2; exit 100 ;;
  *) echo 'done'; exit 0 ;;
esac
`);
    chmodSync(path, 0o755);
    return path;
  }

  async function cli(args: string[]) {
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stdout, stderr, annotations: stderr.split('\n').filter(line => /^::(warning|error)::/.test(line)) };
  }

  test('a stalled attempt is ended with its whole process group, named, and the retry succeeds', async () => {
    const dir = scratch();
    const r = await cli(['--attempt-s', '1', '--retry-s', '0', '--hint', 'normally seconds', '--', stub(dir, ['stall', 'ok'])]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('done');
    expect(r.annotations).toEqual([`::warning::${join(dir, 'setup')} attempt 1 stalled: no result after 1s (normally seconds); retrying in 0s`]);
    const [grandchild] = readFileSync(join(dir, 'grandchildren'), 'utf8').trim().split('\n').map(Number);
    expect(alive(grandchild!)).toBe(false);
  }, 30_000);

  test('two stalls stop with a named error; a failure that is not a stall keeps its exit code', async () => {
    const stalls = scratch();
    const r = await cli(['--attempt-s', '1', '--retry-s', '0', '--', stub(stalls, ['stall', 'stall'])]);
    expect(r.exitCode).toBe(1);
    expect(r.annotations.at(-1)).toBe(`::error::${join(stalls, 'setup')} stalled: no result after 1s on attempt 2 of 2; giving up`);
    for (const pid of readFileSync(join(stalls, 'grandchildren'), 'utf8').trim().split('\n').map(Number)) expect(alive(pid)).toBe(false);
    const fails = scratch();
    const f = await cli(['--attempt-s', '5', '--retry-s', '0', '--', stub(fails, ['fail', 'fail'])]);
    expect(f.exitCode).toBe(1);
    expect(f.stderr).toContain('E: Unable to fetch some archives');
    expect(f.annotations[1]).toMatch(/exited 100 after \d+s on attempt 2 of 2; giving up$/);
  }, 30_000);

  test('a child that ignores SIGTERM is killed after the grace period', async () => {
    const dir = scratch();
    const path = join(dir, 'stubborn');
    writeFileSync(path, `#!/bin/sh\ntrap '' TERM\necho $$ >> '${dir}/pids'\nwhile :; do sleep 1; done\n`);
    chmodSync(path, 0o755);
    const started = Date.now();
    const code = await runBounded({ argv: [path], label: 'stubborn', attemptSeconds: 1, retrySeconds: 0, graceSeconds: 1 });
    expect(code).toBe(1);
    expect((Date.now() - started) / 1000).toBeLessThan(10);
    for (const pid of readFileSync(join(dir, 'pids'), 'utf8').trim().split('\n').map(Number)) expect(alive(pid)).toBe(false);
  }, 30_000);

  test('a silent attempt is a stall at the idle bound; a slow one that keeps printing is not', async () => {
    const silent = scratch();
    const r = await cli(['--idle-s', '1', '--total-s', '20', '--retry-s', '0', '--', stub(silent, ['stall', 'ok'])]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('done');
    expect(r.annotations).toEqual([`::warning::${join(silent, 'setup')} attempt 1 stalled: no output for 1s; retrying in 0s`]);
    const crawl = join(scratch(), 'crawl');
    writeFileSync(crawl, `#!/bin/sh\nfor p in 10 20 30 40; do sleep 0.5; echo "$p% of 186.8 MiB"; done\necho installed\n`);
    chmodSync(crawl, 0o755);
    const c = await cli(['--idle-s', '1', '--total-s', '20', '--retry-s', '0', '--', crawl]);
    expect(c.exitCode).toBe(0);
    expect(c.stdout).toBe('10% of 186.8 MiB\n20% of 186.8 MiB\n30% of 186.8 MiB\n40% of 186.8 MiB\ninstalled\n');
    expect(c.annotations).toEqual([]);
  }, 30_000);

  test('an attempt still printing when the total budget runs out is ended and named, with no retry', async () => {
    const dir = scratch();
    const path = join(dir, 'endless');
    writeFileSync(path, `#!/bin/sh\necho start >> '${dir}/starts'\nwhile :; do echo progress; sleep 0.3; done\n`);
    chmodSync(path, 0o755);
    const started = Date.now();
    const r = await cli(['--idle-s', '2', '--total-s', '2', '--retry-s', '0', '--hint', 'a slow CDN', '--', path]);
    expect(r.exitCode).toBe(1);
    expect(r.annotations).toEqual([`::error::${path} was still running when its 2s budget ran out (a slow CDN) on attempt 1 of 2; giving up`]);
    expect(readFileSync(join(dir, 'starts'), 'utf8')).toBe('start\n');
    expect((Date.now() - started) / 1000).toBeLessThan(10);
  }, 30_000);

  test('usage errors exit 2 without running anything', async () => {
    expect((await cli(['--', 'true'])).exitCode).toBe(2);
    expect((await cli(['--attempt-s', '5'])).exitCode).toBe(2);
    expect((await cli(['--idle-s', '5', '--', 'true'])).exitCode).toBe(2);
    expect((await cli(['--total-s', '0', '--', 'true'])).exitCode).toBe(2);
  });
});

test('the Playwright install is bounded by silence and a total budget that fits its step cap, and its browser is cached', () => {
  type Step = { id?: string; uses?: string; if?: string; run?: string; with?: Record<string, string>; 'timeout-minutes'?: number };
  const doc = load(readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')) as { jobs: Record<string, { 'timeout-minutes': number; steps: Step[] }> };
  const job = doc.jobs['admin-browser']!;
  const at = job.steps.findIndex(entry => entry.run?.includes('playwright install'));
  const step = job.steps[at]!;
  const match = /^bun scripts\/ci-bounded-run\.ts --idle-s (\d+) --total-s (\d+) --retry-s \d+ .*-- bunx playwright install --with-deps --only-shell chromium$/.exec(step.run!);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBeLessThan(Number(match![2]));
  expect(step['timeout-minutes']! * 60).toBeGreaterThan(Number(match![2]) + 10);
  expect(job['timeout-minutes']).toBe(12);
  const restore = job.steps[at - 1]!, save = job.steps[at + 1]!;
  expect(restore.uses).toMatch(/^actions\/cache\/restore@/);
  expect(restore.with!.path).toBe('~/.cache/ms-playwright');
  expect(restore.with!.key).toContain("hashFiles('node_modules/playwright-core/browsers.json')");
  expect(save.uses).toMatch(/^actions\/cache\/save@/);
  expect(save.if).toBe(`steps.${restore.id}.outputs.cache-hit != 'true'`);
  expect(save.with).toEqual({ path: restore.with!.path!, key: `\${{ steps.${restore.id}.outputs.cache-primary-key }}` });
});
