import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { safeLoad } from 'js-yaml';
import { MINIMUM_BUN_VERSION } from '../../src/core/runtime-version.ts';

type Matrix = Record<string, unknown> & { exclude?: string };
type Job = { if?: string; 'runs-on'?: string; strategy?: { matrix: Matrix }; steps?: Array<{ id?: string; run?: string; env?: Record<string, string> }> };
const root = join(import.meta.dir, '../..');
const load = (name: string) => safeLoad(readFileSync(join(root, '.github/workflows', name), 'utf8')) as { jobs: Record<string, Job> };
const evaluate = (expression: string, context: Record<string, unknown>) =>
  runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), { fromJSON: JSON.parse, ...context }, { timeout: 100 });

function cells(job: Job, context: Record<string, unknown>): string[] {
  if (job.if && !evaluate(job.if, context)) return [];
  const { exclude, ...axes } = job.strategy!.matrix;
  const excluded = (exclude ? evaluate(exclude, context) : []) as Array<Record<string, string>>;
  let combos: Array<Record<string, string>> = [{}];
  for (const [key, values] of Object.entries(axes)) combos = combos.flatMap(combo => (values as string[]).map(value => ({ ...combo, [key]: value })));
  return combos.filter(combo => !excluded.some(rule => Object.entries(rule).every(([key, value]) => combo[key] === value)))
    .map(combo => Object.values(combo).join('/'));
}

const native = load('native-locks.yml').jobs;
const nativeCells = (scope: string) => ({
  native: cells(native.native, { inputs: { scope } }),
  musl: cells(native.musl, { inputs: { scope } }),
  console: cells(native['windows-backup-console'], { inputs: { scope } }),
  dotnet: cells(native['windows-backup-dotnet'], { inputs: { scope } }),
  openclaw: evaluate(native.openclaw.if!, { inputs: { scope } }),
});

