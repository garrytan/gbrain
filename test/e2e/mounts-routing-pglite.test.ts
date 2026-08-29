/**
 * G4 (test-gap plan) — the mount ROUTING journey: brain-resolver → engine
 * wiring exercised over REAL CLI spawns against two REAL PGLite databases
 * (host brain + one mount). Hermetic: no DATABASE_URL, no provider keys.
 * Lives in test/e2e/ because it spawns `bun run src/cli.ts` repeatedly, not
 * because it needs a live Postgres.
 *
 * The REAL tier order (pinned from src/core/brain-resolver.ts:resolveBrainId):
 *   1. explicit `--brain <id>` flag
 *   2. GBRAIN_BRAIN_ID env var
 *   3. `.gbrain-mount` dotfile walk-up from CWD (lstat + isTrustedDotfile:
 *      symlinked / foreign-owned / world-writable dotfiles are REFUSED
 *      fail-closed and the walk continues — src/core/path-confine.ts)
 *   4. registered mount whose `path` contains CWD (longest realpath prefix;
 *      `enabled: false` mounts are skipped)
 *   5. brain-level default (NOT wired — documented placeholder in the source)
 *   6. literal 'host' fallback
 *
 * So the dotfile tier BEATS the path-prefix tier: a `.gbrain-mount` saying
 * `host` inside a mount's directory opts that subtree back to the host brain.
 *
 * Fail-closed engine wiring (src/cli.ts:connectMountEngine): a resolved
 * non-host id routes through BrainRegistry.getBrain — an unknown/DISABLED
 * mount id is a loud UnknownBrainError, never a silent host fallback. The
 * ambient tiers (dotfile / path-prefix) simply stop matching a disabled
 * mount, so unflagged reads fall back to host.
 *
 * Discriminator: the SAME slug is seeded in both brains with different
 * content, so every read proves WHICH DATABASE served it.
 *
 * Mount DB provisioning: BrainRegistry.initMountBrain deliberately runs NO
 * migrations against a mount (schema is the publisher's job), so this suite
 * plays publisher once with an in-process PGLiteEngine.initSchema() against
 * the mount's database_path — the same path `mounts add --db-path` registers.
 *
 * Cost note: GBRAIN_PGLITE_SNAPSHOT is inherited by spawned CLIs but the
 * loader only honors it for in-memory DBs (pglite-engine.ts: `!dataDir`
 * guard), so both persistent brains replay migrations exactly once (init +
 * the in-process seed); every later spawn just reopens the data dir (~1.5s).
 * The subcommand DISPATCH surface (parseAddArgs, redactUrl, flag verbs) is
 * already covered in test/mounts-cli.test.ts — not duplicated here.
 */

