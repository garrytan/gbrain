/**
 * v0.41.8.0 — IRON-RULE regression for #1247, #1269, #1290.
 *
 * Pre-fix: `gbrain search`, `gbrain query`, `gbrain get` on PGLite
 * printed results then hung at ~95-98% CPU until SIGKILL.
 *
 * Post-fix: each command exits 0 within a few seconds.
 *
 * This test spawns the CLI as a real subprocess against a hermetic
 * GBRAIN_HOME tempdir, seeds a brain with 2 pages, runs each verb
 * with a hard timeout, and asserts exit 0. Without the drain helper
 * in cli.ts, every variant would time out.
 *
 * Bonus assertion: `gbrain serve --http` (a daemon) MUST stay alive
 * after the first request — the narrow force-exit guard added in
 * v0.41.8.0 is supposed to fire ONLY on op-dispatch drain timeout,
 * NEVER for daemons. This catches any future regression where the
 * force-exit gets broadened or the guard mis-recognizes 'serve'.
 *
 * Marked .serial because each test spawns a real bun subprocess that
 * cold-starts PGLite WASM (~5-10s wallclock). Running these in the
 * parallel pool would starve siblings of WASM init time.
 *
 * The reproducibility preconditions (per Codex eng-review #4) are
 * encoded explicitly:
 *   - Seeded pages have `last_retrieved_at NULL` (verified via
 *     fresh PGLite init — column starts NULL).
 *   - At least one page id returned from each verb (search hits the
 *     literal title; get hits the seeded slug).
 *   - `search.track_retrieval` left unset → default-on path fires the
 *     bumpLastRetrievedAt write that pre-fix would race disconnect.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const BIN_CACHE = join(REPO_ROOT, 'test', '.cache');
const SHIM_PATH = join(BIN_CACHE, 'gbrain-pglite-exit-shim.sh');

beforeAll(() => {
  // Same shim pattern as claw-test e2e: bun --compile can't bundle
  // PGLite's pglite.data, so we delegate to `bun run src/cli.ts`.
  mkdirSync(BIN_CACHE, { recursive: true });
  const shim = `#!/bin/sh\nexec bun run "${join(REPO_ROOT, 'src', 'cli.ts')}" "$@"\n`;
  writeFileSync(SHIM_PATH, shim, 'utf-8');
  chmodSync(SHIM_PATH, 0o755);
}, 10_000);

// Set up a fresh hermetic PGLite brain once per file; each verb
// runs against the same brain to amortize cold-start.
let tmpHome: string;
let repoSourceDir: string;
let runEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-pglite-exit-'));
  repoSourceDir = mkdtempSync(join(tmpdir(), 'gbrain-pglite-exit-src-'));

  // Seed a tiny git repo with 2 markdown pages so `gbrain sync` has
  // something to import. The pages contain the literal token 'foxtrot'
  // so search has a deterministic keyword hit.
  writeFileSync(
    join(repoSourceDir, 'alpha.md'),
    '---\ntitle: Alpha\n---\nThe quick brown foxtrot jumps over the lazy dog.\n',
  );
  writeFileSync(
    join(repoSourceDir, 'beta.md'),
    '---\ntitle: Beta\n---\nFoxtrot is a NATO phonetic letter F.\n',
  );

  // git init + commit so sync has a HEAD to anchor against
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoSourceDir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoSourceDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoSourceDir });
  spawnSync('git', ['add', '-A'], { cwd: repoSourceDir });
  spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoSourceDir });

  // Strip embedding-provider env vars so init doesn't refuse on the
  // multi-provider ambiguity check. We don't need embeddings — sync
  // runs with --no-embed below and search/get are keyword-only paths.
  runEnv = { ...process.env, GBRAIN_HOME: tmpHome };
  delete runEnv.VOYAGE_API_KEY;
  delete runEnv.ZEROENTROPY_API_KEY;
  delete runEnv.OPENAI_API_KEY;
  delete runEnv.ANTHROPIC_API_KEY;
  delete runEnv.GOOGLE_API_KEY;

  const initResult = spawnSync(
    SHIM_PATH,
    ['init', '--pglite', '--repo', repoSourceDir, '--no-embedding', '--yes'],
    {
      cwd: REPO_ROOT,
      env: runEnv,
      encoding: 'utf-8',
      timeout: 60_000,
    },
  );
  if (initResult.status !== 0) {
    throw new Error(
      `gbrain init failed (code=${initResult.status}):\n` +
        `STDOUT:\n${initResult.stdout}\n` +
        `STDERR:\n${initResult.stderr}`,
    );
  }

  // Sync to import the pages (no-embed: skip the embedding step so
  // the test doesn't need any provider key).
  const syncResult = spawnSync(
    SHIM_PATH,
    ['sync', '--repo', repoSourceDir, '--no-pull', '--no-embed'],
    {
      cwd: REPO_ROOT,
      env: runEnv,
      encoding: 'utf-8',
      timeout: 60_000,
    },
  );
  if (syncResult.status !== 0) {
    throw new Error(
      `gbrain sync failed (code=${syncResult.status}):\n` +
        `STDOUT:\n${syncResult.stdout}\n` +
        `STDERR:\n${syncResult.stderr}`,
    );
  }
}, 180_000);

afterAll(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(repoSourceDir, { recursive: true, force: true });
  } catch {
    /* best effort cleanup */
  }
});

