/**
 * GST-2456 (#8902 part 2): every push gbrain makes from an unmanaged checkout range-scans the commits it publishes:
 * `gbrain git commit-push` in commit mode, with --pending and with --untrack, the post-commit hook harden installs, the durability
 * helper's `_run` (and its fallback, which now pushes nothing without gbrain), with tags never riding along. Also
 * `gbrain sources push` against an upstream that is not origin, its --json refusal, and the scan's time budget. Real git
 * against local bare remotes; synthetic credentials only. HOME, GBRAIN_HOME, PATH and the file transport switch are
 * process-wide.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSources } from '../src/commands/sources.ts';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { notePending } from '../src/core/git/commit-push.ts';
import { stagedScanPublishRefusal } from '../src/core/git/range-secret-scan.ts';
import { workspacePush } from '../src/core/workspace-push.ts';

const T = 90_000;
const TOKEN = 'ghp_' + 'Rk3w'.repeat(9);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
let dir: string, root: string, remote: string, base: string;
let saved: Record<string, string | undefined>;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args],
  { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const remoteTip = () => git(remote, 'rev-parse', 'refs/heads/main');
const plainCommit = (file: string, text: string, message = 'script edit') => {
  writeFileSync(join(root, file), text);
  git(root, 'add', file); git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
};
/** A credential committed by a script and removed by its next commit: only the history holds it. */
const removedSecret = () => { plainCommit('notes.md', `deploy ${TOKEN}\n`); plainCommit('notes.md', 'removed\n'); };
const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['--no-env-file', CLI, ...args],
  { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1', ...env } });
const pushLog = () => { const p = join(dir, '.gbrain', 'brain-push.log'); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
const envelope = (stdout: string) => JSON.parse(stdout) as { code?: string; error?: string; message?: string };
const sourcesPush = () => workspacePush({ dir: root, branch: 'main', allowUnverifiedRemote: true });
/** `gbrain sources push` in-process (it needs no brain with --path): its exit code, stdout and stderr. */
async function sourcesPushCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [], err: string[] = [];
  const restore = { exit: process.exit, log: console.log, error: console.error };
  let code = 0;
  process.exit = ((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c ?? 0 }); }) as never;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  try { await runSources({} as BrainEngine, ['push', ...args]); }
  catch (e) { if (typeof (e as { exitCode?: number }).exitCode !== 'number') throw e; code = (e as { exitCode: number }).exitCode; }
  finally { Object.assign(process, { exit: restore.exit }); console.log = restore.log; console.error = restore.error; }
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}
async function until(check: () => boolean, ms = 45_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) if (check()) return true;
  return check();
}
/** A `gbrain` on PATH that runs this checkout's CLI, so harden captures it as it captures a real install. */
function installGbrainShim(): void {
  const bin = join(dir, 'gbrain-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gbrain'), `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-2456-')));
  saved = { HOME: process.env.HOME, GBRAIN_HOME: process.env.GBRAIN_HOME, PATH: process.env.PATH, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT };
  process.env.HOME = dir;
  process.env.GBRAIN_HOME = dir;
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  remote = join(dir, 'origin.git'); root = join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', remote, root], { stdio: 'ignore', env: process.env });
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  plainCommit('README.md', 'initial\n', 'initial'); git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'remote', 'set-head', 'origin', 'main');
  base = remoteTip();
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('gbrain git commit-push', () => {
  test('commit mode refuses the earlier commits it would push, keeps its own commit and logs the refusal', () => {
    removedSecret();
    writeFileSync(join(root, 'page.md'), 'new page\n');
    const r = cli(['git', 'commit-push', '--json', '-m', 'page', '--', 'page.md']);
    expect(r.status).not.toBe(0);
    expect(envelope(r.stdout).code ?? envelope(r.stdout).error).toBe('publish_secret_found');
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(remoteTip()).toBe(base);
    expect(git(root, 'show', 'HEAD:page.md')).toBe('new page');
    expect(pushLog()).toContain('LOCAL-ONLY, NEEDS ATTENTION: main @ - the push was refused (publish_secret_found)');
  }, T);

  test('--pending refuses the earlier commits it would push', () => {
    removedSecret();
    writeFileSync(join(root, 'pending.md'), 'written through\n');
    notePending(root, ['pending.md']);
    const r = cli(['git', 'commit-push', '--pending', '--json']);
    expect(r.status).not.toBe(0);
    expect(envelope(r.stdout).code ?? envelope(r.stdout).error).toBe('publish_secret_found');
    expect(remoteTip()).toBe(base);
    expect(git(root, 'show', 'HEAD:pending.md')).toBe('written through');
  }, T);

  test('--untrack refuses the earlier commits it would push and keeps its own untrack commit', () => {
    removedSecret();
    const r = cli(['git', 'commit-push', '--untrack', '--json', '-m', 'stop tracking the readme', '--', 'README.md']);
    expect(r.status).not.toBe(0);
    expect(envelope(r.stdout).code ?? envelope(r.stdout).error).toBe('publish_secret_found');
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(remoteTip()).toBe(base);
    expect(git(root, 'ls-tree', '--name-only', 'HEAD', '--', 'README.md')).toBe('');
    expect(git(root, 'log', '-1', '--format=%s')).toBe('stop tracking the readme');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('initial\n');
  }, T);

  test('--push-only, the unattended cron form with --keep-checkout included, scans without --scan-secrets', () => {
    removedSecret();
    for (const args of [['--push-only'], ['--push-only', '--keep-checkout']]) {
      const r = cli(['git', 'commit-push', ...args, '--json']);
      expect(r.status).not.toBe(0);
      expect(envelope(r.stdout).code ?? envelope(r.stdout).error).toBe('publish_secret_found');
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
    }
    expect(remoteTip()).toBe(base);
  }, T);

  test('gbrain git scan previews what the next push would refuse and writes nothing; the fingerprint in .gbrain-scan-allow clears it', () => {
    removedSecret();
    const head = git(root, 'rev-parse', 'HEAD');
    const status = git(root, 'status', '--porcelain');
    const r = cli(['git', 'scan', '--json']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as { from: string; to: string; commits: number; would_refuse: string | null; findings: Array<{ path: string; fingerprint: string }> };
    expect(doc).toMatchObject({ from: base, to: head, commits: 2, would_refuse: 'publish_secret_found' });
    expect(doc.findings.map(f => f.path)).toEqual(['notes.md']);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect([remoteTip(), git(root, 'rev-parse', 'HEAD'), git(root, 'status', '--porcelain'), pushLog()]).toEqual([base, head, status, '']);
    const human = cli(['git', 'scan', '--from', base, '--to', head]);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain(`notes.md:1`);
    expect(human.stdout).toContain(doc.findings[0]!.fingerprint);
    writeFileSync(join(root, '.gbrain-scan-allow'), `# a synthetic test credential\n${doc.findings[0]!.fingerprint}\n`);
    expect(JSON.parse(cli(['git', 'scan', '--json']).stdout)).toMatchObject({ would_refuse: null, findings: [] });
    expect(cli(['git', 'commit-push', '--push-only', '--keep-checkout', '--json']).status).toBe(0);
    expect(remoteTip()).toBe(head);
    for (const args of [['--from', 'no-such-rev'], ['--scan-timeout', 'soon']]) expect(envelope(cli(['git', 'scan', ...args, '--json']).stdout).code ?? '').toBe('commit_paths_invalid');
  }, T);

  test('--dry-run names the managed-worktree marker, or none', () => {
    expect(JSON.parse(cli(['git', 'commit-push', '--dry-run', '--push-only', '--json']).stdout).managed).toBeNull();
    writeFileSync(join(git(root, 'rev-parse', '--absolute-git-dir'), 'gbrain-managed.json'), '{}');
    const doc = JSON.parse(cli(['git', 'commit-push', '--dry-run', '--push-only', '--json']).stdout) as { managed: { root: string; evidence: string } };
    expect(doc.managed.evidence).toEndWith('gbrain-managed.json');
  }, T);

  test('push.followTags never publishes an annotated tag, whose message nothing scans', () => {
    git(root, 'config', 'push.followTags', 'true');
    plainCommit('notes.md', 'clean\n');
    git(root, 'tag', '-a', 'v1', '-m', `release ${TOKEN}`);
    const r = cli(['git', 'commit-push', '--push-only', '--json']);
    expect(r.status).toBe(0);
    expect(remoteTip()).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(remote, 'tag', '-l')).toBe('');
  }, T);

  test('--scan-timeout gives the scan a longer budget and is checked', () => {
    plainCommit('notes.md', 'clean\n');
    expect(cli(['git', 'commit-push', '--push-only', '--scan-timeout', '1200', '--json']).status).toBe(0);
    expect(remoteTip()).toBe(git(root, 'rev-parse', 'HEAD'));
    for (const args of [['--push-only', '--scan-timeout', 'soon'], ['--push-only', '--scan-timeout', '0'], ['--pull', '--scan-timeout', '60']]) {
      const r = cli(['git', 'commit-push', ...args, '--json']);
      expect(r.status).not.toBe(0);
      expect(envelope(r.stdout).code ?? envelope(r.stdout).error).toBe('commit_paths_invalid');
    }
  }, T);
});

