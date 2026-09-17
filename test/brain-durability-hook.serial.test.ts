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
import { execFileSync, spawn, spawnSync } from 'child_process';
import { getLastPushOutcome, hardenBrainRepo, unhardenBrainRepo } from '../src/core/brain-repo-durability.ts';
import { crontabAvailable } from './helpers/fs-perms.ts';
import { runPull } from '../src/commands/sources-harden.ts';

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

// #2943 historical note: hardenBrainRepo installs the post-commit hook BEFORE
// committing the scaffolding, and the scaffolding commit used to fire it —
// detaching a background brain_push that raced hardenBrainRepo's own
// synchronous push on the same ref (cannot-lock-ref; the loser's `pull
// --rebase` then took .git/index.lock, racing the test body's first git
// calls). This file used to park in a waitForHookPushSettled() poll after
// every harden to let that race drain. #3925 removed the race at the source:
// commitScaffolding commits with core.hooksPath=/dev/null, so the explicit
// fail-loud push is the ONLY push and there is nothing to wait for. The
// regression test below pins that.

let root: string, work: string, bare: string;
let oldHome: string | undefined, oldGbrainHome: string | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'bdh-'));
  oldHome = process.env.HOME; oldGbrainHome = process.env.GBRAIN_HOME;
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  // CX2-8: GBRAIN_HOME is a PARENT dir (config.ts semantics — `.gbrain` is
  // appended by both the TS resolver and the bash template), so the
  // effective home is $HOME/.gbrain.
  process.env.GBRAIN_HOME = process.env.HOME;
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

