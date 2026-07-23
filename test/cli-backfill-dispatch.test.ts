/**
 * #3224 — `backfill` was missing from the `CLI_ONLY` set at src/cli.ts,
 * so the dispatcher rejected the command with "Unknown command: backfill"
 * before ever reaching the fully-implemented `case 'backfill':` inside
 * `handleCliOnly`'s switch (`runBackfillCommand` in
 * src/commands/backfill.ts). `edges-backfill` was registered, which is
 * why the omission went unnoticed.
 *
 * A second, deeper bug surfaced once `backfill` became reachable:
 * `runBackfillCommand` manages its own PGLite engine end-to-end
 * (createEngine + connect + disconnect) and takes no engine argument at
 * all. The old `case 'backfill':` sat behind handleCliOnly's SHARED
 * `const engine = await connectEngine()` — dispatching there would open a
 * second PGLite connection to the same data dir while the first was still
 * held, and PGLite's single-writer file lock (src/core/pglite-lock.ts)
 * has no same-process reentrancy check, so every real (non---help) run
 * would hang for the full 30s lock timeout and then fail. The fix moves
 * `backfill` dispatch to an unconditional pre-connectEngine branch (same
 * spot as schema/init/auth/remote) instead of just gating `--help` there.
 *
 * Three things are pinned here:
 *  1. The runtime repro from the issue (`gbrain backfill --help` /
 *     `gbrain backfill`) no longer reports "Unknown command".
 *  2. A real backfill run against a configured PGLite brain completes
 *     quickly instead of hanging on its own lock.
 *  3. The issue's own suggested class-guard: every `case` in
 *     handleCliOnly's command switch must have a matching `CLI_ONLY`
 *     entry, so the next one-word omission fails CI instead of shipping
 *     silently disabled.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_TS_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function runCli(
  args: string[],
  gbrainHome?: string,
  opts?: { timeoutMs?: number },
): { stdout: string; stderr: string; status: number; timedOut: boolean } {
  const result = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      GBRAIN_HOME: gbrainHome ?? '/tmp/gbrain-test-cli-backfill-dispatch-nonexistent',
    },
    // Explicit timeout: spawnSync blocks the whole (single-threaded) test
    // runner, so bun:test's own per-test timeout (the 3rd `test()` arg)
    // can't interrupt a hung child process — it only starts counting again
    // once spawnSync itself returns. Without this, a regression that
    // reintroduces the ~30s PGLite lock hang would silently wait out the
    // full 30s instead of the test failing fast on a bounded timeout.
    timeout: opts?.timeoutMs,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
    // Node sets `error.code === 'ETIMEDOUT'` (and `signal` on the result)
    // when `timeout` fires and the child is killed.
    timedOut: result.signal !== null || (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  };
}

describe('#3224 — `gbrain backfill` is dispatchable', () => {
  test('`backfill --help` reaches the real HELP text, not "Unknown command"', () => {
    const { stdout, stderr, status } = runCli(['backfill', '--help']);
    expect(stderr).not.toContain('Unknown command');
    expect(status).toBe(0);
    // runBackfillCommand's own printHelp() (src/commands/backfill.ts) —
    // proves dispatch reached the real handler, not the generic CLI_ONLY
    // one-line stub (the WARN-5 class: registering `backfill` in CLI_ONLY
    // alone routes it behind the generic short-circuit / a `connectEngine()`
    // that a fresh tmpdir can't satisfy; the fix also needed the
    // pre-engine-bind `--help` short-circuit + a CLI_ONLY_SELF_HELP entry).
    expect(stdout).toContain('gbrain backfill list');
    expect(stdout).toContain('--batch-size N');
  });

  test('`-h` short flag also works', () => {
    const { stdout, status } = runCli(['backfill', '-h']);
    expect(status).toBe(0);
    expect(stdout).toContain('gbrain backfill list');
  });

  test('`backfill` with no brain configured fails on the config, not "Unknown command"', () => {
    // Without --help, runBackfillCommand needs a real engine, so a
    // fresh/nonexistent GBRAIN_HOME must still fail — but on "no brain
    // configured", never on dispatch rejecting the command outright.
    const { stderr, status } = runCli(['backfill']);
    expect(status).not.toBe(0);
    expect(stderr).not.toContain('Unknown command');
  });
});

describe('#3224 — a real backfill run against a configured PGLite brain does not deadlock', () => {
  let gbrainHome: string;

  beforeAll(() => {
    gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-test-cli-backfill-pglite-'));
    const init = runCli(['init', '--pglite', '--no-embedding'], gbrainHome);
    expect(init.status).toBe(0);
  }, 60000);

  afterAll(() => {
    rmSync(gbrainHome, { recursive: true, force: true });
  });

  test('`backfill effective_date --dry-run` connects, runs, and exits — no 30s PGLite lock hang', () => {
    // Pre-fix (case inside the switch, behind the shared connectEngine()):
    // this would hang for ~30s and then fail with "Timed out waiting for
    // PGLite lock. Process <own PID> has held it since ...". The explicit
    // spawnSync `timeoutMs` below (well under the 30s lock timeout) is what
    // actually bounds this — bun:test's own per-test timeout can't
    // interrupt a blocking spawnSync call, it only resumes counting once
    // spawnSync returns.
    const { stdout, stderr, status, timedOut } = runCli(
      ['backfill', 'effective_date', '--dry-run'],
      gbrainHome,
      { timeoutMs: 20_000 },
    );
    expect(timedOut).toBe(false);
    expect(stderr).not.toContain('Timed out waiting for PGLite lock');
    expect(status).toBe(0);
    expect(stdout).toContain('Running backfill: effective_date');
    expect(stdout).toContain('complete');
  }, 25000);
});

describe('#3224 class guard — every handleCliOnly switch case is CLI_ONLY-registered', () => {
  test('no `case` label in the command switch is missing from CLI_ONLY (except documented pre-existing dead arms)', () => {
    const src = readFileSync(CLI_TS_PATH, 'utf-8');

    const setMatch = src.match(/export const CLI_ONLY = new Set\(\[([^\]]*)\]\);/);
    expect(setMatch).not.toBeNull();
    const cliOnly = new Set([...setMatch![1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
    expect(cliOnly.size).toBeGreaterThan(0);

    // Scope tightly to the actual `switch (command) { ... }` body inside
    // handleCliOnly — NOT the whole function. The function also has a long
    // pre-engine if-chain (schema/init/auth/...) whose prose comments can
    // themselves contain the literal text `case 'xyz':` when documenting
    // this exact bug class (e.g. the `backfill` pre-connectEngine branch's
    // own comment references the old case it replaced) — matching against
    // the whole function body would misread that comment as a real,
    // CLI_ONLY-registered dispatch site and silently mask a genuine gap.
    const fnStartIdx = src.indexOf("async function handleCliOnly(command: string, args: string[]) {");
    expect(fnStartIdx).toBeGreaterThan(-1);
    const fnEndIdx = src.indexOf('\nasync function dispatchReadOnlyCommand', fnStartIdx);
    expect(fnEndIdx).toBeGreaterThan(fnStartIdx);
    const fnBody = src.slice(fnStartIdx, fnEndIdx);

    const switchStartIdx = fnBody.indexOf('switch (command) {');
    expect(switchStartIdx).toBeGreaterThan(-1);
    // The switch's own closing brace is immediately followed by
    // `  } finally {` (the engine-teardown wrapper) — a marker specific
    // enough to bound the switch precisely without a full brace-matcher.
    const switchEndIdx = fnBody.indexOf('\n  } finally {', switchStartIdx);
    expect(switchEndIdx).toBeGreaterThan(switchStartIdx);
    const switchBody = fnBody.slice(switchStartIdx, switchEndIdx);

    // Strip comments before matching so prose that merely MENTIONS a case
    // label (block or line comments) can never be mistaken for a real one.
    const switchBodyNoComments = switchBody
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    const cases = [...switchBodyNoComments.matchAll(/case '([^']+)':/g)].map((m) => m[1]);
    expect(cases.length).toBeGreaterThan(30); // sanity: the switch is large

    const missing = cases.filter((c) => !cliOnly.has(c));

    // Pre-existing switch arms that are unreachable for reasons OTHER than
    // #3224's bug class: each is shadowed by an earlier, unconditional
    // branch before the CLI_ONLY.has(command) dispatch gate is ever
    // consulted, so adding them to CLI_ONLY would not change behavior (and
    // fixing/removing the dead code is a separate, out-of-scope cleanup).
    // Documented here instead of silently re-hidden, per the issue's own
    // "next one-word omission" framing — if this allowlist needs to grow,
    // that growth itself is the signal a case was orphaned.
    const KNOWN_UNREACHABLE_DEAD_CASES = new Set([
      'search', // shadowed by the T5 special-case (modes/stats/tune/diagnose) + the generic op fallback for free-text search
      'pages', // shadowed by the generic op fallback (list_pages)
      'notability-eval', // superseded command name; no CLI_ONLY entry ever existed for it
      'whoknows', // superseded command name (now `find_experts`); no CLI_ONLY entry ever existed for it
    ]);

    const unexpected = missing.filter((c) => !KNOWN_UNREACHABLE_DEAD_CASES.has(c));
    expect(unexpected).toEqual([]);
  });
});