function classify(files: string): string {
  const result = spawnSync('bash', [join(root, 'scripts/ci-native-scope.sh')], { input: files, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('pull-request CI scope', () => {
  test('pushes, schedules and manual runs keep every Bun version on every native target', () => {
    const full = nativeCells('full');
    expect(full.native).toHaveLength(18);
    expect(full.musl).toHaveLength(6);
    expect(full.console).toHaveLength(6);
    expect(full.dotnet).toHaveLength(6);
    expect(full.openclaw).toBe(true);
  });

  test('a pull request touching native paths runs every target on the primary Bun version', () => {
    const primary = nativeCells('primary');
    expect(primary.native.sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64-glibc', 'linux-x64-glibc', 'win32-arm64', 'win32-x64'].map(target => `1.4.2/${target}`));
    expect(primary.musl).toEqual(['1.4.2/linux-x64-musl', '1.4.2/linux-arm64-musl']);
    expect(primary.console).toEqual(['windows-2022/1.4.2', 'windows-11-arm/1.4.2']);
    expect(primary.dotnet).toEqual(['windows-2022/1.4.2', 'windows-11-arm/1.4.2']);
    expect(primary.openclaw).toBe(true);
  });

  test('other pull requests keep one Linux smoke cell that runs the whole native step list', () => {
    const smoke = nativeCells('smoke');
    expect(smoke).toEqual({ native: ['1.4.2/linux-x64-glibc'], musl: [], console: [], dotnet: [], openclaw: false });
  });

  test('native path changes, an empty list and docs-only diffs classify as expected', () => {
    expect(classify('docs/guides/example.md\nsrc/commands/doctor.ts\n')).toBe('smoke');
    for (const path of ['native/locks/lock.c', 'scripts/native/build.ts', 'src/core/pglite-lock.ts', 'src/core/persistence/journal.ts',
      'src/core/context/ipc-path.ts', 'src/commands/backup.ts', 'src/core/export-stage.ts', 'test/native-lock.test.ts',
      'bun.lock', 'package.json', '.github/workflows/native-locks.yml', 'openclaw.plugin.json']) {
      expect(classify(`README.md\n${path}\n`), path).toBe('primary');
    }
    expect(classify('')).toBe('primary');
  });

  test('the planning job runs the full matrix off pull requests and never narrows on an unreadable diff', () => {
    const step = load('test.yml').jobs.changes.steps!.find(entry => entry.id === 'scope')!;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ci-scope-'));
    try {
      const run = (event: string, gh: string) => {
        writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash\n${gh}\n`);
        chmodSync(join(dir, 'gh'), 0o755);
        const output = join(dir, 'out');
        writeFileSync(output, '');
        const result = spawnSync('bash', ['-c', step.run!], { cwd: root, encoding: 'utf8',
          env: { PATH: `${dir}:${process.env.PATH}`, EVENT: event, PR: '7', REPO: 'example/repo', GITHUB_OUTPUT: output } });
        expect(result.status, result.stderr).toBe(0);
        return readFileSync(output, 'utf8').trim();
      };
      expect(run('push', 'exit 1')).toBe('native=full');
      expect(run('schedule', 'exit 1')).toBe('native=full');
      expect(run('workflow_dispatch', 'exit 1')).toBe('native=full');
      expect(run('pull_request', 'exit 1')).toBe('native=primary');
      expect(run('pull_request', "printf 'docs/a.md\\n'")).toBe('native=smoke');
      expect(run('pull_request', "printf 'src/core/pglite-lock.ts\\n'")).toBe('native=primary');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('security and persistence matrices drop only the oldest Bun version on pull requests', () => {
    const pr = { github: { event_name: 'pull_request' } };
    const push = { github: { event_name: 'push' } };
    const security = load('test.yml').jobs['security-regressions'];
    expect(cells(security, push)).toHaveLength(6);
    expect(cells(security, pr)).toEqual(['ubuntu-latest/1.4.2', 'macos-26/1.4.2', 'windows-latest/1.4.2']);
    const persistence = load('persistence-validation.yml').jobs;
    for (const name of ['read-performance', 'deployment-matrix', 'invariants', 'reconciliation']) {
      const full = cells(persistence[name], push);
      const primary = cells(persistence[name], pr);
      expect(full.filter(cell => cell.endsWith('1.3.11')).length, name).toBe(full.length / 2);
      expect(primary, name).toEqual(full.filter(cell => cell.endsWith('1.4.2')));
    }
  });

  test('export scale runs 10,001 pages on pull requests and 100,001 everywhere else', () => {
    const step = load('test.yml').jobs['slow-entity-resolve-perf'].steps!.find(entry => entry.run?.includes('test/export-scale.slow.test.ts'))!;
    const expression = step.env!.GBRAIN_TEST_EXPORT_SCALE_PAGES!;
    expect(evaluate(expression, { github: { event_name: 'pull_request' } })).toBe('10001');
    for (const event_name of ['push', 'schedule', 'workflow_dispatch']) expect(evaluate(expression, { github: { event_name } })).toBe('100001');
  });

  // #4479: a local gate or VM on a different Bun than CI produced
  // runtime-only skew, so every single-version pin moves together.
  test('every single-version Bun pin matches the primary, and matrices keep the oldest supported version', () => {
    const primary = '1.4.2';
    const read = (path: string) => readFileSync(join(root, path), 'utf8');
    const workflows = ['test', 'e2e', 'heavy-tests', 'macos-validation', 'persistence-validation', 'release', 'native-locks']
      .map(name => read(`.github/workflows/${name}.yml`)).join('\n');
    const pinned = [...workflows.matchAll(/bun-version:\s*(\S+)/g)].map(match => match[1]).filter(value => !value.startsWith('$'));
    expect(pinned.length).toBeGreaterThan(30);
    expect([...new Set(pinned)]).toEqual([primary]);
    expect(/oven\/bun:\$\{GBRAIN_CI_BUN_TAG:-([^}]+)\}/.exec(read('docker-compose.ci.yml'))?.[1]).toBe(primary);
    expect(/BUN_VERSION="\$\{BUN_VERSION:-([^}]+)\}"/.exec(read('scripts/ubicloud/setup-ci-vm.sh'))?.[1]).toBe(primary);
    expect(/\?\? "([\d.]+)";/.exec(read('scripts/ci-ubicloud.ts'))?.[1]).toBe(primary);
    expect(/^gbrain_bun_version=(\S+)$/m.exec(read('scripts/setup-in-agent.sh'))?.[1]).toBe(primary);
    expect(/ARG BUN_IMAGE=oven\/bun:(\S+)/.exec(read('tests/docker/Dockerfile'))?.[1]).toBe(primary);
    expect(/GBRAIN_E2E_BUN_IMAGE:-oven\/bun:([^}]+)\}/.exec(read('tests/docker/bootstrap-e2e.sh'))?.[1]).toBe(primary);
    const matrices = [load('test.yml').jobs['security-regressions'], ...Object.values(load('persistence-validation.yml').jobs)]
      .map(job => job.strategy?.matrix.bun).filter(Boolean);
    expect(matrices).toHaveLength(5);
    for (const bun of matrices) expect(bun).toEqual([MINIMUM_BUN_VERSION, primary]);
    for (const job of ['native', 'musl', 'windows-backup-console', 'windows-backup-dotnet']) {
      expect(native[job].strategy!.matrix.bun as string[]).toEqual(expect.arrayContaining([MINIMUM_BUN_VERSION, primary]));
    }
  });
});