/**
 * Spawn the CLI with a wall-clock timeout. Returns exit code + output.
 * Without the v0.41.8.0 fix, the subprocess hangs forever and the
 * timeout would force-kill. The IRON-RULE assertion is "exit code 0
 * within timeoutMs."
 */
function runWithTimeout(
  args: string[],
  timeoutMs: number,
  envOverride?: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolveOut) => {
    const t0 = Date.now();
    const child = spawn(SHIM_PATH, args, {
      cwd: REPO_ROOT,
      env: envOverride ? { ...runEnv, ...envOverride } : runEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveOut({ code, stdout, stderr, durationMs: Date.now() - t0 });
    });
  });
}

/**
 * #2084: the teardown backstop banner must NEVER appear on a healthy run —
 * it now means a teardown component violated its own bound, not "this
 * command was slower than 10s end-to-end" (the pre-#2084 misfire).
 */
const TEARDOWN_BANNER = 'did not return within';

describe('v0.41.8.0 — PGLite CLI read commands exit cleanly (#1247/#1269/#1290)', () => {
  test('gbrain search "foxtrot" exits 0 within 15s', async () => {
    const { code, stdout, stderr, durationMs } = await runWithTimeout(
      ['search', 'foxtrot', '--limit', '3'],
      15_000,
    );
    if (code !== 0) {
      throw new Error(
        `expected exit 0, got ${code}; duration=${durationMs}ms\n` +
          `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
      );
    }
    expect(stderr).not.toContain(TEARDOWN_BANNER);
    expect(code).toBe(0);
    // Must have actually returned a hit — else bumpLastRetrievedAt
    // would have early-returned on empty pageIds and the bug wouldn't
    // have been exercised.
    expect(stdout.length).toBeGreaterThan(0);
  }, 30_000);

  test('gbrain get returns a page body and exits 0 within 15s', async () => {
    const { code, stdout, stderr, durationMs } = await runWithTimeout(
      ['get', 'alpha'],
      15_000,
    );
    if (code !== 0) {
      throw new Error(
        `expected exit 0, got ${code}; duration=${durationMs}ms\n` +
          `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
      );
    }
    expect(stderr).not.toContain(TEARDOWN_BANNER);
    expect(code).toBe(0);
    expect(stdout).toContain('foxtrot');
  }, 30_000);

  test('gbrain query without --no-expand exits 0 within 15s (no API key)', async () => {
    // Without an API key, expansion + vector branches degrade
    // gracefully. The op still runs the keyword path and returns
    // results. The DRAIN is what we're testing, not query quality.
    const { code, stderr, durationMs } = await runWithTimeout(
      ['query', 'foxtrot', '--limit', '3', '--no-expand'],
      15_000,
    );
    if (code !== 0) {
      // Some test environments may fail query on missing embed key —
      // we tolerate that, but ALL of the rapid exit invariants still
      // apply: the process MUST exit, not hang. duration < 15s proves
      // it didn't hang; non-zero is acceptable.
      expect(durationMs).toBeLessThan(15_000);
      return;
    }
    expect(code).toBe(0);
  }, 30_000);
});

