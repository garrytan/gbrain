/**
 * Tests for the `home_dir_in_worktree` doctor check (v0.35.8.0).
 *
 * Hermetic — drives the file system + GBRAIN_HOME + HOME envs directly via
 * `withEnv`, then invokes `runDoctor(null, ['--fast', '--json'])` and parses
 * the resulting JSON `checks` array. Skips the DB phase (engine=null + --fast).
 *
 * Covers F4 edge cases nailed in plan-eng-review:
 *   - .git as DIRECTORY (main repo)            — warns
 *   - .git as FILE (linked worktree)           — warns
 *   - walk terminates at $HOME                 — no false positive past it
 *   - GBRAIN_HOME override outside any worktree — ok
 *
 * #4683 marker validation: an empty/invalid `.git` that git itself rejects
 * must NOT be classified as an enclosing worktree — validated candidates
 * only, and an invalid candidate continues the walk toward $HOME.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';
import { runDoctor, buildHomeDirInWorktreeCheck, isValidGitMarker } from '../src/commands/doctor.ts';

/** Lay down a REAL-shaped main-repo `.git` directory (git requires HEAD). */
function mkValidGitDir(repo: string) {
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

let scratch: string;

beforeEach(() => {
  scratch = join(tmpdir(), `gbrain-doctor-hw-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Run the local doctor (no DB; null engine + --fast) under a stubbed HOME +
 *  GBRAIN_HOME, capture stdout AND prevent runDoctor's `process.exit(N)` from
 *  killing the test runner. Returns the check matching `name`. */
async function getCheck(name: string, env: Record<string, string | undefined>) {
  const captured: string[] = [];
  // Patch console.log directly — Bun's console.log doesn't route through the
  // current process.stdout.write reference (it appears to cache the binding
  // at module load), so monkey-patching write() doesn't catch it. console.log
  // is the canonical doctor JSON-output channel.
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
  };
  const origExit = process.exit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number) => {
    // Throw a tagged error so the test's try-block sees it; runDoctor's
    // own try/catch doesn't catch this because it's outside its scope.
    throw new Error(`__doctor_exit__:${code ?? 0}`);
  };
  try {
    await withEnv(env, async () => {
      try {
        await runDoctor(null, ['--fast', '--json']);
      } catch (e) {
        // Swallow the synthetic __doctor_exit__ sentinel; rethrow other errors.
        if (!(e instanceof Error) || !e.message.startsWith('__doctor_exit__:')) throw e;
      }
    });
  } finally {
    console.log = origLog;
    process.exit = origExit;
  }
  const text = captured.join('');
  // The doctor's JSON envelope is the LAST line that starts with
  // `{"schema_version"`. v0.41.19.0 added nested objects to the envelope
  // (category_scores), so a "find the `{` before `\"checks\"`" heuristic
  // no longer works — it walks back to category_scores's `{` instead of
  // the outer one. Anchor on the canonical envelope prefix instead.
  const lines = text.split('\n');
  let jsonStr = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('{"schema_version"')) {
      jsonStr = trimmed;
      break;
    }
  }
  let parsed: { checks: { name: string; status: string; message: string }[] };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Could not parse doctor JSON; saw: ${text.slice(-500)}`);
  }
  return parsed.checks.find(c => c.name === name);
}

describe('home_dir_in_worktree doctor check', () => {
  test('gbrain home outside any worktree → ok', async () => {
    // scratch/.gbrain — no parent has a .git, scratch IS our fake $HOME
    const home = scratch;
    const gbrainParent = home;
    const check = await getCheck('home_dir_in_worktree', {
      HOME: home,
      GBRAIN_HOME: gbrainParent,
    });
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
  });

  test('gbrain home inside dir-style .git worktree → warn', async () => {
    // scratch/home/myrepo/.git/    (directory with HEAD — real main-repo shape)
    // scratch/home/myrepo/.gbrain/ ← gbrain home is inside the worktree
    const home = join(scratch, 'home');
    const repo = join(home, 'myrepo');
    mkValidGitDir(repo);
    const check = await getCheck('home_dir_in_worktree', {
      HOME: home,
      GBRAIN_HOME: repo,
    });
    expect(check).toBeDefined();
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('myrepo');
  });

  test('gbrain home inside .git-AS-FILE linked worktree → warn (F4)', async () => {
    // Linked worktrees use a `.git` FILE (not a directory) containing
    // `gitdir: /path/to/main/.git/worktrees/<name>`. Doctor MUST recognize
    // both shapes — this is the Conductor + git-worktrees topology our
    // dev environment runs in.
    const home = join(scratch, 'home');
    const repo = join(home, 'linked-wt');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.git'), 'gitdir: /some/other/path/.git/worktrees/linked-wt\n');
    const check = await getCheck('home_dir_in_worktree', {
      HOME: home,
      GBRAIN_HOME: repo,
    });
    expect(check).toBeDefined();
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('linked-wt');
  });

  test('walk terminates at $HOME — .git ABOVE $HOME does NOT trigger warn (F4)', async () => {
    // scratch/.git/  (ABOVE the fake $HOME — should be ignored)
    // scratch/home/  (fake $HOME)
    // scratch/home/.gbrain/  (no worktree below $HOME)
    mkdirSync(join(scratch, '.git'), { recursive: true });
    const home = join(scratch, 'home');
    mkdirSync(home, { recursive: true });
    const check = await getCheck('home_dir_in_worktree', {
      HOME: home,
      GBRAIN_HOME: home,
    });
    expect(check).toBeDefined();
    // OK because the .git is above $HOME, outside our walk scope.
    expect(check!.status).toBe('ok');
  });

  test('GBRAIN_HOME override pointing outside any worktree → ok', async () => {
    // Real $HOME might be inside a worktree, but the user pointed
    // GBRAIN_HOME at a clean location. Doctor should report ok.
    const home = scratch;
    const safe = join(scratch, 'safe-elsewhere');
    mkdirSync(safe, { recursive: true });
    const check = await getCheck('home_dir_in_worktree', {
      HOME: home,
      GBRAIN_HOME: safe,
    });
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
  });

  test('EMPTY .git directory (git rejects it) does NOT warn (#4683)', async () => {
    // scratch/home/false-worktree/.git/  ← empty dir; `git rev-parse` rejects it
    // scratch/home/false-worktree/.gbrain/
    const home = join(scratch, 'home');
    const repo = join(home, 'false-worktree');
    mkdirSync(join(repo, '.git'), { recursive: true }); // no HEAD — invalid
    const check = await getCheck('home_dir_in_worktree', {
      HOME: home,
      GBRAIN_HOME: repo,
    });
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// #4683 — direct unit coverage of the peeled check (no runDoctor round trip).
// ---------------------------------------------------------------------------

describe('buildHomeDirInWorktreeCheck marker validation (#4683)', () => {
  test('.git FILE without a gitdir: pointer is not a worktree marker', () => {
    const home = join(scratch, 'home');
    const repo = join(home, 'bogus');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.git'), ''); // empty marker file — git rejects it
    const check = buildHomeDirInWorktreeCheck(join(repo, '.gbrain'), home, false);
    expect(check.status).toBe('ok');
  });

  test('invalid candidate CONTINUES the walk — valid repo higher up still warns', () => {
    // scratch/home/realrepo/.git/HEAD      (valid)
    // scratch/home/realrepo/sub/.git/      (empty — invalid)
    // scratch/home/realrepo/sub/.gbrain
    const home = join(scratch, 'home');
    const realRepo = join(home, 'realrepo');
    mkValidGitDir(realRepo);
    const sub = join(realRepo, 'sub');
    mkdirSync(join(sub, '.git'), { recursive: true }); // invalid inner marker
    const check = buildHomeDirInWorktreeCheck(join(sub, '.gbrain'), home, false);
    expect(check.status).toBe('warn');
    expect(check.message).toContain(realRepo);
    expect(check.message).not.toContain(`worktree at ${sub}.`);
  });

  test('isValidGitMarker: HEAD-bearing dir + gitdir: file valid; empty forms invalid', () => {
    const base = join(scratch, 'markers');
    // Valid dir
    const validDir = join(base, 'valid-dir');
    mkValidGitDir(validDir);
    expect(isValidGitMarker(join(validDir, '.git'))).toBe(true);
    // Empty dir
    const emptyDir = join(base, 'empty-dir', '.git');
    mkdirSync(emptyDir, { recursive: true });
    expect(isValidGitMarker(emptyDir)).toBe(false);
    // Valid linked-worktree file
    const linked = join(base, 'linked');
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, '.git'), 'gitdir: /main/.git/worktrees/linked\n');
    expect(isValidGitMarker(join(linked, '.git'))).toBe(true);
    // Junk file
    const junk = join(base, 'junk');
    mkdirSync(junk, { recursive: true });
    writeFileSync(join(junk, '.git'), 'not a pointer');
    expect(isValidGitMarker(join(junk, '.git'))).toBe(false);
    // Missing entirely
    expect(isValidGitMarker(join(base, 'nowhere', '.git'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review fix — $HOME / GBRAIN_HOME spelled with a trailing slash.
// ---------------------------------------------------------------------------

describe('buildHomeDirInWorktreeCheck path normalization (trailing-slash $HOME)', () => {
  test('a trailing slash on $HOME does not silently turn the check ok', () => {
    // `HOME=/home/user/` is a common shell / launchd spelling. Pre-fix the walk
    // gate was `gbrainHome.startsWith(home + '/')` → '/home/user//' never
    // matched, so a brain INSIDE a worktree was reported ok.
    const home = join(scratch, 'home');
    const repo = join(home, 'myrepo');
    mkValidGitDir(repo);
    const check = buildHomeDirInWorktreeCheck(join(repo, '.gbrain'), home + '/', false);
    expect(check.status).toBe('warn');
    expect(check.message).toContain(repo);
  });

  test('a trailing slash on GBRAIN_HOME is normalized the same way', () => {
    const home = join(scratch, 'home');
    const repo = join(home, 'myrepo2');
    mkValidGitDir(repo);
    const check = buildHomeDirInWorktreeCheck(join(repo, '.gbrain') + '/', home, false);
    expect(check.status).toBe('warn');
    expect(check.message).toContain(repo);
  });

  test('the walk still terminates at a trailing-slash $HOME (no false positive above it)', () => {
    mkValidGitDir(scratch); // a real .git ABOVE the fake $HOME
    const home = join(scratch, 'home');
    mkdirSync(home, { recursive: true });
    const check = buildHomeDirInWorktreeCheck(join(home, '.gbrain'), home + '/', false);
    expect(check.status).toBe('ok');
  });
});