describe('the post-commit hook and the durability helper', () => {
  let published: string;
  beforeEach(async () => {
    installGbrainShim();
    await hardenBrainRepo({ repoPath: root, sourceId: 'wiki', pat: 'ghp_x', installCron: false });
    published = remoteTip();
  });

  test('the hook refuses a plain git commit that carries a credential, and logs it', async () => {
    plainCommit('notes.md', `deploy ${TOKEN}\n`);
    expect(await until(() => pushLog().includes('the push was refused (publish_secret_found)'))).toBe(true);
    expect(remoteTip()).toBe(published);
  }, T);

  test('the helper refuses the earlier commits it would push', () => {
    rmSync(join(root, '.git', 'hooks', 'post-commit'));
    removedSecret();
    writeFileSync(join(root, 'page.md'), 'new page\n');
    const r = spawnSync('bash', [join(root, 'scripts', 'brain-commit-push.sh'), 'page', 'page.md'], { cwd: root, encoding: 'utf8', env: process.env, timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('publish_secret_found');
    expect(r.stderr).not.toContain(TOKEN);
    expect(remoteTip()).toBe(published);
  }, T);

  test('the helper without gbrain commits locally and pushes nothing, since only gbrain scans before it pushes', () => {
    rmSync(join(root, '.git', 'hooks', 'post-commit'));
    spawnSync('git', ['-C', root, 'config', '--local', '--unset', 'gbrain.cliPath']);
    writeFileSync(join(root, 'page.md'), 'clean page\n');
    const r = spawnSync('bash', [join(root, 'scripts', 'brain-commit-push.sh'), 'page', 'page.md'],
      { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: '/usr/bin:/bin', GIT_CONFIG_PARAMETERS: "'protocol.file.allow=always'" } });
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('NOT PUSHED');
    expect(git(root, 'show', 'HEAD:page.md')).toBe('clean page');
    expect(remoteTip()).toBe(published);
    expect(pushLog()).toContain('not pushed: gbrain is not installed');
  }, T);
});

describe('gbrain sources push', () => {
  test('--json prints the refusal on stdout and exits 5', async () => {
    removedSecret();
    const r = await sourcesPushCli(['--path', root, '--allow-unverified-remote', '--json']);
    expect(r.code).toBe(5);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, status: 'blocked_history', code: 'publish_secret_found' });
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(remoteTip()).toBe(base);
  }, T);

  test('scans and leases against origin itself when the branch tracks another remote', async () => {
    const upstream = join(dir, 'upstream.git');
    execFileSync('git', ['clone', '-q', '--bare', remote, upstream]);
    git(root, 'remote', 'add', 'upstream', upstream);
    git(root, 'fetch', '-q', 'upstream');
    git(root, 'branch', '-q', '-u', 'upstream/main');
    git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
    plainCommit('notes.md', 'clean earlier work\n');
    const result = await sourcesPush();
    expect(result.status).toBe('pushed');
    expect(remoteTip()).toBe(git(root, 'rev-parse', 'HEAD'));
  }, T);

  test('push.followTags never publishes an annotated tag', async () => {
    git(root, 'config', 'push.followTags', 'true');
    plainCommit('notes.md', 'clean\n');
    git(root, 'tag', '-a', 'v1', '-m', `release ${TOKEN}`);
    expect((await sourcesPush()).status).toBe('pushed');
    expect(git(remote, 'tag', '-l')).toBe('');
  }, T);
});

