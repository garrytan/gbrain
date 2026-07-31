/**
 * End-to-end durability hook + helper (v0.42.44): the generated bash actually
 * pushes. Real git, local bare remote. Validates the D13 guarantee (helper),
 * the D9 self-contained local hook, and the D7 "one push-retry template" claim
 * (the hook works even with the committed helper deleted).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';

// #2943 root cause: `env: process.env` is REQUIRED here. Bun snapshots
// process.env at startup, so without it the spawned git — and any post-commit
// hook it fires — is blind to beforeEach's HOME/GBRAIN_HOME mutations (the
// same Bun quirk as #2747, see resolveGbrainCliPath in brain-repo-durability).
// Pre-fix, the hook under test resolved ${GBRAIN_HOME:-$HOME/.gbrain} to the
// OPERATOR'S REAL ~/.gbrain: it wrote its log lines there (polluting the real
// brain-push.log on every run), the LOCAL-ONLY test never saw them in the
// temp log it polls, and the assertion only passed when the scaffolding push
// from beforeEach (spawned by hardenBrainRepo WITH explicit env) happened to
// still be in flight, lose the ref race, and retry AFTER the test had pointed
// origin at the dead path — an accidental, load-dependent signal. That race
// is the CI flake.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env,
  }).trim();
}
function originHead(bare: string): string {
  return git(bare, 'rev-parse', 'refs/heads/main');
}
// #2943: 30s poll deadlines (was 8s) for headroom under loaded CI shards —
// the unreachable-origin path runs ~6 sequential process spawns after the
// hook detaches. Every hook test also passes an explicit 60_000 third-arg
// timeout: bun 1.3.14 IGNORES bunfig.toml's `timeout` key, so a bare
// `bun test` enforces its 5000ms default and killed these tests before the
// internal deadline could even elapse (the runner scripts pass --timeout
// explicitly, which is why the inversion only bit direct local runs).
async function waitForOrigin(bare: string, expectSha: string, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (originHead(bare) === expectSha) return true; } catch { /* */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

/** #2943 (index.lock form): hardenBrainRepo installs the post-commit hook
 * BEFORE committing the scaffolding, so that commit fires the hook and
 * detaches a background brain_push. If that push loses the ref race against
 * hardenBrainRepo's own synchronous push, it falls back to `git pull
 * --rebase`, which takes .git/index.lock — racing the test body's first git
 * calls ("Unable to create '.../.git/index.lock': File exists"). Wait for the
 * detached push's terminal log line before handing the repo to the test. */
async function waitForHookPushSettled(ms = 30_000): Promise<void> {
  const log = join(process.env.GBRAIN_HOME!, 'brain-push.log');
  const terminal = /\[push\] (ok|lock-timeout|LOCAL-ONLY)/;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(log) && terminal.test(readFileSync(log, 'utf-8'))) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`detached hook push did not settle within ${ms}ms (${log})`);
}

let root: string, work: string, bare: string;
let oldHome: string | undefined, oldGbrainHome: string | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'bdh-'));
  oldHome = process.env.HOME; oldGbrainHome = process.env.GBRAIN_HOME;
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  process.env.GBRAIN_HOME = join(process.env.HOME, '.gbrain');
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore', env: process.env });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore', env: process.env });
  git(work, 'config', 'user.email', 't@t.t'); git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'init'); git(work, 'push', '-q', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', 'main');
  await hardenBrainRepo({ repoPath: work, sourceId: 'wiki', pat: 'ghp_x', installCron: false });
  await waitForHookPushSettled();
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldGbrainHome;
  delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  rmSync(root, { recursive: true, force: true });
});

