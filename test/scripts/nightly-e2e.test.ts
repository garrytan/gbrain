import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { safeLoad } from 'js-yaml';
import { verifyNightlyE2E } from '../../scripts/verify-nightly-e2e.ts';

const repo = join(import.meta.dir, '../..');
const fullProfile = "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.full_corpus)";
const expected = Array.from({ length: 4 }, (_, i) => [`test/e2e/fixture-${i}-a.test.ts`, `test/e2e/fixture-${i}-b.test.ts`]);
function fixture(fn: (root: string) => void, partitions = expected) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-nightly-e2e-'));
  try {
    for (let index = 0; index < partitions.length; index++) {
      const dir = join(root, `coverage-full-e2e-${index + 1}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'lane-manifest.json'), JSON.stringify({ lane: `e2e-${index + 1}`, sha: 'fixture-sha', lcovCount: 2, complete: true }));
      writeFileSync(join(dir, 'executed-files.txt'), partitions[index].join('\n') + '\n');
    }
    fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('nightly E2E execution receipts', () => {
  test('accepts exactly four complete disjoint partitions of the same commit', () => fixture(root => {
    expect(() => verifyNightlyE2E(root, expected, 'fixture-sha')).not.toThrow();
  }));
  test.each(['missing artifact', 'missing manifest', 'missing receipt', 'wrong SHA', 'incomplete', 'duplicate lane', 'wrong lane', 'missing file', 'duplicate file', 'extra file', 'overlapping partitions', 'malformed manifest'])('%s fails closed', kind => fixture(root => {
    const dir = join(root, 'coverage-full-e2e-4');
    const manifest = join(dir, 'lane-manifest.json');
    const receipt = join(dir, 'executed-files.txt');
    const data = JSON.parse(readFileSync(manifest, 'utf8'));
    if (kind === 'missing artifact') rmSync(dir, { recursive: true });
    if (kind === 'missing manifest') rmSync(manifest);
    if (kind === 'missing receipt') rmSync(receipt);
    if (kind === 'wrong SHA') writeFileSync(manifest, JSON.stringify({ ...data, sha: 'stale-commit' }));
    if (kind === 'incomplete') writeFileSync(manifest, JSON.stringify({ ...data, complete: false }));
    if (kind === 'duplicate lane') writeFileSync(manifest, JSON.stringify({ ...data, lane: 'e2e-1' }));
    if (kind === 'wrong lane') writeFileSync(manifest, JSON.stringify({ ...data, lane: 'e2e-5' }));
    if (kind === 'missing file') writeFileSync(receipt, expected[3][0] + '\n');
    if (kind === 'duplicate file') writeFileSync(receipt, [expected[3][0], expected[3][0]].join('\n'));
    if (kind === 'extra file') writeFileSync(receipt, [...expected[3], 'test/e2e/extra.test.ts'].join('\n'));
    if (kind === 'overlapping partitions') writeFileSync(receipt, expected[0].join('\n'));
    if (kind === 'malformed manifest') writeFileSync(manifest, '{');
    expect(() => verifyNightlyE2E(root, expected, 'fixture-sha')).toThrow();
  }));
  test('an absent artifact directory cannot claim complete execution', () => fixture(root => {
    expect(() => verifyNightlyE2E(join(root, 'absent'), expected, 'fixture-sha')).toThrow();
  }));
});

describe('nightly E2E scheduling', () => {
  test('full-profile shell flags use environment data instead of expression interpolation', () => {
    const workflow = safeLoad(readFileSync(join(repo, '.github/workflows/e2e.yml'), 'utf8')) as any;
    const steps = [
      workflow.jobs['prepare-e2e'].steps.find((step: any) => step.id === 'select'),
      workflow.jobs['e2e-status'].steps.find((step: any) => step.name === 'Aggregate result'),
    ];
    for (const step of steps) {
      expect(step.env?.FULL_CORPUS).toBe('${{ ' + fullProfile + ' }}');
      expect(step.run).toContain('if [ "$FULL_CORPUS" = "true" ]; then');
      expect(step.run).not.toContain('${{ ' + fullProfile + ' }}');
    }
  });
  test('the four actual runner partitions cover the complete default discovery exactly once', () => {
    const discover = (shard: string) => {
      const result = spawnSync('bash', ['scripts/run-e2e.sh', '--dry-run-list'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, SHARD: shard, COVERAGE_DIR: '' },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim().split('\n').filter(Boolean);
    };
    const corpus = [...readdirSync(join(repo, 'test/e2e')).filter(file => file.endsWith('.test.ts')).map(file => `test/e2e/${file}`), 'test/phantom-redirect-engine-parity.test.ts'].sort();
    expect(discover('').sort()).toEqual(corpus);
    const partitions = [1, 2, 3, 4].map(n => discover(`${n}/4`));
    expect(partitions.every(files => files.length > 0)).toBe(true);
    expect(partitions.flat().sort()).toEqual(corpus);
    expect(new Set(partitions.flat()).size).toBe(corpus.length);
    fixture(root => {
      const verify = () => spawnSync(process.execPath, ['scripts/verify-nightly-e2e.ts', root, '4', 'fixture-sha'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, SHARD: '3/4', COVERAGE_DIR: join(root, 'unused') },
      });
      const complete = verify();
      expect(complete.status, complete.stderr).toBe(0);
      expect(complete.stdout).toContain(`all ${corpus.length} files accounted for across 4 isolated workers`);
      rmSync(join(root, 'coverage-full-e2e-4/executed-files.txt'));
      expect(verify().status).toBe(1);
    }, partitions);
  });
  test('nightly jobs preserve job-local Postgres, independent artifacts, always-reporting and required execution evidence', () => {
    const workflow = safeLoad(readFileSync(join(repo, '.github/workflows/e2e.yml'), 'utf8')) as any;
    const job = workflow.jobs['coverage-full-e2e'];
    expect(job.if).toBe(fullProfile);
    expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3, 4] } });
    expect(job.services.postgres.image).toBe('pgvector/pgvector:pg16');
    const run = job.steps.find((step: any) => step.run === 'bash scripts/run-e2e.sh');
    expect(run.env.SHARD).toBe('${{ matrix.shard }}/4');
    expect(run.env.DATABASE_URL).toContain('/gbrain_test');
    expect(run.env.COVERAGE_DIR).toBe('${{ runner.temp }}/coverage');
    const bootstrap = job.steps.find((step: any) => step.name === 'Bootstrap isolated E2E schema');
    expect(job.steps.indexOf(bootstrap)).toBeLessThan(job.steps.indexOf(run));
    expect(bootstrap.env).toEqual({ DATABASE_URL: run.env.DATABASE_URL, GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1', GBRAIN_MODEL_DISCOVERY: 'off' });
    fixture(root => {
      const home = join(root, 'home');
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      const sentinel = join(home, '.gbrain/config.json');
      writeFileSync(sentinel, '{"doNotTouch":true}\n');
      const result = spawnSync('bash', ['-e', '-c', bootstrap.run], {
        cwd: repo, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, ...bootstrap.env, RUNNER_TEMP: root, HOME: home, GBRAIN_HOME: home,
          DATABASE_URL: 'postgresql://localhost:1/production', GBRAIN_DATABASE_URL: 'postgresql://localhost:1/also_production',
          GBRAIN_E2E_ALLOW_DB: 'production', OPENAI_API_KEY: 'synthetic-bootstrap-canary' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('does not look like a test database');
      expect(result.stderr).not.toContain('synthetic-bootstrap-canary');
      expect(readFileSync(sentinel, 'utf8')).toBe('{"doNotTouch":true}\n');
      expect(readdirSync(root).some(name => name.startsWith('e2e-bootstrap.'))).toBe(false);
    });
    for (const [stepName, artifact] of [['Upload coverage', 'coverage-full-e2e-'], ['Upload execution receipt', 'e2e-full-execution-']]) {
      const step = job.steps.find((step: any) => step.name === stepName);
      expect(step.if).toBe('always()');
      expect(step.with.name).toBe(artifact + '${{ matrix.shard }}');
    }
    const report = workflow.jobs['coverage-full-report'];
    expect(report.needs).toContain('coverage-full-e2e');
    expect(report.if).toBe(`always() && (${fullProfile})`);
    const merge = report.steps.find((step: any) => step.name === 'Merge full corpus').run;
    expect(merge).toContain('scripts/verify-nightly-e2e.ts "$RUNNER_TEMP/coverage-artifacts" 4 "$GITHUB_SHA"');
    expect(merge).toContain(',e2e-1,e2e-2,e2e-3,e2e-4');
    fixture(root => {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'bun'), '#!/bin/sh\necho COVERAGE_CALLED\n', { mode: 0o755 });
      for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
        const script = merge.replace('${{ needs.coverage-full-e2e.result }}', result);
        const run = spawnSync('bash', ['-e', '-c', script], {
          encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root, GITHUB_SHA: 'fixture-sha' },
        });
        expect(run.status, run.stderr).toBe(result === 'success' ? 0 : 1);
        expect(run.stdout.includes('COVERAGE_CALLED')).toBe(result === 'success');
      }
    });
    const status = workflow.jobs['e2e-status'];
    expect(status.if).toBe('always()');
    expect(status.needs).toContain('coverage-full-e2e');
    expect(status.needs).not.toContain('coverage-full-report');
    const validate = status.steps.find((step: any) => step.name === 'Verify complete nightly execution');
    expect(validate.if).toBe(fullProfile);
    expect(validate.run).toBe('bun scripts/verify-nightly-e2e.ts "$RUNNER_TEMP/e2e-execution" 4 "$GITHUB_SHA"');
  });
  test('manual full corpus is opt-in and uses the complete scheduled profile without cancelling ordinary runs', () => {
    const workflow = safeLoad(readFileSync(join(repo, '.github/workflows/e2e.yml'), 'utf8')) as any;
    expect(workflow.on.workflow_dispatch.inputs.full_corpus).toMatchObject({ type: 'boolean', default: false });
    for (const name of ['coverage-full-unit', 'coverage-full-serial', 'coverage-full-slow', 'coverage-full-e2e']) expect(workflow.jobs[name].if).toBe(fullProfile);
    for (const step of workflow.jobs['e2e-status'].steps.slice(1)) expect(step.if).toBe(fullProfile);
    const selection = workflow.jobs['prepare-e2e'].steps.find((step: any) => step.id === 'select');
    const select = selection.run;
    expect(selection.env.FULL_CORPUS).toBe('${{ ' + fullProfile + ' }}');
    const group = workflow.concurrency.group;
    expect(group).toBe("${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}${{ github.event_name == 'workflow_dispatch' && inputs.full_corpus && '-full-corpus' || '' }}");
    for (const [event, enabled, expected] of [
      ['pull_request', false, false], ['pull_request', true, false], ['push', true, false],
      ['workflow_dispatch', false, false], ['workflow_dispatch', true, true], ['schedule', false, true],
    ] as const) {
      const condition = fullProfile.replaceAll('github.event_name', JSON.stringify(event)).replaceAll('inputs.full_corpus', String(enabled));
      expect(new Function(`return (${condition})`)()).toBe(expected);
      fixture(root => {
        const bin = join(root, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'bun'), `#!/bin/sh
case "$*" in
  "scripts/select-e2e.ts") echo test/e2e/selected.test.ts ;;
  "scripts/e2e-matrix.ts prepare") cat > "$RUNNER_TEMP/received-selection"; echo '{}' ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
        const run = spawnSync('bash', ['-e', '-c', select], {
          encoding: 'utf8', env: { ...process.env, FULL_CORPUS: String(expected), PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root, GITHUB_OUTPUT: join(root, 'outputs') },
        });
        expect(run.status, run.stderr).toBe(0);
        expect(readFileSync(join(root, 'received-selection'), 'utf8')).toBe(expected ? '' : 'test/e2e/selected.test.ts\n');
      });
    }
  });
});
