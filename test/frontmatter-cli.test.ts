import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const fence = '---';
const CLI = ['run', 'src/cli.ts', 'frontmatter'];

function runCli(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(process.execPath, [...CLI, ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? -1,
  };
}

describe('gbrain frontmatter CLI (B4)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fm-cli-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('--help works without a DB', () => {
    const { stdout, code } = runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('frontmatter validation');
  });

  test('validate clean file: exit 0, OK message', () => {
    const f = join(tmp, 'clean.md');
    writeFileSync(f, `${fence}\ntype: concept\ntitle: ok\n${fence}\n\nbody`);
    const { stdout, code } = runCli(['validate', f]);
    expect(code).toBe(0);
    expect(stdout).toContain('OK');
  });

  test('validate broken file: exit 1, codes listed', () => {
    const f = join(tmp, 'broken.md');
    writeFileSync(f, `${fence}\ntype: concept\ntitle: "P "I" L"\n${fence}\n\nbody`);
    const { stdout, code } = runCli(['validate', f]);
    expect(code).toBe(1);
    expect(stdout).toContain('NESTED_QUOTES');
  });

  test('validate --json envelope shape', () => {
    const f = join(tmp, 'broken.md');
    writeFileSync(f, `${fence}\ntype: concept\ntitle: "P "I" L"\n${fence}\n\nbody`);
    const { stdout } = runCli(['validate', f, '--json']);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.total_files).toBe(1);
    expect(env.results[0].errors.length).toBeGreaterThan(0);
    expect(env.results[0].errors[0]).toHaveProperty('code');
  });

  test('validate --fix --dry-run does not write', () => {
    const f = join(tmp, 'broken.md');
    const original = `${fence}\ntype: concept\ntitle: "P "I" L"\n${fence}\n\nbody`;
    writeFileSync(f, original);
    const { stdout, code } = runCli(['validate', f, '--fix', '--dry-run']);
    expect(stdout).toContain('would fix');
    expect(readFileSync(f, 'utf8')).toBe(original);
    expect(existsSync(f + '.bak')).toBe(false);
    // exit 0 with --fix even when issues remain (the fix path is the success path)
    expect(code).toBe(0);
  });

  test('validate --fix writes centralized backup and rewrites in place', () => {
    const f = join(tmp, 'broken.md');
    const gbrainHome = join(tmp, 'home');
    const original = `${fence}\ntype: concept\ntitle: "P "I" L"\n${fence}\n\nbody`;
    writeFileSync(f, original);
    const { stdout, code } = runCli(['validate', f, '--fix'], { GBRAIN_HOME: gbrainHome });
    expect(code).toBe(0);
    expect(existsSync(f + '.bak')).toBe(false);
    expect(stdout).toContain('centralized backups');
    const backupDir = join(gbrainHome, '.gbrain', 'backups', 'frontmatter');
    const backup = spawnSync('find', [backupDir, '-type', 'f', '-name', 'broken.md.bak'], { encoding: 'utf8' });
    const backupPath = backup.stdout.trim().split('\n').filter(Boolean)[0];
    expect(backupPath).toBeTruthy();
    expect(readFileSync(backupPath, 'utf8')).toBe(original);
    expect(readFileSync(f, 'utf8')).toMatch(/^title: '.*'\s*$/m);
  });

  test('validate --fix succeeds on a non-git path (no dirty-tree guard)', () => {
    // tmp is not a git repo; --fix must still work.
    const f = join(tmp, 'broken.md');
    const gbrainHome = join(tmp, 'home');
    writeFileSync(f, `${fence}\ntype: concept\ntitle: "A "B" C"\n${fence}\n\nbody`);
    const { code } = runCli(['validate', f, '--fix'], { GBRAIN_HOME: gbrainHome });
    expect(code).toBe(0);
    expect(existsSync(f + '.bak')).toBe(false);
    expect(existsSync(join(gbrainHome, '.gbrain', 'backups', 'frontmatter'))).toBe(true);
  });

  test('validate scans a directory recursively, skips non-.md files', () => {
    mkdirSync(join(tmp, 'subdir'), { recursive: true });
    writeFileSync(join(tmp, 'a.md'), `${fence}\ntype: concept\ntitle: A\n${fence}\n\nbody`);
    writeFileSync(join(tmp, 'subdir', 'b.md'), `${fence}\ntype: concept\ntitle: B\n${fence}\n\nbody`);
    writeFileSync(join(tmp, 'README.md'), 'meta');  // skipped by isSyncable
    writeFileSync(join(tmp, 'image.png'), 'not markdown');
    const { stdout } = runCli(['validate', tmp, '--json']);
    const env = JSON.parse(stdout);
    // Two .md files: a.md, subdir/b.md. README.md is filtered by isSyncable.
    expect(env.total_files).toBe(2);
  });

  test('generate --fix skips catch-all note writes unless explicitly included', () => {
    const gbrainHome = join(tmp, 'home');
    writeFileSync(join(tmp, 'random.md'), '# Random\n\nbody');
    writeFileSync(join(tmp, 'notes.md'), '# Also Random\n\nbody');

    const skipped = runCli(['generate', tmp, '--fix', '--json'], { GBRAIN_HOME: gbrainHome });
    expect(skipped.code).toBe(0);
    const skippedEnv = JSON.parse(skipped.stdout);
    expect(skippedEnv.generated).toBe(0);
    expect(skippedEnv.skippedCatchAll).toBe(2);
    expect(readFileSync(join(tmp, 'random.md'), 'utf8')).toBe('# Random\n\nbody');

    const included = runCli(['generate', tmp, '--fix', '--json', '--include-catch-all'], { GBRAIN_HOME: gbrainHome });
    expect(included.code).toBe(0);
    const includedEnv = JSON.parse(included.stdout);
    expect(includedEnv.generated).toBe(2);
    expect(readFileSync(join(tmp, 'random.md'), 'utf8')).toContain('type: note');
    expect(existsSync(join(gbrainHome, '.gbrain', 'backups', 'frontmatter'))).toBe(true);
    expect(existsSync(join(tmp, 'random.md.bak'))).toBe(false);
  });

  test('validate missing path errors clearly', () => {
    const { stderr, code } = runCli(['validate', join(tmp, 'does-not-exist.md')]);
    expect(code).toBe(1);
    expect(stderr).toContain('not found');
  });
});
