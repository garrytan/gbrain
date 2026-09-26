import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { safeLoad } from 'js-yaml';

type Job = {
  'runs-on'?: string;
  strategy?: { matrix: { os?: string[]; include?: Array<{ runner: string; target: string }> } };
};
const root = join(import.meta.dir, '../..');
const load = (name: string) => safeLoad(readFileSync(join(root, '.github/workflows', name), 'utf8')) as { jobs: Record<string, Job> };
const normal = 'ubicloud-standard-16-ubuntu-2404';
const heavy = 'ubicloud-standard-30-ubuntu-2404';
const small = 'ubicloud-standard-2-ubuntu-2404';
const report = 'ubicloud-standard-4-ubuntu-2404';

describe('CI runner routing', () => {
  test('owned Linux validation jobs use Ubicloud without moving release publishing', () => {
    for (const file of ['test.yml', 'e2e.yml', 'heavy-tests.yml', 'persistence-validation.yml', 'native-locks.yml', 'actionlint.yml', 'semgrep.yml']) {
      for (const job of Object.values(load(file).jobs)) {
        const runner = job['runs-on'];
        if (!runner || runner.startsWith('${{')) continue;
        expect(runner, file).toMatch(/^ubicloud-standard-(2|4|16|30)-ubuntu-2404$/);
      }
    }
    const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(release).not.toContain('ubicloud');
    expect(load('osv-scanner.yml').jobs['osv-scan']['runs-on']).toBeUndefined();
  });

  test('test and database lanes receive larger machines, with extra capacity for soaks', () => {
    for (const name of ['verify', 'serial-tests', 'test', 'slow-eval-longmemeval', 'slow-brainbench-e2e', 'brainbench', 'slow-entity-resolve-perf', 'admin-browser', 'shared-skills-compatibility']) {
      expect(load('test.yml').jobs[name]['runs-on'], name).toBe(normal);
    }
    for (const name of ['jsonb-parity', 'selected-e2e', 'tier1', 'tier2', 'coverage-full-unit', 'coverage-full-serial', 'coverage-full-slow', 'coverage-full-e2e']) {
      expect(load('e2e.yml').jobs[name]['runs-on'], name).toBe(normal);
    }
    expect(load('persistence-validation.yml').jobs['read-performance']['runs-on']).toBe(normal);
    expect(load('persistence-validation.yml').jobs['deployment-matrix']['runs-on']).toBe(normal);
    expect(load('persistence-validation.yml').jobs.invariants['runs-on']).toBe(heavy);
    expect(load('heavy-tests.yml').jobs.heavy['runs-on']).toBe(heavy);
  });

  test('security matrix labels and native platform coverage retain their identities', () => {
    const security = load('test.yml').jobs['security-regressions'];
    expect(security.strategy!.matrix.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
    for (const os of security.strategy!.matrix.os!) {
      const expression = security['runs-on']!.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
      expect(runInNewContext(expression, { matrix: { os } }, { timeout: 100 })).toBe(os === 'ubuntu-latest' ? normal : os);
    }
    const native = load('native-locks.yml');
    const platforms = [
      { runner: normal, target: 'linux-x64-glibc' },
      { runner: 'ubicloud-standard-16-arm-ubuntu-2404', target: 'linux-arm64-glibc' },
      { runner: 'macos-15', target: 'darwin-arm64' },
      { runner: 'macos-15-intel', target: 'darwin-x64' },
      { runner: 'windows-2022', target: 'win32-x64' },
      { runner: 'windows-11-arm', target: 'win32-arm64' },
    ];
    expect(native.jobs.native.strategy!.matrix.include).toEqual(platforms);
    expect(native.jobs.musl.strategy!.matrix.include).toEqual(platforms.slice(0, 2).map(({ runner, target }) => ({ runner, target: target.replace('glibc', 'musl') })));
  });

  test('status and planning jobs stay small while coverage reports retain memory headroom', () => {
    for (const name of ['gitleaks', 'dependency-audit', 'test-status', 'native-only-status']) {
      expect(load('test.yml').jobs[name]['runs-on'], name).toBe(small);
    }
    for (const name of ['prepare-e2e', 'e2e-status']) expect(load('e2e.yml').jobs[name]['runs-on'], name).toBe(small);
    expect(load('test.yml').jobs['coverage-report']['runs-on']).toBe(report);
    expect(load('e2e.yml').jobs['coverage-full-report']['runs-on']).toBe(report);
    expect(load('actionlint.yml').jobs.actionlint['runs-on']).toBe(small);
    expect(load('semgrep.yml').jobs.semgrep['runs-on']).toBe(report);
  });

  test('actionlint recognizes every configured custom label and watches its configuration', () => {
    const config = safeLoad(readFileSync(join(root, '.github/actionlint.yaml'), 'utf8')) as { 'self-hosted-runner': { labels: string[] } };
    expect(config['self-hosted-runner'].labels.sort()).toEqual([small, report, normal, heavy, 'ubicloud-standard-16-arm-ubuntu-2404'].sort());
    const workflow = safeLoad(readFileSync(join(root, '.github/workflows/actionlint.yml'), 'utf8')) as { on: Record<string, { paths: string[] }> };
    for (const event of ['push', 'pull_request']) expect(workflow.on[event].paths).toContain('.github/actionlint.yaml');
  });
});
