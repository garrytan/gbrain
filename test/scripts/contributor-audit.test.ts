/**
 * scripts/contributor-audit.ts — the mechanical contributor audit.
 *
 * Protects: (1) the classification of each merged change and trial-merged PR
 * on the offline fixture range (scripts/contributor-audit-fixture.ts), driven
 * through the real CLI; (2) the scrubbed environment untrusted test code sees;
 * (3) resume against pinned PR heads; (4) the agent-contract refusals.
 * Regressions it catches: a whole-file revert or a skipped baseline changing a
 * verdict, an ambient DATABASE_URL or credential leaking into contributor code,
 * a resume mixing results from different PR heads.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixture } from '../../scripts/contributor-audit-fixture.ts';
import { classifyPath, classifyReversed, parseArgs, sandboxEnv } from '../../scripts/contributor-audit.ts';

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'contributor-audit.ts');

function audit(cwd: string, args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withFixture(fn: (f: ReturnType<typeof buildFixture>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'contributor-audit-'));
  try { fn(buildFixture(join(dir, 'repo'))); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('contributor audit on the fixture range', () => {
  test('classifies discriminating, non-discriminating, setup-failure, docs-only and conflicting changes, keeping later fixes in place', () => {
    withFixture(f => {
      const r = audit(f.dir, [`${f.base}..${f.head}`, '--prs', f.prsManifest, '--json', '--skip-security', '--skip-lanes']);
      expect(r.code, r.stderr).toBe(1);
      const report = JSON.parse(r.stdout);
      const byPr = Object.fromEntries(Object.values(report.cases as Record<string, any>).map(c => [c.pr, c]));
      expect(byPr[101].result).toBe('discriminates');
      expect(byPr[101].runs.baseline).toMatchObject({ exit: 0, pass: 1, fail: 0 });
      expect(byPr[101].runs.reversed).toMatchObject({ pass: 0, fail: 1 });
      expect(byPr[101].runs.restored).toMatchObject({ exit: 0, pass: 1, fail: 0 });
      expect(byPr[101].tests).toEqual(['test/clamp.test.ts']);
      expect(byPr[102].result).toBe('does_not_discriminate');
      expect(byPr[103]).toMatchObject({ result: 'setup_failed', reason: 'baseline_red' });
      expect(byPr[104]).toMatchObject({ result: 'not_audited', reason: 'no_product_change' });
      expect(byPr[106]).toMatchObject({ result: 'does_not_discriminate', audited_at: f.head });
      expect(byPr[107]).toMatchObject({ result: 'not_audited', reason: 'no_tests' });
      expect(byPr[105].result).toBe('conflict');
      expect(byPr[105].reason).toContain('src/clamp.ts');
      expect(report.exit_code).toBe(1);

      const pinned = JSON.parse(readFileSync(join(report.run_dir, 'prs.pinned.json'), 'utf8'));
      expect(pinned.prs[0].head).toMatch(/^[0-9a-f]{40}$/);
      expect(pinned.base).toBe(f.base);

      const md = audit(f.dir, [`${f.base}..${f.head}`, '--resume', '--prs', join(report.run_dir, 'prs.pinned.json'), '--skip-security', '--skip-lanes']);
      expect(md.code).toBe(1);
      expect(md.stderr).toContain('resuming: 7 case(s) already done');
      expect(md.stdout).toContain('| **discriminates** |');
      expect(md.stdout).toContain('| Human verdict |');
    });
  });

  test('resume refuses when the PR pins differ from the saved run', () => {
    withFixture(f => {
      const range = `${f.base}..${f.head}`;
      expect(audit(f.dir, [range, '--prs', f.prsManifest, '--skip-security', '--skip-lanes']).code).toBe(1);
      const other = join(f.dir, 'other.json');
      writeFileSync(other, JSON.stringify({ prs: [{ head: f.base }] }));
      const r = audit(f.dir, [range, '--prs', other, '--resume', '--json', '--skip-security', '--skip-lanes']);
      expect(r.code).toBe(2);
      const env = JSON.parse(r.stdout);
      expect(env.code).toBe('preview_changed');
      expect(env.fix.argv).toContain('--resume');
    });
  });

  test('human verdicts print in their own column and never replace the mechanical result', () => {
    withFixture(f => {
      const verdicts = join(f.dir, 'verdicts.json');
      const first = audit(f.dir, [`${f.base}..${f.head}`, '--json', '--skip-security', '--skip-lanes']);
      const id = Object.values(JSON.parse(first.stdout).cases as Record<string, any>).find(c => c.pr === 102).id;
      writeFileSync(verdicts, JSON.stringify({ [id]: { verdict: 'rework', note: 'test never calls greet' } }));
      const r = audit(f.dir, [`${f.base}..${f.head}`, '--resume', '--verdicts', verdicts, '--skip-security', '--skip-lanes']);
      expect(r.stdout).toContain('| **does_not_discriminate** |');
      expect(r.stdout).toContain('| rework: test never calls greet |');
      writeFileSync(verdicts, JSON.stringify({ [id]: { verdict: 'lgtm' } }));
      const bad = audit(f.dir, [`${f.base}..${f.head}`, '--resume', '--verdicts', verdicts, '--json', '--skip-security', '--skip-lanes']);
      expect(bad.code).toBe(2);
      expect(JSON.parse(bad.stdout).code).toBe('invalid_params');
    });
  });
});

describe('untrusted code runs in a scrubbed environment', () => {
  test('the audited tests see no ambient database URL, credential or real HOME', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contributor-audit-env-'));
    try {
      const repo = join(dir, 'repo');
      const probe = join(dir, 'probe.json');
      const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
      spawnSync('mkdir', ['-p', join(repo, 'src'), join(repo, 'test')]);
      git('init', '-q', '-b', 'master');
      git('config', 'user.name', 't'); git('config', 'user.email', 't@example.invalid'); git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(repo, 'src/x.ts'), 'export const x = 1;\n');
      git('add', '-A'); git('commit', '-qm', 'base');
      git('checkout', '-qb', 'probe');
      writeFileSync(join(repo, 'src/x.ts'), 'export const x = 2;\n');
      writeFileSync(join(repo, 'test/x.test.ts'), [
        "import { expect, test } from 'bun:test';",
        "import { readdirSync, writeFileSync } from 'node:fs';",
        "import { homedir } from 'node:os';",
        "import { x } from '../src/x';",
        `test('probe', () => { writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ env: process.env, home: readdirSync(homedir()) })); expect(x).toBe(2); });`,
      ].join('\n') + '\n');
      git('add', '-A'); git('commit', '-qm', 'probe');
      git('checkout', '-q', 'master');
      git('merge', '-q', '--no-ff', 'probe', '-m', 'Merge pull request #7 from alice-example/probe');

      const r = audit(repo, ['HEAD~1..HEAD', '--json', '--skip-security', '--skip-lanes'], {
        DATABASE_URL: 'postgres://u:p@prod.example.invalid/brain',
        GBRAIN_DATABASE_URL: 'postgres://u:p@prod.example.invalid/brain',
        OPENAI_API_KEY: 'sk-fake-ambient', ANTHROPIC_API_KEY: 'sk-ant-fake', GH_TOKEN: 'ghp_fake', SSH_AUTH_SOCK: '/tmp/agent.sock',
      });
      expect(r.code, r.stderr).toBe(0);
      const seen = JSON.parse(readFileSync(probe, 'utf8')) as { env: Record<string, string>; home: string[] };
      expect(seen.env.DATABASE_URL ?? '').toBe('');
      expect(seen.env.GBRAIN_DATABASE_URL ?? '').toBe('');
      for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'SSH_AUTH_SOCK']) expect(seen.env[key]).toBeUndefined();
      expect(seen.env.HOME).not.toBe(homedir());
      expect(seen.env.GBRAIN_HOME.startsWith(seen.env.HOME)).toBe(true);
      for (const cred of ['.netrc', '.npmrc', '.git-credentials', '.ssh', '.gbrain', '.config']) expect(seen.home).not.toContain(cred);
      const allowed = new Set(Object.keys(sandboxEnv({ home: '/h', bunPath: process.execPath, cacheDir: '/c' })));
      const unexpected = Object.keys(seen.env).filter(k => !allowed.has(k) && !k.startsWith('BUN_') && !['_', 'SHLVL', 'PWD', 'OLDPWD', 'NODE_ENV'].includes(k));
      expect(unexpected).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('--postgres is the only way a database URL reaches the tests, and it must be test-shaped', () => {
    const env = sandboxEnv({ home: '/h', bunPath: '/x/bun', cacheDir: '/c', postgresUrl: 'postgres://postgres:postgres@localhost:5435/gbrain_test' });
    expect(env.DATABASE_URL).toBe('postgres://postgres:postgres@localhost:5435/gbrain_test');
    expect(env.GBRAIN_DATABASE_URL).toBe('');
    expect(env.GBRAIN_TEST_ALLOW_DATABASE_URL).toBe('1');
    expect(() => parseArgs(['a..b', '--postgres', 'postgres://u:p@db.example.invalid/brain'])).toThrow(/test-shaped/);
  });
});

describe('classification and refusals', () => {
  test('the reversed run maps onto the discrimination vocabulary', () => {
    expect(classifyReversed({ exit: 1, pass: 0, fail: 2, timedOut: false }).result).toBe('discriminates');
    expect(classifyReversed({ exit: 0, pass: 3, fail: 0, timedOut: false }).result).toBe('does_not_discriminate');
    expect(classifyReversed({ exit: 1, pass: 0, fail: 0, timedOut: false })).toEqual({ result: 'vacuous_failure', reason: 'no_test_failed' });
    expect(classifyReversed({ exit: 128, pass: 0, fail: 0, timedOut: true })).toEqual({ result: 'vacuous_failure', reason: 'timeout' });
    expect(['test/a.test.ts', 'docs/x.md', 'src/a.ts', 'CHANGELOG.md', 'src/a.spec.ts'].map(classifyPath)).toEqual(['test', 'doc', 'product', 'doc', 'test']);
  });

  test('usage and preflight refusals are agent-contract envelopes with exit 2', () => {
    withFixture(f => {
      const unknown = audit(f.dir, [`${f.base}..${f.head}`, '--frobnicate', '--json']);
      expect(unknown.code).toBe(2);
      expect(JSON.parse(unknown.stdout)).toMatchObject({ code: 'unknown_flag', fix: { argv: ['bun', 'run', 'audit:contributors', '--help'] } });
      const badRef = audit(f.dir, ['nope..HEAD', '--json', '--skip-security']);
      expect(badRef.code).toBe(2);
      const env = JSON.parse(badRef.stdout);
      expect(env.code).toBe('invalid_params');
      expect(env.why).toContain('"nope" is not a commit');
      expect(env.fix.argv).toEqual(['git', 'fetch', 'origin']);
      const noRange = audit(f.dir, ['--json']);
      expect(JSON.parse(noRange.stdout).code).toBe('invalid_params');
      expect(existsSync(join(f.dir, '.git', 'contributor-audit'))).toBe(false);
    });
  });
});