describe('brain-commit-push.sh (D13 guarantee)', () => {
  test('add → commit → push lands on origin', () => {
    mkdirSync(join(work, 'people'), { recursive: true });
    writeFileSync(join(work, 'people', 'alice.md'), '# alice\n');
    // helper requires explicit path; stages people/alice.md
    execFileSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), 'add alice', 'people/alice.md'], {
      cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
    expect(originHead(bare)).toBe(git(work, 'rev-parse', 'HEAD'));
    // origin actually has the file
    const verify = mkdtempSync(join(root, 'verify-'));
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, verify], { stdio: 'ignore', env: process.env });
    expect(existsSync(join(verify, 'people', 'alice.md'))).toBe(true);
  });

  test('refuses success when the push cannot land (exit non-zero)', () => {
    git(work, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
    writeFileSync(join(work, 'x.md'), 'x\n');
    let code = 0;
    try {
      execFileSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), 'msg', 'x.md'], {
        cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
    } catch (e: any) { code = e.status ?? 1; }
    expect(code).not.toBe(0); // committed but push failed → loud failure
  });

  test('refuses a blind add (no explicit path)', () => {
    let code = 0;
    try {
      execFileSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), 'msg'], {
        cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
    } catch (e: any) { code = e.status ?? 1; }
    expect(code).toBe(2);
  });

  test('#2426 — commits a MODIFIED tracked file even when the remote advanced (commit before pull)', () => {
    // Pre-fix, the helper ran `git pull --rebase` BEFORE staging, so any dirty
    // tree (a modified/enriched page — exactly the write-through case) aborted
    // with 'cannot pull with rebase: You have unstaged changes' (exit 3). The
    // helper could only ever commit untracked-NEW files, never modifications.
    // Remove the post-commit hook so its background push can't race the
    // helper's own push (macOS has no flock to serialize them) — this test
    // targets the HELPER's ordering; hook behavior is covered below.
    rmSync(join(work, '.git', 'hooks', 'post-commit'));
    // Advance the remote from a second clone so a pull is genuinely needed.
    const other = mkdtempSync(join(root, 'other-'));
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, other], { stdio: 'ignore', env: process.env });
    git(other, 'config', 'user.email', 'o@o.o'); git(other, 'config', 'user.name', 'other');
    writeFileSync(join(other, 'remote.md'), 'from other\n');
    git(other, 'add', 'remote.md'); git(other, 'commit', '-qm', 'remote change'); git(other, 'push', '-q', 'origin', 'main');

    // Dirty MODIFICATION of a tracked file in the hardened clone (write-through shape).
    writeFileSync(join(work, 'README.md'), 'modified by write-through\n');
    execFileSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), 'wt: README', 'README.md'], {
      cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });

    // Both the remote's commit and ours are on origin/main.
    const subjects = git(bare, 'log', '--format=%s', 'main');
    expect(subjects).toContain('wt: README');
    expect(subjects).toContain('remote change');
    // Working tree is clean — the modification was committed, not stranded.
    expect(git(work, 'status', '--porcelain', 'README.md')).toBe('');
  });
});

describe('post-commit hook (D9 local, D7 self-contained)', () => {
  test('a direct commit auto-pushes in the background', async () => {
    writeFileSync(join(work, 'note.md'), 'note\n');
    git(work, 'add', 'note.md'); git(work, 'commit', '-qm', 'note'); // fires .git/hooks/post-commit
    const head = git(work, 'rev-parse', 'HEAD');
    expect(await waitForOrigin(bare, head)).toBe(true);
  }, 60_000);

  test('the hook works even with the committed helper deleted (self-contained)', async () => {
    rmSync(join(work, 'scripts', 'brain-commit-push.sh'));
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'remove helper');
    const head = git(work, 'rev-parse', 'HEAD');
    expect(await waitForOrigin(bare, head)).toBe(true);
  }, 60_000);

  test('logs a clear LOCAL-ONLY line when origin is unreachable', async () => {
    git(work, 'remote', 'set-url', 'origin', join(root, 'gone2.git'));
    writeFileSync(join(work, 'orphan.md'), 'o\n');
    git(work, 'add', 'orphan.md'); git(work, 'commit', '-qm', 'orphan');
    const log = join(process.env.GBRAIN_HOME!, 'brain-push.log');
    const deadline = Date.now() + 30_000;
    let found = false;
    while (Date.now() < deadline) {
      if (existsSync(log) && readFileSync(log, 'utf-8').includes('NEEDS ATTENTION')) { found = true; break; }
      await new Promise(r => setTimeout(r, 150));
    }
    expect(found).toBe(true);
  }, 60_000);
});
