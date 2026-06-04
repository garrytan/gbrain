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
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';
import { runDoctor } from '../src/commands/doctor.ts';

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
    // scratch/home/myrepo/.git/    (directory)
    // scratch/home/myrepo/.gbrain/ ← gbrain home is inside the worktree
    const home = join(scratch, 'home');
    const repo = join(home, 'myrepo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(repo, { recursive: true });
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
});
