import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { load as loadYaml } from 'js-yaml';

type Job = {
  'runs-on'?: string;
  strategy?: { matrix: { os?: string[]; target?: string[] } };
};
const root = join(import.meta.dir, '../..');
const load = (name: string) => loadYaml(readFileSync(join(root, '.github/workflows', name), 'utf8')) as { jobs: Record<string, Job> };
const normal = 'ubicloud-standard-16-ubuntu-2404';
const heavy = 'ubicloud-standard-30-ubuntu-2404';
const small = 'ubicloud-standard-2-ubuntu-2404';
const report = 'ubicloud-standard-4-ubuntu-2404';
const single = report;
const pooled = 'ubicloud-standard-8-ubuntu-2404';
const arm = 'ubicloud-standard-4-arm-ubuntu-2404';
const targetRunners = (job: Job) =>
  JSON.parse(/fromJSON\('([^']+)'\)\[matrix\.target\]/.exec(job['runs-on']!)![1]!) as Record<string, string>;

describe('CI runner routing', () => {
  test('owned Linux validation jobs use Ubicloud without moving release publishing', () => {
    for (const file of ['test.yml', 'e2e.yml', 'heavy-tests.yml', 'persistence-validation.yml', 'native-locks.yml', 'actionlint.yml', 'semgrep.yml']) {
      for (const job of Object.values(load(file).jobs)) {
        const runner = job['runs-on'];
        if (!runner || runner.startsWith('${{')) continue;
        expect(runner, file).toMatch(/^ubicloud-standard-(2|4|8|16|30)-ubuntu-2404$/);
      }
    }
    const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(release).not.toContain('ubicloud');
    expect(load('osv-scanner.yml').jobs['osv-scan']['runs-on']).toBeUndefined();
  });

  test('single-process lanes and soaks use 4 vCPUs, pooled lanes 8, and the label-gated heavy suite keeps 30', () => {
    // Measured: a unit shard is one bun process (1.1-1.5 busy cores on average)
    // and took the same time on 4, 8 and 16 vCPUs; verify matches 16 vCPUs at 8.
    for (const name of ['slow-brainbench-e2e', 'brainbench', 'slow-entity-resolve-perf', 'admin-browser', 'shared-skills-compatibility']) {
      expect(load('test.yml').jobs[name]['runs-on'], name).toBe(single);
    }
    expect(load('test.yml').jobs.verify['runs-on']).toBe(pooled);
    // E2E files run one bun process at a time against the job's Postgres:
    // full-corpus shard 1 took 668s on 4 vCPUs, 704s on 8 and 741s on 16.
    for (const name of ['jsonb-parity', 'tier2', 'tier1-backend-matrix', 'coverage-full-unit', 'coverage-full-slow', 'coverage-full-e2e']) {
      expect(load('e2e.yml').jobs[name]['runs-on'], name).toBe(single);
    }
    expect(load('e2e.yml').jobs.tier1['runs-on']).toBe(normal);
    expect(load('e2e.yml').jobs['coverage-full-serial']['runs-on']).toBe(pooled);
    expect(load('persistence-validation.yml').jobs['read-performance']['runs-on']).toBe(single);
    expect(load('persistence-validation.yml').jobs.invariants['runs-on']).toBe(single);
    expect(load('persistence-validation.yml').jobs.reconciliation['runs-on']).toBe(single);
    expect(load('persistence-validation.yml').jobs['deployment-matrix']['runs-on']).toBe(pooled);
    expect(load('heavy-tests.yml').jobs.heavy['runs-on']).toBe(heavy);
  });

  test('Selected E2E shards run on 2 vCPUs; unit shards and the serial pool on 4 (C1, C8; C4 reverted)', () => {
    // A 25-file E2E sample took 442s on 2 cores vs 455s on 4. Unit shards stay on
    // 4: on PR #6013 the 2-vCPU cell raised the unit shard mean from 542s to 608s
    // and made Test the critical path (V-2 revert). The serial shards finish far
    // off the critical path on 4.
    expect(load('test.yml').jobs.test['runs-on']).toBe(single);
    expect(load('e2e.yml').jobs['selected-e2e']['runs-on']).toBe(small);
    expect(load('test.yml').jobs['serial-tests']['runs-on']).toBe(single);
  });

  test('security matrix labels and native platform coverage retain their identities', () => {
    const security = load('test.yml').jobs['security-regressions'];
    expect(security.strategy!.matrix.os).toEqual(['ubuntu-latest', 'macos-26', 'windows-latest']);
    for (const os of security.strategy!.matrix.os!) {
      const expression = security['runs-on']!.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
      expect(runInNewContext(expression, { matrix: { os } }, { timeout: 100 })).toBe(os === 'ubuntu-latest' ? small : os);
    }
    const native = load('native-locks.yml');
    expect(targetRunners(native.jobs.native)).toEqual({
      'linux-x64-glibc': single,
      'linux-arm64-glibc': arm,
      'darwin-arm64': 'macos-26',
      'darwin-x64': 'macos-26-intel',
      'win32-x64': 'windows-2022',
      'win32-arm64': 'windows-11-arm',
    });
    expect(native.jobs.native.strategy!.matrix.target).toEqual(Object.keys(targetRunners(native.jobs.native)));
    expect(targetRunners(native.jobs.musl)).toEqual({ 'linux-x64-musl': single, 'linux-arm64-musl': arm });
    expect(native.jobs.musl.strategy!.matrix.target).toEqual(['linux-x64-musl', 'linux-arm64-musl']);
  });

  test('macOS 26 validation is pinned, time-boxed, label-gated on pull requests and uses no secrets', () => {
    const text = readFileSync(join(root, '.github/workflows/macos-validation.yml'), 'utf8');
    const workflow = loadYaml(text) as { on: Record<string, unknown>; jobs: Record<string, Job & { 'timeout-minutes'?: number; if?: string }> };
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    const job = workflow.jobs['macos-26']!;
    expect(job['runs-on']).toBe('macos-26');
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job.if).toContain("contains(github.event.pull_request.labels.*.name, 'macos-validation')");
    expect(text).not.toMatch(/\$\{\{[^}]*secrets\./);
  });

  test('status and planning jobs stay small while coverage reports retain memory headroom', () => {
    for (const name of ['changes', 'gitleaks', 'dependency-audit', 'test-status', 'native-only-status']) {
      expect(load('test.yml').jobs[name]['runs-on'], name).toBe(small);
    }
    for (const name of ['prepare-e2e', 'e2e-status']) expect(load('e2e.yml').jobs[name]['runs-on'], name).toBe(small);
    expect(load('test.yml').jobs['coverage-report']['runs-on']).toBe(report);
    expect(load('e2e.yml').jobs['coverage-full-report']['runs-on']).toBe(report);
    expect(load('actionlint.yml').jobs.actionlint['runs-on']).toBe(small);
    expect(load('semgrep.yml').jobs.semgrep['runs-on']).toBe(report);
  });

  test('actionlint recognizes every configured custom label and watches its configuration', () => {
    const config = loadYaml(readFileSync(join(root, '.github/actionlint.yaml'), 'utf8')) as { 'self-hosted-runner': { labels: string[] } };
    expect(config['self-hosted-runner'].labels.sort()).toEqual([small, report, pooled, normal, heavy, arm].sort());
    const workflow = loadYaml(readFileSync(join(root, '.github/workflows/actionlint.yml'), 'utf8')) as { on: Record<string, { paths: string[] }> };
    for (const event of ['push', 'pull_request']) expect(workflow.on[event].paths).toContain('.github/actionlint.yaml');
  });
});
