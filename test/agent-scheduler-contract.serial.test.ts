/**
 * Agent-scheduler contract — the documented shell-chain surface, pinned.
 *
 * SCOPE, stated honestly: the downstream agent platforms documented at
 * docs/guides/live-sync.md:62-81 (the cron-registration examples) have zero
 * detection code in gbrain and no runner in this repo. Their ENTIRE
 * integration is an external cron that shells out to the gbrain CLI and reads
 * exit codes — "/cron add ... gbrain sync --repo X && gbrain embed --stale"
 * (live-sync.md) and INSTALL_FOR_AGENTS.md Step 7. This file pins that
 * consumer contract through a REAL /bin/sh, because the `&&` short-circuit IS
 * the contract; argv arrays cannot exercise it.
 *
 * (Naming note: the specific downstream platform names live in the docs, which
 * carry their own scrub policy; scripts/check-test-real-names.sh bans agent
 * fork names inside test fixtures, so this file uses the generic term.)
 *
 * Anti-vacuity: the fixture commits a real page and every read-back asserts
 * pages >= 1 — an empty repo would satisfy every other assertion here.
 *
 * Explicitly OUT of scope (same docs, separate surfaces): `gbrain
 * check-update --json` (network), and the nightly keyless `gbrain dream`
 * contract — the cycle's embed phase has the same EmbeddingDisabledError
 * class risk this file's chain case pins for embed; filed as a TODO rather
 * than smoke-tested here.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { spawnSync, execFileSync } from 'child_process';

const REPO = resolve(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');
const SKIP = process.env.GBRAIN_SKIP_SUBPROCESS_TESTS === '1';

interface ShellResult { exitCode: number; stdout: string; stderr: string }

describe.skipIf(SKIP)('agent-scheduler shell-chain contract', () => {
  let home = '';
  let tmpbin = '';
  let repoDir = '';
  let cloneDir = '';
  let env: Record<string, string>;

  /** Run a string through a REAL POSIX shell — the && is the thing under test. */
  function sh(command: string, timeoutMs: number, extraEnv: Record<string, string> = {}): ShellResult {
    const res = spawnSync('/bin/sh', ['-c', command], {
      cwd: REPO, // near-repo cwd keeps Bun's transpile cache warm for the shim
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    return { exitCode: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  function statusSyncSection(): { last_sync_at: string | null; staleness_class: string; pages: number } {
    const r = sh('gbrain status --json --section sync', 90_000);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout.trim().split('\n').pop()!);
    const src = report.sync.sources.find((s: { source_id: string }) => s.source_id === 'default')
      ?? report.sync.sources[0];
    expect(src).toBeDefined();
    return { last_sync_at: src.last_sync_at, staleness_class: src.staleness_class, pages: src.pages };
  }

  function git(dir: string, args: string[]): void {
    execFileSync('git', ['-C', dir, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      env: {
        ...env,
        GIT_AUTHOR_DATE: '2026-08-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-08-01T00:00:00Z',
      },
    });
  }

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gb-sched-'));
    tmpbin = mkdtempSync(join(tmpdir(), 'gb-sched-bin-'));
    repoDir = join(home, 'brain');
    cloneDir = join(home, 'brain-clone');

    // The shim is what makes `gbrain` a real command for /bin/sh.
    writeFileSync(join(tmpbin, 'gbrain'), `#!/bin/sh\nexec bun run '${CLI}' "$@"\n`, { mode: 0o755 });
    chmodSync(join(tmpbin, 'gbrain'), 0o755);

    const bunDir = dirname(process.execPath || '/usr/local/bin');
    env = {
      PATH: `${tmpbin}:${bunDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      GBRAIN_HOME: home,
      TMPDIR: tmpdir(),
      // Repo paths cross the shell boundary via env, never string interpolation.
      SCHED_REPO: repoDir,
      SCHED_CLONE: cloneDir,
    };

    // Keyless brain — the install shape whose chain used to exit 1.
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({
        engine: 'pglite',
        database_path: join(home, '.gbrain', 'brain.pglite'),
        embedding_disabled: true,
      }) + '\n',
    );
    const init = spawnSync('bun', ['run', CLI, 'init', '--migrate-only'], {
      cwd: REPO, env, encoding: 'utf8', timeout: 120_000,
    });
    if (init.status !== 0) throw new Error(`init --migrate-only failed:\n${(init.stderr ?? '').slice(-2000)}`);

    // Fixture repo with ONE REAL PAGE (anti-vacuity) + repo-local identity
    // (HOME=tmp has no global gitconfig — commits fail outright without it).
    mkdirSync(join(repoDir, 'people'), { recursive: true });
    git(repoDir, ['init', '-q', '-b', 'main']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Sched Test']);
    writeFileSync(join(repoDir, 'people', 'alice-example.md'), '# Alice Example\n\nA real page so nothing here passes vacuously.\n');
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-q', '-m', 'seed page']);
  }, 180_000);

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(tmpbin, { recursive: true, force: true });
  });

  let firstSyncAt: string | null = null;

  test('1. the documented chain exits 0 on a keyless brain, with the keyless hint on stderr', () => {
    // Verified against unfixed embed.ts during implementation: this chain
    // exited 1 (EmbeddingDisabledError -> blanket process.exit(1)), breaking
    // the documented agent-scheduler cron on every keyless brain. The fix is
    // load-bearing for this exact spelling.
    const r = sh('gbrain sync --repo "$SCHED_REPO" --no-pull && gbrain embed --stale', 150_000);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('Embeddings are disabled');

    const s = statusSyncSection();
    expect(s.pages).toBeGreaterThanOrEqual(1); // anti-vacuity: the page landed
    expect(s.staleness_class).toBe('fresh');
    firstSyncAt = s.last_sync_at;
    expect(firstSyncAt).not.toBeNull();
  }, 300_000);

  test('2. quiet re-run: sync itself reports up_to_date; heartbeat strictly advances', async () => {
    // Cross-second so the strict > below cannot alias on same-second stamps.
    await new Promise((r) => setTimeout(r, 1_100));
    const r = sh('gbrain sync --repo "$SCHED_REPO" --no-pull && gbrain embed --stale', 150_000);
    expect(r.exitCode).toBe(0);
    // The run's OWN verdict, not a timestamp tautology: a crashed second run
    // would satisfy t2 >= t1; it cannot print "Already up to date."
    expect(r.stdout).toContain('Already up to date');

    const s = statusSyncSection();
    expect(s.staleness_class).toBe('fresh');
    // v0.42.52.0 heartbeat: a 0-change sync still bumps last_sync_at.
    expect(Date.parse(s.last_sync_at!)).toBeGreaterThan(Date.parse(firstSyncAt!));
  }, 300_000);

  test('3. the documented weekly chain (doctor --json && embed --stale) exits 0 keyless', () => {
    // Runs BEFORE the poisoned-clone case: that one appends real rows to this
    // brain's sync-failures ledger, which doctor reads and may warn on.
    const r = sh('gbrain doctor --json && gbrain embed --stale', 240_000);
    if (r.exitCode !== 0) {
      // A keyless-first-class bug in its own right — surface the failing checks.
      const doc = (() => { try { return JSON.parse(r.stdout.trim().split('\n').pop()!); } catch { return null; } })();
      const fails = doc?.checks?.filter((c: { status: string }) => c.status === 'fail') ?? [];
      throw new Error(`keyless weekly chain exited ${r.exitCode}; failing checks: ${JSON.stringify(fails.map((f: { name: string; message: string }) => `${f.name}: ${f.message}`), null, 2)}`);
    }
    expect(r.exitCode).toBe(0);
  }, 330_000);

  test('4. pull failure breaks the chain: sync exits 1, embed never runs', () => {
    // A clone whose origin is a local filesystem path: pullRepo's SSRF flag
    // (protocol.file.allow=never) rejects it deterministically on every pull.
    execFileSync('git', ['clone', '-q', '--no-hardlinks', repoDir, cloneDir], {
      env: { ...env, GIT_ALLOW_PROTOCOL: 'file' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    git(cloneDir, ['config', 'user.email', 'test@example.com']);
    git(cloneDir, ['config', 'user.name', 'Sched Test']);

    // Because cases 1-2 already synced the SAME commit for source `default`,
    // the clone's HEAD equals the stored anchor — so this run is ALREADY the
    // quiet case: zero imports + pullFailed (protocol.file rejected) →
    // partial/pull_failed → exit 1 (sync.ts:4994, the #3068 contract), and the
    // && short-circuits: the keyless embed hint must NOT appear. (On a FRESH
    // source the first run imports the working tree and exits 0
    // warn-and-continue; it takes a second, quiet run to surface the wedge —
    // both shapes converge on "a permanently failing pull cannot stay green".)
    const run1 = sh('gbrain sync --repo "$SCHED_CLONE" --source default && gbrain embed --stale', 150_000);
    if (run1.exitCode !== 1) {
      throw new Error(`expected pull_failed exit 1, got ${run1.exitCode}\nstderr:\n${run1.stderr.slice(-2500)}\nstdout:\n${run1.stdout.slice(-800)}`);
    }
    expect(run1.exitCode).toBe(1);
    expect(run1.stderr).not.toContain('Embeddings are disabled');

    // And it stays red on repeat — a wedged pull is not a one-off blip.
    const run2 = sh('gbrain sync --repo "$SCHED_CLONE" --source default && gbrain embed --stale', 150_000);
    expect(run2.exitCode).toBe(1);
    expect(run2.stderr).not.toContain('Embeddings are disabled');
  }, 450_000);
});