describe('the scan budget', () => {
  test('a scan that runs out of time refuses naming the same command with a longer --scan-timeout', () => {
    const retry = ['gbrain', 'sources', 'push', '--path', root];
    const refusal = stagedScanPublishRefusal(root, '', git(root, 'rev-parse', 'HEAD'), { timeoutMs: 1, retryArgv: retry });
    expect(refusal?.code).toBe('publish_scan_unreadable');
    expect(refusal?.message).toContain('time budget');
    expect(refusal?.suggestion).toContain('--scan-timeout 1200');
    expect(refusal?.fix).toMatchObject({ actor: 'agent', argv: [...retry, '--scan-timeout', '1200'] });
    expect(JSON.parse(String(refusal?.detail))).toMatchObject({ timed_out: true });
  }, T);

  test('a whole-history scan says what it reads on its progress channel', () => {
    plainCommit('notes.md', 'clean\n');
    const lines: string[] = [];
    expect(stagedScanPublishRefusal(root, '', git(root, 'rev-parse', 'HEAD'), { progress: line => lines.push(line) })).toBeNull();
    expect(lines[0]).toStartWith('secret scan: reading 2 commit(s), the whole history');
    expect(lines.at(-1)).toMatch(/^secret scan: read 2 commit\(s\) in \d+ s$/);
  }, T);
});
