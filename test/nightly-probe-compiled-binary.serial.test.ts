/**
 * #5187 / C-N6: the nightly probes run on a compiled binary install.
 *
 * Builds test/helpers/nightly-probe-compiled-harness.ts with
 * `bun build --compile`, copies the binary into an empty directory (no gbrain
 * checkout), and runs both autopilot probe steps with an isolated
 * GBRAIN_HOME and audit dir and the gateway's test transports as a hermetic
 * provider (fake keys, no network). The same harness also runs from source
 * with its cwd outside the repo.
 *
 * Protects: the quality probe reads its embedded LongMemEval fixture and
 * reaches a verdict (master wrote `error: nightly fixture not found at
 * <brain repo>/test/fixtures/...`); the parser probe reads its embedded
 * fixtures and writes a row (master skipped quietly with no row, so doctor
 * said ok).
 * Fails when: a fixture is resolved from the package directory on disk
 * again, or `bun build --compile` stops embedding a `type: 'file'` import.
 * Serial: one compile plus two subprocess probe runs.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const HARNESS = join(REPO_ROOT, 'test', 'helpers', 'nightly-probe-compiled-harness.ts');
const root = mkdtempSync(join(tmpdir(), 'gb-probe-bin-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface ProbeRows {
  quality: Array<{ outcome: string; fixture_sha8?: string; distinct_judge_models?: number; detail?: string }>;
  parser: Array<{ outcome: string; fixtures_total: number; reason?: string }>;
}

function runHarness(label: string, argv: string[]): { rows: ProbeRows | null; output: string } {
  const dir = join(root, label);
  const cwd = join(dir, 'cwd');
  mkdirSync(cwd, { recursive: true });
  const res = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(dir, 'home'),
      GBRAIN_HOME: join(dir, 'home'),
      GBRAIN_AUDIT_DIR: join(dir, 'audit'),
      GBRAIN_MODEL_DISCOVERY: 'off',
      GBRAIN_SKIP_STARTUP_HOOKS: '1',
      OPENAI_API_KEY: 'sk-fake-hermetic',
      ANTHROPIC_API_KEY: 'sk-ant-fake-hermetic',
    },
  });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const line = (res.stdout ?? '').split('\n').find(l => l.startsWith('PROBE_RESULT '));
  return { rows: line ? JSON.parse(line.slice('PROBE_RESULT '.length)) as ProbeRows : null, output: output.slice(-4000) };
}

function expectBothProbesRan(rows: ProbeRows | null, output: string): void {
  expect(rows, output).not.toBeNull();
  expect(rows!.quality, output).toHaveLength(1);
  expect(rows!.quality[0]!.outcome, output).toBe('pass');
  expect(rows!.quality[0]!.fixture_sha8).toMatch(/^[0-9a-f]{8}$/);
  expect(rows!.quality[0]!.distinct_judge_models).toBe(3);
  expect(rows!.parser, output).toHaveLength(1);
  expect(rows!.parser[0]!.outcome, output).toBe('pass');
  expect(rows!.parser[0]!.fixtures_total).toBeGreaterThan(0);
}

describe('nightly probes on a compiled binary (#5187, C-N6)', () => {
  test('a compiled binary in an empty directory runs both probes on their embedded fixtures', () => {
    const buildOut = join(root, 'build', 'nightly-probe-harness');
    const build = spawnSync('bun', ['build', '--compile', '--outfile', buildOut, HARNESS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 240_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    expect(existsSync(buildOut)).toBe(true);
    const isolated = join(root, 'isolated-bin');
    mkdirSync(isolated, { recursive: true });
    const bin = join(isolated, 'nightly-probe-harness');
    copyFileSync(buildOut, bin);
    rmSync(join(root, 'build'), { recursive: true, force: true });
    const { rows, output } = runHarness('compiled', [bin]);
    expectBothProbesRan(rows, output);
  }, 300_000);

  test('source mode with a cwd outside the checkout runs both probes too', () => {
    const { rows, output } = runHarness('source', [process.execPath, HARNESS]);
    expectBothProbesRan(rows, output);
  }, 180_000);
});
