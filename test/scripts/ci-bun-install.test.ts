/**
 * scripts/ci-bun-install.ts: CI's `bun install` ends a stalled attempt at its
 * bound, retries once, and on a second failure stops with a named `::error::`
 * (.195's master run lost a darwin-x64 job to an 805 s install stall that
 * nothing named). A stub `bun` stands in for the real one: it records its
 * arguments, then either sleeps far past the bound (a forced stall), exits
 * non-zero, or succeeds, per attempt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

const ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'ci-bun-install.ts');

describe.skipIf(process.platform === 'win32')('scripts/ci-bun-install.ts', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  /** `plan` is one word per attempt: stall, fail or ok. */
  async function run(plan: string[], flags = ['--frozen-lockfile', '--ignore-scripts']) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ci-bun-install-'));
    dirs.push(dir);
    const stub = join(dir, 'bun');
    writeFileSync(stub, `#!/bin/sh
n=$(cat '${dir}/count' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${dir}/count'
echo "$*" >> '${dir}/args'
case "$(sed -n "\${n}p" '${dir}/plan')" in
  stall) exec sleep 30 ;;
  fail) echo 'error: lockfile had changes, but lockfile is frozen' >&2; exit 1 ;;
  *) echo 'installed'; exit 0 ;;
esac
`);
    chmodSync(stub, 0o755);
    writeFileSync(join(dir, 'plan'), `${plan.join('\n')}\n`);
    const started = Date.now();
    const proc = Bun.spawn([process.execPath, SCRIPT, ...flags], { stdout: 'pipe', stderr: 'pipe', env: {
      ...process.env, GBRAIN_CI_INSTALL_BUN: stub, GBRAIN_CI_INSTALL_ATTEMPT_S: '1', GBRAIN_CI_INSTALL_RETRY_SLEEP_S: '0',
    } });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const annotations = stderr.split('\n').filter(line => line.startsWith('::warning::') || line.startsWith('::error::'));
    const args = existsSync(join(dir, 'args')) ? readFileSync(join(dir, 'args'), 'utf8').trim().split('\n') : [];
    return { exitCode, stdout, stderr, annotations, args, seconds: (Date.now() - started) / 1000 };
  }

  test('a stalled first attempt is ended at its bound, named, and the retry installs', async () => {
    const r = await run(['stall', 'ok']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('installed');
    expect(r.args).toEqual(['install --frozen-lockfile --ignore-scripts', 'install --frozen-lockfile --ignore-scripts']);
    expect(r.annotations).toEqual([
      '::warning::bun install --frozen-lockfile --ignore-scripts attempt 1 stalled: no result after 1s (a registry or network stall; the install normally takes seconds); retrying in 0s',
    ]);
    expect(r.seconds).toBeLessThan(15);
  }, 30_000);

  test('two stalls stop with a named error instead of burning the job budget', async () => {
    const r = await run(['stall', 'stall'], ['--frozen-lockfile']);
    expect(r.exitCode).toBe(1);
    expect(r.args).toHaveLength(2);
    expect(r.annotations.at(-1)).toBe('::error::bun install --frozen-lockfile stalled: no result after 1s (a registry or network stall; the install normally takes seconds) on attempt 2 of 2; giving up');
    expect(r.seconds).toBeLessThan(15);
  }, 30_000);

  test('a failure that is not a stall keeps Bun\'s own output and its exit code', async () => {
    const r = await run(['fail', 'fail']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('lockfile had changes, but lockfile is frozen');
    expect(r.annotations[0]).toMatch(/^::warning::bun install --frozen-lockfile --ignore-scripts attempt 1 exited 1 after \d+s; retrying in 0s$/);
    expect(r.annotations[1]).toMatch(/^::error::bun install --frozen-lockfile --ignore-scripts exited 1 after \d+s on attempt 2 of 2; giving up$/);
  }, 30_000);

  test('a clean install runs once and says nothing', async () => {
    const r = await run(['ok']);
    expect(r).toMatchObject({ exitCode: 0, annotations: [] });
    expect(r.args).toHaveLength(1);
  }, 30_000);
});

test('every workflow install of the root package goes through the bounded wrapper', () => {
  const workflows = new Bun.Glob('.github/workflows/*.yml');
  const direct: string[] = [], bounded: string[] = [];
  for (const file of workflows.scanSync(ROOT)) {
    const doc = load(readFileSync(join(ROOT, file), 'utf8')) as { jobs?: Record<string, { steps?: Array<{ run?: string; 'timeout-minutes'?: number; 'working-directory'?: string }> }> };
    for (const [job, spec] of Object.entries(doc.jobs ?? {})) for (const step of spec.steps ?? []) {
      for (const line of (step.run ?? '').split('\n')) {
        if (/^\s*bun install --frozen-lockfile/.test(line)) direct.push(`${file} ${job}: ${line.trim()}`);
        const wrapped = /^bun ((?:\.\.\/)*scripts\/ci-bun-install\.ts)\b/.exec((step.run ?? '').trim());
        if (/scripts\/ci-bun-install\.ts/.test(line) && wrapped) {
          bounded.push(`${file} ${job}`);
          expect(step['timeout-minutes'], `${file} ${job}`).toBe(8);
          // The path is relative to the step's working directory (admin installs run in admin/).
          expect(existsSync(join(ROOT, step['working-directory'] ?? '.', wrapped[1])), `${file} ${job}: ${wrapped[1]}`).toBe(true);
        }
      }
    }
  }
  expect(direct).toEqual([]);
  expect(bounded.length).toBeGreaterThan(40);
});