import { describe, test as testRaw, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

function test(name: string, fn: () => void | Promise<unknown>): void {
  testRaw(name, fn, 120000);
}

const CLI = join(import.meta.dir, '..', '..', 'src', 'cli.ts');

const SLUG = 'routing-marker';
const HOST_MARKER = 'HOST-MARKER-7f3a1c';
const MOUNT_MARKER = 'MOUNT-MARKER-b29e4d';

// The dotfile trust gate only applies where numeric uids exist (POSIX).
// On Windows isTrustedDotfile trusts by default — the guard tests would
// assert refusals that by design do not happen there.
const POSIX = typeof process.getuid === 'function';

interface RunResult { exitCode: number; stdout: string; stderr: string; }

describe('mounts routing journey (e2e, PGLite, real CLI spawns)', () => {
  let root: string;         // fixture root — everything lives under here
  let home: string;         // HOME + GBRAIN_HOME parent (host brain)
  let mountDir: string;     // the mount's "clone" path (tier-4 prefix anchor)
  let mountDb: string;      // the mount's PGLite data dir (database_path)
  let neutralDir: string;   // a cwd unrelated to any mount path
  let addResult: RunResult; // captured `mounts add` output (asserted in test 1)

  async function gbrain(
    args: string[],
    opts: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<RunResult> {
    // Env-scrub pattern (see test/e2e/bootstrap-*): inherit, then strip
    // everything that could re-route or authenticate the spawned CLI.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    for (const k of [
      // engine re-routing: loadConfig's env>file precedence would flip the
      // host brain onto a live Postgres.
      'DATABASE_URL', 'GBRAIN_DATABASE_URL',
      // the two routing-axis env tiers under test — must start clean.
      'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE',
      // auth/provider keys — hermetic runs must never authenticate.
      'GBRAIN_REMOTE_CLIENT_SECRET', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
      'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY',
    ]) delete env[k];
    env.HOME = home;            // homedir() → <home>/.gbrain/mounts.json
    env.GBRAIN_HOME = home;     // configDir() → <home>/.gbrain/config.json
    // Belt over the HOME suspender: Bun's homedir() reads the password DB on
    // some platforms (see bootstrap-harness-lifecycle), so pin mounts.json
    // via the documented test seam too. Same file HOME already points at.
    env.GBRAIN_MOUNTS_PATH = join(home, '.gbrain', 'mounts.json');
    env.GBRAIN_SELF_UPGRADE_MODE = 'off'; // no network probe / stdout banner
    Object.assign(env, opts.env);

    const proc = Bun.spawn({
      cmd: ['bun', 'run', CLI, ...args],
      env,
      cwd: opts.cwd ?? neutralDir,
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  /** Assert a read served the expected brain's copy of the shared slug. */
  function expectServedBy(res: RunResult, marker: string): void {
    const other = marker === HOST_MARKER ? MOUNT_MARKER : HOST_MARKER;
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(marker);
    expect(res.stdout).not.toContain(other);
  }

  /** Create a dir carrying a TRUSTED .gbrain-mount (owned, 0644, real file). */
  function dirWithDotfile(name: string, content: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const dotfile = join(dir, '.gbrain-mount');
    writeFileSync(dotfile, content + '\n');
    // Explicit 0644: a umask-0 environment would otherwise create it 0666
    // and the trust gate would (correctly) refuse our own dotfile.
    chmodSync(dotfile, 0o644);
    return dir;
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-mounts-routing-'));
    home = join(root, 'home');
    mountDir = join(root, 'mount-a');
    mountDb = join(mountDir, '.pglite');
    neutralDir = join(root, 'neutral');
    for (const d of [home, mountDir, neutralDir]) mkdirSync(d, { recursive: true });

    // 1. Host brain: real `gbrain init` (PGLite at <home>/.gbrain/brain.pglite).
    const init = await gbrain(['init', '--pglite', '--no-embedding', '--non-interactive']);
    if (init.exitCode !== 0) throw new Error(`host init failed: ${init.stderr || init.stdout}`);

    // 2. Publisher step: schema for the mount DB (registry never migrates it).
    const seed = new PGLiteEngine();
    await seed.connect({ engine: 'pglite', database_path: mountDb });
    await seed.initSchema();
    await seed.disconnect();

    // 3. Register the mount via the real CLI (real argv), from a neutral cwd.
    addResult = await gbrain([
      'mounts', 'add', 'mount-a',
      '--path', mountDir, '--engine', 'pglite', '--db-path', mountDb,
    ]);
    if (addResult.exitCode !== 0) {
      throw new Error(`mounts add failed: ${addResult.stderr || addResult.stdout}`);
    }

    // 4. Distinct markers under the SAME slug. Both writes are UNFLAGGED, so
    //    they already exercise routing on the write side: neutral cwd → host
    //    (tier 6), cwd inside the mount → mount (tier 4).
    const putHost = await gbrain(['put', SLUG, '--content', `${HOST_MARKER} host copy`]);
    if (putHost.exitCode !== 0) throw new Error(`host put failed: ${putHost.stderr || putHost.stdout}`);
    const putMount = await gbrain(
      ['put', SLUG, '--content', `${MOUNT_MARKER} mount copy`],
      { cwd: mountDir },
    );
    if (putMount.exitCode !== 0) throw new Error(`mount put failed: ${putMount.stderr || putMount.stdout}`);
  }, 180000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('(1) mounts add registered it and mounts list shows it', async () => {
    expect(addResult.stdout).toContain('Mount "mount-a" added');
    const list = await gbrain(['mounts', 'list', '--json']);
    expect(list.exitCode).toBe(0);
    const parsed = JSON.parse(list.stdout) as {
      version: number;
      mounts: Array<{ id: string; path: string; engine: string; database_path?: string; enabled?: boolean }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.mounts).toHaveLength(1);
    expect(parsed.mounts[0].id).toBe('mount-a');
    expect(parsed.mounts[0].engine).toBe('pglite');
    expect(parsed.mounts[0].path).toBe(mountDir);
    expect(parsed.mounts[0].database_path).toBe(mountDb);
    expect(parsed.mounts[0].enabled).toBe(true);
  });

  test('(2) unflagged read routes by cwd: mount path-prefix (tier 4) vs host fallback (tier 6)', async () => {
    // cwd inside the mount's registered path → the MOUNT's copy.
    expectServedBy(await gbrain(['get', SLUG], { cwd: mountDir }), MOUNT_MARKER);
    // unrelated cwd, no dotfile, no env → terminal 'host' fallback.
    expectServedBy(await gbrain(['get', SLUG]), HOST_MARKER);
  });

  test('(3) .gbrain-mount dotfile in an UNRELATED cwd routes to the named mount (tier 3)', async () => {
    const dir = dirWithDotfile('unrelated-dotfile', 'mount-a');
    expectServedBy(await gbrain(['get', SLUG], { cwd: dir }), MOUNT_MARKER);
  });

  test('(4) dotfile BEATS path-prefix: content `host` inside the mount opts back to host', async () => {
    // Tier 3 fires before tier 4 ever runs — a `.gbrain-mount` saying `host`
    // in a subdir of mount-a's own path wins over the enclosing prefix match.
    const dir = dirWithDotfile('mount-a/host-opt-out', 'host');
    expectServedBy(await gbrain(['get', SLUG], { cwd: dir }), HOST_MARKER);
    // Sibling subdir WITHOUT a dotfile still routes to the mount — the
    // opt-out is dotfile-scoped, not mount-wide.
    const plain = join(mountDir, 'plain-subdir');
    mkdirSync(plain, { recursive: true });
    expectServedBy(await gbrain(['get', SLUG], { cwd: plain }), MOUNT_MARKER);
  });

  test('(5) upper tiers: GBRAIN_BRAIN_ID (tier 2) beats dotfile; --brain flag (tier 1) beats env', async () => {
    const dotfileHost = dirWithDotfile('mount-a/env-vs-dotfile', 'host');
    // env=mount-a vs dotfile=host → env wins.
    expectServedBy(
      await gbrain(['get', SLUG], { cwd: dotfileHost, env: { GBRAIN_BRAIN_ID: 'mount-a' } }),
      MOUNT_MARKER,
    );
    // env=host vs path-prefix=mount-a → env wins.
    expectServedBy(
      await gbrain(['get', SLUG], { cwd: mountDir, env: { GBRAIN_BRAIN_ID: 'host' } }),
      HOST_MARKER,
    );
    // flag=mount-a vs env=host (and dotfile=host underneath) → flag wins.
    expectServedBy(
      await gbrain(['--brain', 'mount-a', 'get', SLUG], {
        cwd: dotfileHost, env: { GBRAIN_BRAIN_ID: 'host' },
      }),
      MOUNT_MARKER,
    );
  });

  testRaw.skipIf(!POSIX)(
    '(5b) fail-closed dotfile guards: a SYMLINKED .gbrain-mount is refused → host',
    async () => {
      // The redirect target is itself a trusted-looking file naming the mount;
      // the refusal is attributable to the symlink alone (lstat, never stat —
      // src/core/brain-resolver.ts:readDotfileWalk + isTrustedDotfile).
      const dir = join(root, 'symlink-dotfile');
      mkdirSync(dir, { recursive: true });
      const target = join(root, 'symlink-target.txt');
      writeFileSync(target, 'mount-a\n');
      chmodSync(target, 0o644);
      symlinkSync(target, join(dir, '.gbrain-mount'));
      expectServedBy(await gbrain(['get', SLUG], { cwd: dir }), HOST_MARKER);
    },
    120000,
  );

  testRaw.skipIf(!POSIX)(
    '(5c) fail-closed dotfile guards: a world-writable (0666) .gbrain-mount is refused → host',
    async () => {
      const dir = dirWithDotfile('world-writable-dotfile', 'mount-a');
      chmodSync(join(dir, '.gbrain-mount'), 0o666);
      expectServedBy(await gbrain(['get', SLUG], { cwd: dir }), HOST_MARKER);
    },
    120000,
  );

  test('(6) mounts disable: ambient reads fall back to host; explicit --brain fails LOUDLY; enable restores', async () => {
    const disable = await gbrain(['mounts', 'disable', 'mount-a']);
    expect(disable.exitCode).toBe(0);
    expect(disable.stdout).toContain('enabled=false');

    // Path-prefix skips disabled mounts → unflagged read from inside the
    // mount's directory falls back to the host brain.
    expectServedBy(await gbrain(['get', SLUG], { cwd: mountDir }), HOST_MARKER);

    // But an EXPLICIT --brain on a disabled mount must never silently fall
    // back to host (connectMountEngine → BrainRegistry → UnknownBrainError).
    const explicit = await gbrain(['--brain', 'mount-a', 'get', SLUG]);
    expect(explicit.exitCode).not.toBe(0);
    expect(explicit.stdout + explicit.stderr).toMatch(/Unknown brain/i);
    expect(explicit.stdout).not.toContain(HOST_MARKER);

    // Re-enable → the prefix tier routes to the mount again.
    const enable = await gbrain(['mounts', 'enable', 'mount-a']);
    expect(enable.exitCode).toBe(0);
    expectServedBy(await gbrain(['get', SLUG], { cwd: mountDir }), MOUNT_MARKER);
  });
});