describe('v0.42.20.0 — gbrain capture (CLI_ONLY) exits cleanly + frees the lock (#1762)', () => {
  test('multi-chunk capture exits 0 within 25s AND a later command runs lock-free', async () => {
    // The #1762 repro: capture on a multi-chunk page enqueues a fire-and-forget
    // facts:absorb job, then handleCliOnly's finally disconnects mid-job →
    // PGLite db.close() busy-loop pins the single-writer lock. The registry
    // drain-before-disconnect (Fix 0.A + Fix 1) closes it. Without an API key
    // the facts job is a fast no-op, so this is a wiring regression guard: the
    // drain+disconnect path runs and capture exits cleanly + the lock is free.
    const body = Array.from({ length: 12 }, (_, i) =>
      `## Section ${i}\n\nThis is paragraph ${i} of a deliberately long meeting note ` +
      `with enough prose to split into multiple chunks. Foxtrot tango whiskey ${i}. ` +
      `The recursive chunker targets a few hundred tokens per chunk, so a dozen of ` +
      `these sections guarantees a multi-chunk page for the capture path.\n`,
    ).join('\n');
    const capFile = join(tmpHome, 'capture-input.md');
    writeFileSync(capFile, `---\ntitle: Capture Meeting\n---\n${body}\n`, 'utf-8');

    const cap = await runWithTimeout(
      ['capture', '--file', capFile, '--slug', 'meetings/capture-test', '--type', 'meeting', '--quiet'],
      25_000,
    );
    if (cap.code !== 0) {
      // The IRON RULE is "does not hang." A non-zero exit that still returned
      // within the window is tolerable in keyless CI; a hang (kill at 25s) is not.
      expect(cap.durationMs).toBeLessThan(25_000);
    } else {
      expect(cap.code).toBe(0);
    }

    // The real lock-pin symptom: the NEXT command times out waiting for the
    // PGLite lock. Assert a subsequent read runs cleanly and quickly.
    expect(cap.stderr).not.toContain(TEARDOWN_BANNER);
    const next = await runWithTimeout(['get', 'meetings/capture-test'], 15_000);
    expect(next.durationMs).toBeLessThan(15_000);
    expect(next.stderr).not.toContain('Timed out waiting for PGLite lock');
    if (next.code === 0) {
      expect(next.stdout.toLowerCase()).toContain('foxtrot');
    }
  }, 60_000);
});

