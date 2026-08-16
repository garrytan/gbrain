/**
 * Real-PTY test for the interactive `gbrain init` pickers — the one flow that
 * needs a true TTY. Both pickers branch on stdin TTY-ness: the embedding
 * provider picker (fires BEFORE schema init, src/commands/init.ts) and the
 * search-mode picker (fires AFTER initSchema, src/commands/init-mode-picker.ts).
 * Injected-isTTY unit tests cover the pure logic; this test proves the real
 * CLI under a real pseudo-terminal renders both menus and reads typed input.
 *
 * Why serial: PTY spawns plus a full PGLite bootstrap are too heavy for the
 * concurrent fast loop — and the serial runner is the lane that actually
 * executes in required CI (unit shards exclude the e2e directory, and the
 * e2e workflow runs only explicitly named files — no glob).
 *
 * Input-liveness discipline: bare Enter AND the 60s readLineSafe timeout both
 * resolve each prompt to its default, so a test asserting defaults would pass
 * with dead input. This test therefore (a) picks a NON-default search mode
 * (tokenmax; the keyless-env recommendation is conservative) and asserts its
 * DB-plane value via a follow-up non-TTY config read, and (b) bounds each
 * prompt-to-acknowledgement gap well under the 60s fallback.
 *
 * Hermeticity: HOME and GBRAIN_HOME both point at the temp root — init probes
 * host paths under the real home (gstack discovery via homedir()) — and the
 * Anthropic credentials are dropped (the auth vars hermeticChildEnv passes
 * through), so zero providers are env-ready and picker state is
 * machine-independent.
 *
 * Lifecycle: session.close() in finally, BEFORE temp-dir removal. waitForExit
 * does not clear the harness wall timer; only close() does — skipping it
 * leaks the child and its PGLite lock on any failed assertion.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

import { launchTty, ptySupported } from './helpers/tty-harness.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const CLI_TS = join(REPO_ROOT, 'src', 'cli.ts');

// A prompt answered by a live send resolves fast; a dead send means
// readLineSafe sits its full fallback window (60s at both call sites this
// test drives: src/commands/init-provider-picker.ts and
// src/commands/init-mode-picker.ts) and proceeds with the default. The
// liveness bound is a FIXED interaction budget, deliberately independent of
// the fallback constant — generous enough for a loaded CI runner, strictly
// below any plausible future fallback value, so dead input can never pass
// even if the production fallback is shortened.
const PROMPT_LIVENESS_MS = 20_000;

// On CI the pinned Bun (engines >= 1.3.10) has PTY support — a skip here
// would be silent coverage loss, so fail loud instead. Locally a missing
// PTY (exotic sandbox) downgrades to skip.
if (process.env.CI) {
  test('PTY support is mandatory on CI', () => {
    expect(ptySupported()).toBe(true);
  });
}
const describePty = ptySupported() ? describe : describe.skip;

describePty('gbrain init interactive pickers under a real PTY (keyless)', () => {
  let tmpRoot: string;
  let homeDir: string;
  let workDir: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-pty-init-'));
    homeDir = join(tmpRoot, 'home');
    workDir = join(tmpRoot, 'work');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
  });
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('provider picker keyless choice + NON-default mode land in config', async () => {
    const session = launchTty(['bun', 'run', CLI_TS, 'init', '--pglite'], {
      cwd: workDir,
      env: { HOME: homeDir, GBRAIN_HOME: homeDir },
      dropEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
      timeoutMs: 240_000,
    });

    try {
      // ── Prompt 1: embedding provider picker (pre-schema). Zero env-ready
      // providers → the menu still renders the keyless row for the embedding
      // touchpoint. Answer 0 (keyless).
      await session.waitFor('0) none', { timeoutMs: 60_000 });
      const afterMenu = session.mark();
      const tProvider = Date.now();
      session.send('0\r');

      // The keyless-continue notice prints immediately after the picker
      // returns (still pre-schema), so this gap measures prompt liveness,
      // not PGLite bootstrap time.
      await session.waitFor(/keyless mode/i, { timeoutMs: 60_000, since: afterMenu });
      expect(Date.now() - tProvider).toBeLessThan(PROMPT_LIVENESS_MS);

      // ── Prompt 2: search-mode picker (post-initSchema — allow PGLite
      // bootstrap time before it appears). Recommendation in a keyless env
      // is conservative; pick tokenmax (option 3) to prove input landed.
      await session.waitFor('Mode [', { timeoutMs: 120_000, since: afterMenu });
      const afterModePrompt = session.mark();
      const tMode = Date.now();
      session.send('3\r');

      await session.waitFor('Search mode set to: tokenmax', {
        timeoutMs: 60_000,
        since: afterModePrompt,
      });
      expect(Date.now() - tMode).toBeLessThan(PROMPT_LIVENESS_MS);

      const exitCode = await session.waitForExit(120_000);
      expect(exitCode).toBe(0);
    } finally {
      await session.close();
    }

    // ── Persistence: file plane carries the keyless sentinel...
    const cfgPath = join(homeDir, '.gbrain', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.engine).toBe('pglite');
    expect(cfg.embedding_disabled).toBe(true);

    // ── ...and the DB plane carries the NON-default mode. Read it back the
    // way a script would: non-TTY CLI, bare value on stdout. The init child
    // has exited, so the PGLite single-writer lock is free.
    const readBack = spawnSync('bun', ['run', CLI_TS, 'config', 'get', 'search.mode'], {
      env: {
        PATH: process.env.PATH,
        HOME: homeDir,
        GBRAIN_HOME: homeDir,
        TMPDIR: process.env.TMPDIR,
      },
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    expect(readBack.status).toBe(0);
    expect((readBack.stdout ?? '').trim()).toBe('tokenmax');
  }, 300_000);

  test('Ctrl-D at the provider prompt falls back to keyless via EOF detection', async () => {
    const homeDir2 = join(tmpRoot, 'home-eof');
    const workDir2 = join(tmpRoot, 'work-eof');
    mkdirSync(homeDir2, { recursive: true });
    mkdirSync(workDir2, { recursive: true });

    const session = launchTty(['bun', 'run', CLI_TS, 'init', '--pglite'], {
      cwd: workDir2,
      env: { HOME: homeDir2, GBRAIN_HOME: homeDir2 },
      dropEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
      timeoutMs: 240_000,
    });
    try {
      await session.waitFor('0) none', { timeoutMs: 60_000 });
      const afterMenu = session.mark();
      const tEof = Date.now();
      session.sendKey('CtrlD');
      // EOF must be DETECTED (immediate keyless fallback), not absorbed until
      // the readLineSafe fallback timer fires — this is the shared branch the
      // deleted harness's comments falsely claimed to cover.
      await session.waitFor(/keyless mode/i, { timeoutMs: 60_000, since: afterMenu });
      expect(Date.now() - tEof).toBeLessThan(PROMPT_LIVENESS_MS);
      // Deliberate early close: after EOF, Bun's stdin never yields another
      // line while isTTY stays true, so the LATER mode picker sits its full
      // 60s fallback before init completes (probed: exit at ~61s). That is a
      // pre-existing product stall (readLineSafe does not latch EOF), filed
      // in TODOS.md — running init to completion here would bake that 60s
      // stall into every required-CI serial run.
    } finally {
      await session.close();
    }
  }, 300_000);
});
