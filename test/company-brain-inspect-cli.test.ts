import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseCompanyBrainInspectionArgs } from '../src/commands/company-brain-inspect.ts';
import { sourcesOperations } from '../src/core/ops/sources.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

const cli = resolve(import.meta.dir, '../src/cli.ts');
const temporary: string[] = [];

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'company-inspect-cli-'));
  temporary.push(root);
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(join(repo, 'customers'), { recursive: true });
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ engine: 'postgres', database_url: 'postgresql://invalid.invalid:1/not_a_brain' }));
  writeFileSync(join(repo, 'customers/acme-example.md'), '---\ntype: customer\ntitle: Acme Example\n---\nA fictional account.\n');
  await makeGitFixture(repo);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'Fictional company fixture']);
  return { root, repo, home };
}

function run(home: string, args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('GBRAIN_') && !key.startsWith('GIT_') && !['DATABASE_URL', 'PGLITE_DATA_DIR'].includes(key)));
  const result = Bun.spawnSync([process.execPath, cli, 'sources', ...args], {
    env: { ...env, GBRAIN_HOME: home, GBRAIN_NO_BANNER: '1' },
    cwd: home,
    timeout: 20_000,
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('company repository inspection CLI', () => {
  test('parses selection flags without accepting conflicting inputs', () => {
    expect(parseCompanyBrainInspectionArgs(['repo', '--profile=company-brain', '--include', 'customers/**', '--exclude=scripts/**', '--json']))
      .toEqual({ path: 'repo', profile: 'company-brain', include: ['customers/**'], exclude: ['scripts/**'], json: true });
    for (const args of [[], ['one', 'two'], ['repo', '--out'], ['repo', '--profile', 'other'], ['repo', '--execute']]) {
      expect(() => parseCompanyBrainInspectionArgs(args)).toThrow();
    }
  });

  test('inspects without opening a configured unreachable database or changing source content', async () => {
    const f = await fixture();
    const original = readFileSync(join(f.repo, 'customers/acme-example.md'));
    const config = readFileSync(join(f.home, '.gbrain/config.json'));
    const result = run(f.home, ['inspect', f.repo, '--profile', 'company-brain', '--json']);
    expect(result.code).toBe(0);
    const value = JSON.parse(result.out);
    expect(value).toMatchObject({ schema_version: 1, status: 'ready', code: 'ok' });
    expect(value.plan.counts).toMatchObject({ tracked: 1, included: 1 });
    expect(result.out).not.toContain('\u001b');
    expect(readFileSync(join(f.repo, 'customers/acme-example.md'))).toEqual(original);
    expect(readFileSync(join(f.home, '.gbrain/config.json'))).toEqual(config);
    expect(readdirSync(join(f.home, '.gbrain'))).toEqual(['config.json']);
    expect(execFileSync('git', ['-C', f.repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  }, 30_000);

  test('writes only an explicitly requested private plan and never overwrites it', async () => {
    const f = await fixture();
    const out = join(f.root, 'plans', 'review.json');
    const args = ['inspect', f.repo, '--profile', 'company-brain', '--json', '--out', out];
    expect(run(f.home, args).code).toBe(0);
    const saved = readFileSync(out, 'utf8');
    expect(JSON.parse(saved).plan_digest).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform !== 'win32') {
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(statSync(join(f.root, 'plans')).mode & 0o777).toBe(0o700);
    }
    const duplicate = run(f.home, args);
    expect(duplicate.code).toBe(1);
    expect(JSON.parse(duplicate.out).code).toBe('plan_output_failed');
    expect(readFileSync(out, 'utf8')).toBe(saved);
  }, 30_000);

  test('reports blocked sources and usage errors as clean JSON', async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, 'customers/acme-example.md'), 'Uncommitted replacement.');
    const blocked = run(f.home, ['inspect', f.repo, '--profile', 'company-brain', '--json']);
    expect(blocked.code).toBe(1);
    expect(JSON.parse(blocked.out).status).toBe('blocked');
    const usage = run(f.home, ['inspect', '--json']);
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.out).code).toBe('invalid_params');
  }, 30_000);

  test('help is database-free and thin clients refuse before inspection', async () => {
    const f = await fixture();
    expect(run(f.home, ['inspect', '--help']).out).toContain('No database');
    writeFileSync(join(f.home, '.gbrain/config.json'), JSON.stringify({ engine: 'mcp', remote_mcp: { mcp_url: 'https://example.invalid/mcp' } }));
    const denied = run(f.home, ['inspect', f.repo, '--json']);
    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.out).code).toBe('permission_denied');
  }, 30_000);

  test('unknown flags keep the same versioned JSON and usage exit contract', async () => {
    const f = await fixture();
    const json = run(f.home, ['inspect', f.repo, '--banana', '--json']);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out)).toMatchObject({ schema_version: 1, status: 'blocked', code: 'invalid_params' });
    const human = run(f.home, ['inspect', f.repo, '--banana']);
    expect(human.code).toBe(2);
    expect(human.out).toBe('');
    expect(human.err).toContain('Unknown inspect option');
  }, 30_000);

  test('operation trust boundary refuses remote and unspecified callers before any filesystem access', async () => {
    const operation = sourcesOperations.find(op => op.name === 'sources_inspect')!;
    expect(operation.localOnly).toBe(true);
    expect(operation.scope).toBe('read');
    expect(operation.mutating).toBe(false);
    for (const remote of [true, undefined]) {
      await expect(operation.handler({ remote } as OperationContext, { path: '/not-a-repository' }))
        .rejects.toMatchObject({ code: 'permission_denied' });
    }
  });
});
