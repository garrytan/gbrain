import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { load as loadYaml } from 'js-yaml';
import { MINIMUM_BUN_VERSION } from '../../src/core/runtime-version.ts';

type Matrix = Record<string, unknown> & { exclude?: string };
type Job = { if?: string; 'runs-on'?: string; strategy?: { matrix: Matrix }; steps?: Array<{ id?: string; run?: string; env?: Record<string, string> }> };
const root = join(import.meta.dir, '../..');
const load = (name: string) => loadYaml(readFileSync(join(root, '.github/workflows', name), 'utf8')) as { jobs: Record<string, Job> };
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
    expect(full.native).toHaveLength(12);
    expect(full.musl).toHaveLength(4);
    expect(full.console).toHaveLength(4);
    expect(full.dotnet).toHaveLength(4);
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
    const large = Array.from({ length: 8000 }, (_, i) => `docs/guides/fixture-${i}-${'x'.repeat(72)}.md`);
    expect(Buffer.byteLength(large.join('\n'))).toBeGreaterThan(64 * 1024);
    expect(classify(large.join('\n'))).toBe('smoke');
    for (const at of [0, large.length >> 1, large.length]) {
      const files = [...large];
      files.splice(at, 0, 'src/core/pglite-lock.ts');
      expect(classify(files.join('\n')), `native marker at ${at}`).toBe('primary');
    }
  });

  test('the planning job runs the full matrix off pull requests and never narrows on an unreadable diff', () => {
    const step = load('test.yml').jobs.changes.steps!.find(entry => entry.id === 'scope')!;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ci-scope-'));
    try {
      const run = (event: string, gh: string, changedFiles = '1') => {
        writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash\n${gh}\n`);
        chmodSync(join(dir, 'gh'), 0o755);
        const output = join(dir, 'out');
        writeFileSync(output, '');
        const result = spawnSync('bash', ['-c', step.run!], { cwd: root, encoding: 'utf8',
          env: { PATH: `${dir}:${process.env.PATH}`, EVENT: event, PR: '7', REPO: 'example/repo', CHANGED_FILES: changedFiles, GITHUB_OUTPUT: output } });
        expect(result.status, result.stderr).toBe(0);
        return readFileSync(output, 'utf8').trim();
      };
      expect(run('push', 'exit 1')).toBe('native=full');
      expect(run('schedule', 'exit 1')).toBe('native=full');
      expect(run('workflow_dispatch', 'exit 1')).toBe('native=full');
      expect(run('pull_request', 'exit 1')).toBe('native=primary');
      expect(run('merge_group', 'exit 1')).toBe('native=primary');
      expect(run('pull_request', "printf 'docs/a.md\\n'")).toBe('native=smoke');
      expect(run('pull_request', "printf 'src/core/pglite-lock.ts\\n'")).toBe('native=primary');
      for (const count of ['', 'invalid', '3000', '4230', '99999']) {
        expect(run('pull_request', "printf 'docs/a.md\\n'", count), count).toBe('native=primary');
      }
      // Even below the API cap, an incomplete or overlong successful response
      // is unknown. A complete large docs-only response can still use smoke.
      expect(run('pull_request', "printf 'docs/a.md\\n'", '2')).toBe('native=primary');
      expect(run('pull_request', "printf 'docs/a.md\\ndocs/b.md\\n'", '1')).toBe('native=primary');
      const fixture = join(dir, 'paths');
      const docs = Array.from({ length: 2999 }, (_, i) => `docs/guides/fixture-${i}-${'x'.repeat(72)}.md`);
      writeFileSync(fixture, docs.join('\n'));
      expect(run('pull_request', `cat '${fixture}'`, '2999')).toBe('native=smoke');
      docs[0] = 'src/core/pglite-lock.ts';
      writeFileSync(fixture, docs.join('\n'));
      expect(run('pull_request', `cat '${fixture}'`, '2999')).toBe('native=primary');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a release-style version-only package.json diff does not widen the native scope (C11)', () => {
    const step = load('test.yml').jobs.changes.steps!.find(entry => entry.id === 'scope')!;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ci-scope-c11-'));
    try {
      const run = (files: string[], headPkg: Record<string, unknown>) => {
        writeFileSync(join(dir, 'files'), files.join('\n') + '\n');
        writeFileSync(join(dir, 'base.json'), JSON.stringify({ name: 'gbrain', version: '1', scripts: { a: 'x' } }));
        writeFileSync(join(dir, 'head.json'), JSON.stringify(headPkg));
        writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash
case "$*" in
  *pulls/*/files*) cat '${join(dir, 'files')}' ;;
  *ref=base*) cat '${join(dir, 'base.json')}' ;;
  *ref=head*) cat '${join(dir, 'head.json')}' ;;
  *) exit 1 ;;
esac
`);
        chmodSync(join(dir, 'gh'), 0o755);
        const output = join(dir, 'out');
        writeFileSync(output, '');
        const result = spawnSync('bash', ['-c', step.run!], { cwd: root, encoding: 'utf8',
          env: { PATH: `${dir}:${process.env.PATH}`, EVENT: 'pull_request', PR: '7', REPO: 'example/repo', CHANGED_FILES: String(files.length),
            BASE_SHA: 'base', HEAD_SHA: 'head', GITHUB_OUTPUT: output } });
        expect(result.status, result.stderr).toBe(0);
        return readFileSync(output, 'utf8').trim();
      };
      expect(run(['CHANGELOG.md', 'package.json'], { name: 'gbrain', version: '2', scripts: { a: 'x' } })).toBe('native=smoke');
      expect(run(['package.json'], { name: 'gbrain', version: '2', scripts: { a: 'x' } })).toBe('native=smoke');
      expect(run(['CHANGELOG.md', 'package.json'], { name: 'gbrain', version: '2', scripts: { a: 'y' } })).toBe('native=primary');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('security and persistence matrices run both supported Bun versions on pull requests and merge-queue runs (event parity)', () => {
    const security = load('test.yml').jobs['security-regressions'];
    const persistence = load('persistence-validation.yml').jobs;
    const jobs = [security, ...['read-performance', 'deployment-matrix', 'unit-postgres-arms', 'invariants', 'crash-robot', 'reconciliation'].map(name => persistence[name]!)];
    for (const job of jobs) {
      expect(job.strategy!.matrix.exclude).toBeUndefined();
      const push = cells(job, { github: { event_name: 'push' }, inputs: {} });
      for (const event_name of ['pull_request', 'merge_group', 'schedule', 'workflow_dispatch']) {
        expect(cells(job, { github: { event_name }, inputs: {} })).toEqual(push);
      }
      expect(push.filter(cell => cell.split('/').includes(MINIMUM_BUN_VERSION)).length).toBe(push.length / 2);
    }
    expect(cells(security, { github: { event_name: 'pull_request' }, inputs: {} })).toHaveLength(6);
  });

  // Every event-conditional behavior in a test workflow is classified beside
  // the condition: parity, or a named exception naming its covering scheduled
  // run (docs/TESTING.md#event-parity). Manual dispatch modes are documented
  // at test.yml's inputs and stripped before scanning.
  test('every event-conditional job or block in a test workflow carries its event-parity classification', () => {
    const conditional = /github\.event_name|github\.event\.(?:pull_request|merge_group|action)|inputs\.scope|"\$EVENT"|\$EVENT\b/;
    const dispatchMode = /github\.event_name\s*(?:!=|==)\s*'workflow_dispatch'/g;
    const unclassified: string[] = [];
    for (const name of ['test', 'stress', 'persistence-validation', 'native-locks', 'e2e', 'heavy-tests', 'macos-validation', 'scale-tier', 'semgrep']) {
      const lines = readFileSync(join(root, '.github/workflows', `${name}.yml`), 'utf8').split('\n');
      // Blocks: each job (from the comments directly above its key to the next job) and the top-level preamble.
      const starts = lines.flatMap((line, i) => (/^  [\w-]+:\s*$/.test(line) && lines.slice(0, i).some(l => l === 'jobs:') ? [i] : []));
      const blocks: Array<{ label: string; from: number; to: number }> = [];
      const commentTop = (i: number) => { let j = i; while (j > 0 && /^\s*#/.test(lines[j - 1]!)) j--; return j; };
      const jobsLine = lines.indexOf('jobs:');
      blocks.push({ label: 'top level', from: 0, to: jobsLine });
      starts.forEach((start, k) => blocks.push({ label: lines[start]!.trim(), from: commentTop(start), to: k + 1 < starts.length ? commentTop(starts[k + 1]!) : lines.length }));
      for (const block of blocks) {
        const text = lines.slice(block.from, block.to);
        const code = text.filter(l => !/^\s*#/.test(l)).join('\n').replace(dispatchMode, '');
        if (!conditional.test(code)) continue;
        if (!text.some(l => /^\s*#.*docs\/(?:TESTING\.md#event-parity|ci-event-parity\.md#dependency-audit-rule)/.test(l) || /^\s*#\s*Event parity/.test(l))) unclassified.push(`${name}.yml › ${block.label}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  test('the event-parity table lists every classified workflow', () => {
    expect(readFileSync(join(root, 'docs/TESTING.md'), 'utf8')).toContain('### Event parity');
    const docs = readFileSync(join(root, 'docs/ci-event-parity.md'), 'utf8');
    const section = docs.slice(docs.indexOf('## Classification'), docs.indexOf('## Dependency-audit rule'));
    for (const name of ['test', 'stress', 'persistence-validation', 'native-locks', 'e2e', 'heavy-tests', 'macos-validation', 'scale-tier', 'semgrep', 'osv-scanner', 'nightly-watch']) {
      expect(section, name).toContain(`${name}.yml`);
    }
    expect(docs).toContain('## Dependency-audit rule');
  });

  test('export scale runs 10,001 pages on pull requests and 100,001 everywhere else', () => {
    const step = load('test.yml').jobs['slow-entity-resolve-perf'].steps!.find(entry => entry.run?.includes('test/export-scale.slow.test.ts'))!;
    const expression = step.env!.GBRAIN_TEST_EXPORT_SCALE_PAGES!;
    expect(evaluate(expression, { github: { event_name: 'pull_request' } })).toBe('10001');
    expect(evaluate(expression, { github: { event_name: 'merge_group' } })).toBe('10001');
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
    expect(matrices).toHaveLength(7);
    for (const bun of matrices) expect(bun).toEqual([MINIMUM_BUN_VERSION, primary]);
    for (const job of ['native', 'musl', 'windows-backup-console', 'windows-backup-dotnet']) {
      expect(native[job].strategy!.matrix.bun).toEqual([MINIMUM_BUN_VERSION, primary]);
    }
  });
});