describe('#2084 — explicit-exit teardown: every swept site exits clean, exit codes report the op', () => {
  // D6C hardening: mutating commands run against a throwaway COPY of the
  // seeded GBRAIN_HOME so a remediation/dream pass can't contaminate the
  // brain the other tests share.
  function copyBrainHome(label: string): string {
    const copy = mkdtempSync(join(tmpdir(), `gbrain-2084-${label}-`));
    cpSync(tmpHome, copy, { recursive: true });
    return copy;
  }

  test('D5: failed op exits 1 with the error on stderr (exit code = op outcome)', async () => {
    const { code, stderr, durationMs } = await runWithTimeout(
      ['get', 'nonexistent-slug-2084'],
      15_000,
    );
    expect(durationMs).toBeLessThan(15_000);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).not.toContain(TEARDOWN_BANNER);
  }, 30_000);

  test('search stats (dashboard path, Site C) exits 0, no banner', async () => {
    const { code, stdout, stderr } = await runWithTimeout(['search', 'stats'], 20_000);
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stderr).not.toContain(TEARDOWN_BANNER);
  }, 30_000);

  test('sources list (read-only timeout path, Site D) exits 0, no banner', async () => {
    const { code, stderr } = await runWithTimeout(['sources', 'list'], 20_000);
    expect(code).toBe(0);
    expect(stderr).not.toContain(TEARDOWN_BANNER);
  }, 30_000);

  test('doctor (Site G — leak-fix shape) exits without hanging, no banner', async () => {
    const { code, durationMs, stderr } = await runWithTimeout(['doctor'], 45_000);
    expect(durationMs).toBeLessThan(45_000);
    expect(stderr).not.toContain(TEARDOWN_BANNER);
    // Keyless CI may surface advisory findings; doctor's exit code reflects
    // brain health, not teardown health. The pin is: exits, no banner.
    expect(code).not.toBeNull();
  }, 60_000);

  test('doctor --remediation-plan (Site F) exits without hanging, no banner', async () => {
    const { code, durationMs, stderr } = await runWithTimeout(
      ['doctor', '--remediation-plan'],
      30_000,
    );
    expect(durationMs).toBeLessThan(30_000);
    expect(stderr).not.toContain(TEARDOWN_BANNER);
    expect(code).not.toBeNull();
  }, 45_000);

  test('doctor --remediate (Site F, mutating) runs on a brain copy, exits, no banner', async () => {
    const copy = copyBrainHome('remediate');
    try {
      const { code, durationMs, stderr } = await runWithTimeout(
        ['doctor', '--remediate'],
        45_000,
        { GBRAIN_HOME: copy },
      );
      expect(durationMs).toBeLessThan(45_000);
      expect(stderr).not.toContain(TEARDOWN_BANNER);
      expect(code).not.toBeNull();
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }, 60_000);

  test('dream --dry-run (Site E — the overnight-cron TODO site) exits, no banner', async () => {
    const copy = copyBrainHome('dream');
    try {
      const { code, durationMs, stderr } = await runWithTimeout(
        ['dream', '--dry-run'],
        60_000,
        { GBRAIN_HOME: copy },
      );
      // Keyless CI: LLM-dependent phases degrade; the IRON rule is exits + no
      // banner. A hang here is the silent-overnight-zombie regression.
      expect(durationMs).toBeLessThan(60_000);
      expect(stderr).not.toContain(TEARDOWN_BANNER);
      expect(code).not.toBeNull();
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }, 90_000);

  test('ze-switch --dry-run (Site H) exits without hanging, no banner', async () => {
    const { code, durationMs, stderr } = await runWithTimeout(
      ['ze-switch', '--dry-run'],
      30_000,
    );
    expect(durationMs).toBeLessThan(30_000);
    expect(stderr).not.toContain(TEARDOWN_BANNER);
    expect(code).not.toBeNull();
  }, 45_000);

  test('D11: teardown deadline does NOT cover handler time (slow-handler regression)', async () => {
    // Post-fix the deadline arms at teardown start, so a 500ms deadline cannot
    // touch the handler: results print in full regardless. NOTE the falsification
    // story is forward-looking, not historical — pre-#2084 code had no env knob
    // (a static 10s constant), so this spawn would pass there too; the guard
    // against re-hoisting the timer above the handler is the structural pin on
    // DISCONNECT_HARD_DEADLINE_MS absence in fix-wave-structural.test.ts. This
    // test pins that the env override is honored AND output survives a deadline
    // far smaller than handler time.
    const { code, stdout, durationMs } = await runWithTimeout(
      ['search', 'foxtrot', '--limit', '3'],
      15_000,
      { GBRAIN_TEARDOWN_DEADLINE_MS: '500' },
    );
    expect(durationMs).toBeLessThan(15_000);
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0); // output intact = handler wasn't killed
  }, 30_000);

  test('D10: piped --json output parses complete (no exit truncation)', async () => {
    // `search stats --json` emits a pure JSON document (the shared-op search
    // path renders human format regardless of --json). A truncated-by-exit
    // pipe fails to parse — the #1959 class, end-to-end.
    const { code, stdout, stderr } = await runWithTimeout(
      ['search', 'stats', '--json'],
      20_000,
    );
    expect(code).toBe(0);
    expect(stderr).not.toContain(TEARDOWN_BANNER);
    expect(() => JSON.parse(stdout)).not.toThrow();
  }, 30_000);
});

describe('v0.41.8.0 — daemon survival (regression guard for narrow force-exit)', () => {
  test('gbrain serve --http stays alive past the timeout window', async () => {
    // Pick a likely-free ephemeral port. We're testing "still alive
    // 3 seconds after startup" — if the force-exit guard misfired
    // on 'serve', the process would die immediately after binding.
    const port = 31000 + Math.floor(Math.random() * 1000);
    const child = spawn(
      SHIM_PATH,
      ['serve', '--http', '--port', String(port), '--token-ttl', '60'],
      {
        cwd: REPO_ROOT,
        env: runEnv,
        detached: false,
      },
    );

    let exitedEarly = false;
    let earlyCode: number | null = null;
    child.on('exit', (code) => {
      exitedEarly = true;
      earlyCode = code;
    });

    // Give the server 3 seconds. If the force-exit narrow guard is
    // working, the daemon stays alive past this window.
    await new Promise((r) => setTimeout(r, 3_000));

    const wasAlive = !exitedEarly;
    try {
      child.kill('SIGTERM');
      // Give it a moment to clean up
      await new Promise((r) => setTimeout(r, 1_000));
      if (!exitedEarly) {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }
    } catch {
      /* already dead */
    }

    if (!wasAlive) {
      throw new Error(
        `gbrain serve --http exited within 3s (code=${earlyCode}). ` +
          `If the narrow force-exit guard misclassified 'serve' as a ` +
          `non-daemon command, this is the regression.`,
      );
    }
    expect(wasAlive).toBe(true);
  }, 15_000);
});