describe('durability push remote confirmation (#5138)', () => {
  let intendedHead: string;

  beforeEach(() => {
    rmSync(join(work, '.git', 'hooks', 'post-commit'));
    writeFileSync(join(work, 'pending.md'), 'pending\n');
    git(work, 'add', 'pending.md');
    git(work, 'commit', '-qm', 'pending');
    intendedHead = git(work, 'rev-parse', 'HEAD');
  });

  function interceptGit(script: string): NodeJS.ProcessEnv {
    const bin = join(root, 'intercept-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env bash
set -eu
${script}
exec "$GBRAIN_TEST_REAL_GIT" "$@"
`, { mode: 0o755 });
    return {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GBRAIN_TEST_REAL_GIT: Bun.which('git')!,
      GBRAIN_TEST_PUSH_MARKER: join(root, 'push-attempted'),
    };
  }

  function pushOnly(env = process.env) {
    return spawnSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), '--push-only', 'main'], {
      cwd: work, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env,
    });
  }

  function advanceRemote(path = 'remote.md'): string {
    const other = join(root, 'other-worktree');
    git(work, 'worktree', 'add', '--detach', other, 'origin/main');
    writeFileSync(join(other, path), 'remote edit\n');
    git(other, 'add', path);
    git(other, 'commit', '-qm', 'remote advance');
    git(other, 'push', '-q', 'origin', 'HEAD:main');
    return originHead(bare);
  }

  function clonePushTarget(name: string): string {
    const target = join(root, `${name}.git`);
    git(work, 'clone', '--bare', '-q', bare, target);
    return target;
  }

  test('does not confirm a rejecting push target from the fetch repository', () => {
    const target = clonePushTarget('push target');
    const originalTargetHead = originHead(target);
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    git(work, 'remote', 'set-url', '--push', 'origin', target);
    writeFileSync(join(target, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(work, 'README.md'), 'unrelated dirty edit\n');

    const result = pushOnly();

    expect(originHead(bare)).toBe(intendedHead);
    expect(originHead(target)).toBe(originalTargetHead);
    expect(result.status).not.toBe(0);
    expect(getLastPushOutcome('main').status).toBe('needs_attention');
  });

  test('fails closed when a push path would resolve as a different remote alias', () => {
    const targetName = 'push-target';
    const target = join(work, targetName);
    git(work, 'clone', '--bare', '-q', bare, target);
    const originalTargetHead = originHead(target);
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    git(work, 'remote', 'add', targetName, bare);
    git(work, 'remote', 'set-url', '--push', 'origin', targetName);
    writeFileSync(join(target, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(work, 'README.md'), 'unrelated dirty edit\n');

    const result = pushOnly();

    expect(originHead(bare)).toBe(intendedHead);
    expect(originHead(target)).toBe(originalTargetHead);
    expect(result.status).not.toBe(0);
  });

  test.each(['pushurl', 'pushInsteadOf'])('confirms the effective %s destination without logging probe diagnostics', (configuration) => {
    const target = clonePushTarget('push target');
    if (configuration === 'pushurl') git(work, 'remote', 'set-url', '--push', 'origin', target);
    else git(work, 'config', `url.${target}.pushInsteadOf`, bare);
    writeFileSync(join(work, 'README.md'), 'unrelated dirty edit\n');
    const env = interceptGit(`if [ "$1" = push ]; then
  "$GBRAIN_TEST_REAL_GIT" "$@"
  exit 1
fi
if [ "$1" = ls-remote ] || [ "$1" = fetch ]; then
  echo "synthetic-destination-credential" >&2
fi`);

    const result = pushOnly(env);

    expect(result.status).toBe(0);
    expect(originHead(target)).toBe(intendedHead);
    expect(originHead(bare)).not.toBe(intendedHead);
    const log = readFileSync(join(process.env.HOME!, '.gbrain', 'brain-push.log'), 'utf8');
    expect(log).toContain('ok-already-on-remote main');
    expect(log).not.toContain('synthetic-destination-credential');
  });

  test.each(['first', 'last', 'neither'])('requires every push URL to contain the commit when %s target rejects', (rejecting) => {
    const targets = [clonePushTarget('first push target'), clonePushTarget('last push target')];
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    for (const target of targets) git(work, 'config', '--add', 'remote.origin.pushurl', target);
    const rejected = rejecting === 'first' ? 0 : rejecting === 'last' ? 1 : -1;
    if (rejected !== -1) {
      writeFileSync(join(targets[rejected], 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    }
    writeFileSync(join(work, 'README.md'), 'unrelated dirty edit\n');
    const env = interceptGit(`if [ "$1" = push ]; then
  "$GBRAIN_TEST_REAL_GIT" "$@" || true
  exit 1
fi`);

    const result = pushOnly(env);

    expect(result.status === 0).toBe(rejected === -1);
    for (const [index, target] of targets.entries()) {
      expect(originHead(target) === intendedHead).toBe(index !== rejected);
    }
    expect(getLastPushOutcome('main').status).toBe(rejected === -1 ? 'ok' : 'needs_attention');
  });

  test.each(['initial', 'retry'])('pushes the captured SHA when HEAD moves during the %s push', (attempt) => {
    if (attempt === 'retry') advanceRemote();
    const env = interceptGit(`if [ "$1" = push ]; then
  if [ "$GBRAIN_TEST_PUSH_ATTEMPT" = initial ] || [ -e "$GBRAIN_TEST_PUSH_MARKER" ]; then
    "$GBRAIN_TEST_REAL_GIT" rev-parse HEAD >"$GBRAIN_TEST_PUSH_MARKER"
    "$GBRAIN_TEST_REAL_GIT" reset --hard HEAD^ >/dev/null
    "$GBRAIN_TEST_REAL_GIT" "$@"
    exit 1
  fi
  : >"$GBRAIN_TEST_PUSH_MARKER"
fi`);
    env.GBRAIN_TEST_PUSH_ATTEMPT = attempt;

    const result = pushOnly(env);

    const captured = readFileSync(env.GBRAIN_TEST_PUSH_MARKER!, 'utf8').trim();
    expect(result.status).toBe(0);
    expect(originHead(bare)).toBe(captured);
    expect(git(work, 'rev-parse', 'HEAD')).not.toBe(captured);
    expect(git(bare, 'show', 'main:pending.md')).toBe('pending');
  });

  test.each(['initial', 'retry'])('does not confirm a moved HEAD ancestor when the captured %s commit is absent', (attempt) => {
    if (attempt === 'retry') advanceRemote();
    const remoteHead = originHead(bare);
    const env = interceptGit(`if [ "$1" = push ]; then
  if [ "$GBRAIN_TEST_PUSH_ATTEMPT" = initial ] || [ -e "$GBRAIN_TEST_PUSH_MARKER" ]; then
    "$GBRAIN_TEST_REAL_GIT" rev-parse HEAD >"$GBRAIN_TEST_PUSH_MARKER"
    "$GBRAIN_TEST_REAL_GIT" reset --hard "$GBRAIN_TEST_REMOTE_HEAD" >/dev/null
    exit 1
  fi
  : >"$GBRAIN_TEST_PUSH_MARKER"
fi`);
    env.GBRAIN_TEST_PUSH_ATTEMPT = attempt;
    env.GBRAIN_TEST_REMOTE_HEAD = remoteHead;

    const result = pushOnly(env);

    expect(result.status).not.toBe(0);
    expect(originHead(bare)).toBe(remoteHead);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(remoteHead);
    expect(getLastPushOutcome('main').status).toBe('needs_attention');
  });

  test.each(['new-example', 'refs/heads/new-example'])('preserves pushes to a new branch: %s', (branch) => {
    const result = spawnSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), '--push-only', branch], {
      cwd: work, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env,
    });

    expect(result.status).toBe(0);
    expect(git(bare, 'rev-parse', 'refs/heads/new-example')).toBe(intendedHead);
  });

  test('does not treat a wildcard branch argument as exact remote confirmation', () => {
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    const result = spawnSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), '--push-only', '*'], {
      cwd: work, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env,
    });

    expect(result.status).not.toBe(0);
  });

  test.each(['same commit', 'descendant'])('accepts a rejected push after a concurrent pusher lands the %s', (remoteShape) => {
    const remoteHead = remoteShape === 'same commit' ? intendedHead
      : git(work, 'commit-tree', 'HEAD^{tree}', '-p', intendedHead, '-m', 'remote descendant');
    writeFileSync(join(work, 'README.md'), 'unrelated dirty edit\n');
    const env = interceptGit(`if [ "$1" = push ]; then
  "$GBRAIN_TEST_REAL_GIT" push origin "$GBRAIN_TEST_REMOTE_HEAD:refs/heads/main"
  echo "simulated stale expected-ref rejection" >&2
  exit 1
fi`);
    env.GBRAIN_TEST_REMOTE_HEAD = remoteHead;

    const result = pushOnly(env);

    expect(result.status).toBe(0);
    expect(originHead(bare)).toBe(remoteHead);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(intendedHead);
    expect(readFileSync(join(work, 'README.md'), 'utf8')).toBe('unrelated dirty edit\n');
    const log = readFileSync(join(process.env.HOME!, '.gbrain', 'brain-push.log'), 'utf8');
    expect(log).toContain('ok-already-on-remote main');
    expect(log).not.toContain('rebase-pull');
    expect(log).not.toContain('LOCAL-ONLY');
    expect(getLastPushOutcome('main').status).toBe('ok');
  });

  test('confirms the rebased commit when the retry push lands but reports failure', () => {
    const remoteHead = advanceRemote();
    const env = interceptGit(`if [ "$1" = push ]; then
  if [ ! -e "$GBRAIN_TEST_PUSH_MARKER" ]; then
    : >"$GBRAIN_TEST_PUSH_MARKER"
  else
    "$GBRAIN_TEST_REAL_GIT" "$@"
    echo "simulated lost push acknowledgement" >&2
    exit 1
  fi
fi`);

    const result = pushOnly(env);

    expect(result.status).toBe(0);
    expect(originHead(bare)).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(originHead(bare)).not.toBe(intendedHead);
    expect(git(work, 'merge-base', '--is-ancestor', remoteHead, 'HEAD')).toBe('');
    expect(git(bare, 'show', 'main:pending.md')).toBe('pending');
    expect(readFileSync(join(process.env.HOME!, '.gbrain', 'brain-push.log'), 'utf8')).toContain('ok-already-on-remote main');
  });

  test('checks again after recovery fails while another pusher lands the commit', () => {
    writeFileSync(join(work, 'README.md'), 'unrelated dirty edit\n');
    const env = interceptGit(`if [ "$1" = push ]; then exit 1; fi
if [ "$1" = pull ]; then
  "$GBRAIN_TEST_REAL_GIT" push origin HEAD:refs/heads/main
  exit 1
fi`);

    const result = pushOnly(env);

    expect(result.status).toBe(0);
    expect(originHead(bare)).toBe(intendedHead);
    expect(readFileSync(join(work, 'README.md'), 'utf8')).toBe('unrelated dirty edit\n');
  });

  test('does not trust stale remote evidence when origin is unreachable', () => {
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    git(work, 'fetch', '-q', 'origin', 'main');
    expect(git(work, 'rev-parse', 'FETCH_HEAD')).toBe(intendedHead);
    expect(git(work, 'rev-parse', 'origin/main')).toBe(intendedHead);
    git(work, 'remote', 'set-url', 'origin', join(root, 'gone.git'));

    const result = pushOnly();

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(process.env.HOME!, '.gbrain', 'brain-push.log'), 'utf8')).toContain('LOCAL-ONLY, NEEDS ATTENTION');
  });

  test('does not accept containment on another remote branch', () => {
    git(work, 'push', '-q', 'origin', 'HEAD:other');
    git(work, 'fetch', '-q', 'origin', 'other');
    expect(git(work, 'rev-parse', 'FETCH_HEAD')).toBe(intendedHead);
    writeFileSync(join(work, 'README.md'), 'unrelated dirty edit\n');
    const env = interceptGit('if [ "$1" = push ]; then exit 1; fi');

    const result = pushOnly(env);

    expect(result.status).not.toBe(0);
    expect(originHead(bare)).not.toBe(intendedHead);
    expect(readFileSync(join(process.env.HOME!, '.gbrain', 'brain-push.log'), 'utf8')).toContain('LOCAL-ONLY, NEEDS ATTENTION');
  });

  test('keeps exit 4 and the failure message when the remote rejects every push', () => {
    const remoteHead = originHead(bare);
    writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(work, 'pending.md'), 'updated pending\n');

    const result = spawnSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), 'update pending', 'pending.md'], {
      cwd: work, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env,
    });

    expect(result.status).toBe(4);
    expect(result.stderr).toContain('PUSH FAILED');
    expect(originHead(bare)).toBe(remoteHead);
    expect(git(work, 'show', 'HEAD:pending.md')).toBe('updated pending');
    expect(getLastPushOutcome('main').status).toBe('needs_attention');
  });

  test('does not confirm the temporary remote HEAD of a conflicted rebase', () => {
    writeFileSync(join(work, 'README.md'), 'local edit\n');
    git(work, 'add', 'README.md');
    git(work, 'commit', '--amend', '--no-edit', '-q');
    const localHead = git(work, 'rev-parse', 'HEAD');
    const remoteHead = advanceRemote('README.md');

    const result = pushOnly();

    expect(result.status).not.toBe(0);
    expect(originHead(bare)).toBe(remoteHead);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(localHead);
    expect(readFileSync(join(work, 'README.md'), 'utf8')).toBe('local edit\n');
    expect(existsSync(join(work, '.git', 'rebase-merge'))).toBe(false);
    expect(readFileSync(join(process.env.HOME!, '.gbrain', 'brain-push.log'), 'utf8')).toContain('LOCAL-ONLY, NEEDS ATTENTION');
  });
});

describe('post-commit hook (D9 local, D7 self-contained)', () => {
  test('#3925 — the scaffolding commit does NOT fire the hook (no racing background push)', async () => {
    // beforeEach ran hardenBrainRepo. commitScaffolding commits with
    // core.hooksPath=/dev/null, so its explicit fail-loud push is the ONLY
    // push. Pre-fix, the commit fired the just-installed post-commit hook,
    // detaching a background brain_push that raced the explicit push on the
    // same ref (the #2943 cannot-lock-ref / index.lock flake class).
    // The explicit push landed the scaffolding commit:
    expect(originHead(bare)).toBe(git(work, 'rev-parse', 'HEAD'));
    // ...and the hook never fired during harden: give a would-be detached
    // push ample time to write its brain-push.log line, then assert silence.
    await new Promise(r => setTimeout(r, 2_000));
    const log = join(process.env.HOME!, '.gbrain', 'brain-push.log');
    const lines = existsSync(log) ? readFileSync(log, 'utf-8') : '';
    expect(lines).not.toMatch(/\[push\]/);
  }, 60_000);

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
    const log = join(process.env.HOME!, '.gbrain', 'brain-push.log');
    const deadline = Date.now() + 30_000;
    let found = false;
    while (Date.now() < deadline) {
      if (existsSync(log) && readFileSync(log, 'utf-8').includes('NEEDS ATTENTION')) { found = true; break; }
      await new Promise(r => setTimeout(r, 150));
    }
    expect(found).toBe(true);
  }, 60_000);
});

// The persistence schedule is the DB-free PULL cron (D2/D12) — the push side
// is the post-commit hook proved above. beforeEach hardens with
// installCron:false; this block re-hardens the SAME repo with installCron:true
// and proves the scheduled job is registered with the right command + interval,
// then invokes that exact command to prove it performs a real pull. It always
// unregisters the launchd/cron job afterward so no scheduled job survives.
describe('durability schedule (installCron:true) [D2/D12]', () => {
  // skipIf: needs a real crontab/launchctl to register against — on hosts
  // without one (some sandboxes) hardenBrainRepo correctly degrades the cron
  // step to 'skipped', which is the product working, not this arc.
  test.skipIf(!crontabAvailable() && process.platform !== 'darwin')('registers the DB-free pull job with the right command + interval, and the job performs a real pull', async () => {
    const sourceId = 'wiki';
    const report = await hardenBrainRepo({
      repoPath: work, sourceId, pat: 'ghp_x', installCron: true, intervalSec: 900, verify: false,
    });
    const toplevel = git(work, 'rev-parse', '--show-toplevel');
    try {
      const cronStep = report.steps.find((s) => s.step === 'cron')!;
      expect(cronStep).toBeDefined();
      expect(cronStep.status).not.toBe('skipped'); // installCron:true → it ran

      // The scheduled COMMAND: a DB-free `sources pull` wrapper for THIS repo,
      // written to <home>/brain-pull-<sourceId>.sh regardless of platform.
      const wrapper = join(process.env.HOME!, '.gbrain', `brain-pull-${sourceId}.sh`);
      expect(existsSync(wrapper)).toBe(true);
      const body = readFileSync(wrapper, 'utf-8');
      expect(body).toContain(`sources pull --path '${toplevel}' --branch 'main'`);

      // The REGISTERED job + its 15-minute INTERVAL. launchd (darwin) is
      // deterministic — assert the plist directly; the step detail names the
      // interval on the darwin path.
      if (process.platform === 'darwin') {
        const plist = join(process.env.HOME!, 'Library', 'LaunchAgents', `com.gbrain.brain-pull.${sourceId}.plist`);
        expect(existsSync(plist)).toBe(true);
        const xml = readFileSync(plist, 'utf-8');
        expect(xml).toContain('<key>StartInterval</key><integer>900</integer>'); // 900s = 15m
        expect(xml).toContain(wrapper); // ProgramArguments points at our wrapper
        expect(cronStep.detail).toContain('900s');
      }

      // Invoke the scheduled command directly to PROVE it performs the pull.
      // Advance origin from a second clone, then run the exact DB-free pull the
      // wrapper execs (`gbrain sources pull --path <repo> --branch main`).
      const other = mkdtempSync(join(root, 'other-'));
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, other], { stdio: 'ignore', env: process.env });
      git(other, 'config', 'user.email', 'o@o.o'); git(other, 'config', 'user.name', 'other');
      writeFileSync(join(other, 'from-remote.md'), 'landed via a second device\n');
      git(other, 'add', 'from-remote.md'); git(other, 'commit', '-qm', 'remote advance'); git(other, 'push', '-q', 'origin', 'main');

      const remoteHead = originHead(bare);
      expect(git(work, 'rev-parse', 'HEAD')).not.toBe(remoteHead); // local is behind

      await runPull(null, ['--path', work, '--branch', 'main']);

      // The scheduled pull fast-forwarded the local checkout to the remote and
      // the remote-authored file is now present locally.
      expect(git(work, 'rev-parse', 'HEAD')).toBe(remoteHead);
      expect(existsSync(join(work, 'from-remote.md'))).toBe(true);
    } finally {
      // Unregister while HOME is still the temp home (afterEach restores it).
      await unhardenBrainRepo({ repoPath: work, sourceId });
    }
  }, 60_000);
});

// #4682 — the synchronous helper is the fail-loud guarantee: a push-lock
// timeout means NO push happened and nothing confirmed the remote, so it must
// not exit 0. The detached post-commit hook keeps rc 0 on the same branch of
// the shared template: skipping a push another holder is already performing
// is its designed coalescing outcome. GBRAIN_PUSH_LOCK_WAIT_SECONDS shortens
// flock's wait so the test doesn't burn the 30s default.
describe('#4682 — push-lock timeout is fail-loud for the helper only', () => {
  const flockPath = Bun.which('flock');

  // The holder owns the lock once a non-blocking acquire FAILS.
  async function waitForLockHeld(lockPath: string, ms = 10_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        execFileSync('flock', ['-n', lockPath, 'true'], { stdio: 'ignore', env: process.env });
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  test.skipIf(!flockPath)('helper --push-only exits non-zero on lock timeout instead of claiming success', async () => {
    // An unpushed local commit. Remove the post-commit hook first so its
    // detached background push can't land the commit behind the lock holder
    // (--no-verify does NOT skip post-commit; same precedent as the #2426
    // test above). This test targets the HELPER's lock-timeout path.
    rmSync(join(work, '.git', 'hooks', 'post-commit'));
    writeFileSync(join(work, 'pending.md'), 'pending\n');
    git(work, 'add', 'pending.md');
    git(work, 'commit', '-qm', 'pending');
    const head = git(work, 'rev-parse', 'HEAD');
    expect(originHead(bare)).not.toBe(head);

    const lockPath = join(git(work, 'rev-parse', '--absolute-git-dir'), 'gbrain-push.lock');
    const holder = spawn('flock', [lockPath, 'sleep', '30'], { stdio: 'ignore', env: process.env });
    try {
      expect(await waitForLockHeld(lockPath)).toBe(true);
      let code = 0;
      try {
        execFileSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), '--push-only', 'main'], {
          cwd: work, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, GBRAIN_PUSH_LOCK_WAIT_SECONDS: '1' },
        });
      } catch (e: any) { code = e.status ?? 1; }
      expect(code).not.toBe(0); // pre-fix: exit 0 with no push and no remote-head check
      // The timeout was logged, and the commit is still NOT on origin.
      const log = join(process.env.HOME!, '.gbrain', 'brain-push.log');
      expect(readFileSync(log, 'utf-8')).toContain('lock-timeout main');
      expect(originHead(bare)).not.toBe(head);
    } finally {
      holder.kill('SIGKILL');
    }
  }, 60_000);

  test('template parity: helper renders lock-timeout rc 1, hook keeps rc 0, bodies otherwise identical', () => {
    const helper = readFileSync(join(work, 'scripts', 'brain-commit-push.sh'), 'utf-8');
    const hook = readFileSync(join(work, '.git', 'hooks', 'post-commit'), 'utf-8');
    // The helper (synchronous guarantee) fails loudly on lock timeout...
    expect(helper).toMatch(/lock-timeout \$_branch" >>"\$_log"; return 1; \}/);
    // ...while the hook (detached best-effort) keeps the coalescing skip.
    expect(hook).toMatch(/lock-timeout \$_branch" >>"\$_log"; return 0; \}/);
    // D7 stays intact: apart from that one return code, the rendered
    // brain_push bodies are byte-identical (one template, one knob).
    const body = (s: string): string => {
      const m = s.match(/brain_push\(\) \{[\s\S]*?\n\}/);
      return (m ? m[0] : '').replace(/return [01]; \}/, 'return RC; }');
    };
    expect(body(helper).length).toBeGreaterThan(0);
    expect(body(helper)).toBe(body(hook));
  });
});
