/**
 * Autopilot launchd lifecycle — the e2e that closes the artifact-presence gap.
 *
 * PR-A rewrote `autopilot --status` because the old one answered "installed"
 * from a bare plist existsSync while the daemon had been dead for 71 days. The
 * unit tests for the fix assert the STRINGS we generate (guard text, plist
 * XML) — the same anti-pattern one level up. This file asserts BEHAVIOR:
 *
 *   Describe A (every platform, incl. ubuntu CI): the full install →
 *     self-disable → status → reinstall → uninstall arc, with `launchctl`
 *     replaced by an argv recorder, and the generated wrapper executed by a
 *     REAL bash against a genuinely deleted repo.
 *
 *   Describe B (darwin only, fail-SKIP): the same self-disable against the
 *     REAL launchd — job provably loaded (RunAtLoad ran our wrapper),
 *     `launchctl kickstart -k` forces the guard after the repo vanishes, and
 *     the job is provably gone afterwards. Non-vacuous by construction: each
 *     link is asserted separately, so "job absent" can't be true for the
 *     wrong reason.
 *
 * Label safety: every spawn sets GBRAIN_AUTOPILOT_LABEL to a unique test
 * label, so this can never collide with — or tear down — a real
 * com.gbrain.autopilot install on the machine running the tests. Cleanup is
 * OWN-LABEL ONLY: a prefix sweep would boot out a concurrent Conductor
 * workspace's live test run on the same Mac.
 *
 * Known real-machine flake vector (describe B): the launchd-spawned wrapper
 * runs with the REAL user's HOME and sources their zshenv/zshrc before the
 * guard (launchd does not inherit our test env). A dotfile that execs another
 * shell or stalls can eat the wrapper. The marker path and label are baked as
 * absolute strings at install time so they cannot be misrouted; if the poll
 * times out, the failure dump names this vector. Escape hatch:
 * GBRAIN_SKIP_LAUNCHD_E2E=1.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { spawnSync } from 'child_process';
import { withEnv } from './helpers/with-env.ts';
import { autopilotLaunchdLabel } from '../src/core/autopilot-paths.ts';

const REPO = resolve(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');
const SKIP_SUBPROCESS = process.env.GBRAIN_SKIP_SUBPROCESS_TESTS === '1';

// ── label seam unit tests (serial file on purpose: env mutation would
//    interleave with other autopilot tests in the parallel lane) ─────────────

describe('autopilotLaunchdLabel', () => {
  test('default label, env unset', async () => {
    await withEnv({ GBRAIN_AUTOPILOT_LABEL: undefined }, async () => {
      expect(autopilotLaunchdLabel()).toBe('com.gbrain.autopilot');
    });
  });

  test('override lands in the generated guard bootout line', async () => {
    await withEnv({ GBRAIN_AUTOPILOT_LABEL: 'com.gbrain.autopilot.test.override' }, async () => {
      const { generateSelfDisableGuard } = await import('../src/commands/autopilot.ts');
      const guard = generateSelfDisableGuard('/data/brain', 'macos');
      expect(guard).toContain('gui/$(id -u)/com.gbrain.autopilot.test.override');
    });
  });

  test('grammar: shell/filesystem metacharacters are rejected', async () => {
    // The label reaches a plist FILENAME and a double-quoted shell line;
    // escapeXml protects only the XML site.
    for (const evil of ['a/b', 'a b', 'a"b', "a'b", 'a$b', 'a`b', 'a..b', '']) {
      await withEnv({ GBRAIN_AUTOPILOT_LABEL: evil }, async () => {
        expect(() => autopilotLaunchdLabel()).toThrow(/invalid GBRAIN_AUTOPILOT_LABEL/);
      });
    }
  });
});

// ── keyless explicit-slug contract (spawn-free; the deliberate exit-1 half
//    of the embed keyless fix) ───────────────────────────────────────────────

describe('embed keyless: explicit requests still fail loudly', () => {
  test('runEmbedCore throws EmbeddingDisabledError for a named slug on a keyless brain', async () => {
    // The --stale path refuses cleanly (exit 0) because the documented agent
    // chain depends on it. A user who NAMED a page asked for something
    // impossible on a keyless brain — that must stay a structured failure.
    const { assertEmbeddingEnabled, EmbeddingDisabledError } = await import('../src/core/embedding-dim-check.ts');
    expect(() => assertEmbeddingEnabled({ embedding_disabled: true } as never))
      .toThrow(EmbeddingDisabledError);
  });
});

// ── shared subprocess helpers ────────────────────────────────────────────────

interface CliResult { exitCode: number; stdout: string; stderr: string }

function runCli(args: string[], env: Record<string, string>, timeoutMs: number): CliResult {
  const res = spawnSync('bun', ['run', CLI, ...args], {
    cwd: REPO, // near-repo cwd keeps Bun's transpile cache warm (5-20s/spawn otherwise)
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return { exitCode: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Minimal PATH: tmpbin first, then the running bun's dir, then the OS basics. */
function basePath(tmpbin: string): string {
  const bunDir = dirname(process.execPath || '/usr/local/bin');
  return `${tmpbin}:${bunDir}:/usr/bin:/bin:/usr/sbin:/sbin`;
}

/** Write the keyless PGLite config by hand (fast path; skips init's provider dance). */
function seedBrain(home: string, env: Record<string, string>): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      database_path: join(home, '.gbrain', 'brain.pglite'),
      embedding_disabled: true,
    }) + '\n',
  );
  const r = runCli(['init', '--migrate-only'], env, 120_000);
  if (r.exitCode !== 0) {
    throw new Error(`seedBrain init --migrate-only failed (${r.exitCode}):\n${r.stderr.slice(-2000)}`);
  }
}

// ── Describe A: shimmed lifecycle (all platforms) ───────────────────────────

describe.skipIf(SKIP_SUBPROCESS)('autopilot launchd lifecycle — shimmed (all platforms)', () => {
  const label = `com.gbrain.autopilot.test.${process.pid}`;
  let home = '';
  let tmpbin = '';
  let repoDir = '';
  let recordFile = '';
  let breadcrumbFile = '';
  let env: Record<string, string>;

  const plist = () => join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const wrapper = () => join(home, '.gbrain', 'autopilot-run.sh');
  const marker = () => join(home, '.gbrain', 'autopilot-disabled');
  const recorded = () => (existsSync(recordFile) ? readFileSync(recordFile, 'utf8') : '');

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gb-launchd-a-'));
    tmpbin = mkdtempSync(join(tmpdir(), 'gb-launchd-bin-'));
    repoDir = join(home, 'brain-repo');
    mkdirSync(repoDir, { recursive: true });
    recordFile = join(tmpbin, 'record.log');
    breadcrumbFile = join(tmpbin, 'execed.log');

    // launchctl argv recorder — exit 0 so install's execSync succeeds.
    writeFileSync(join(tmpbin, 'launchctl'), `#!/bin/sh\necho "launchctl $*" >> '${recordFile}'\nexit 0\n`, { mode: 0o755 });
    // crontab no-op — detectInstalledTarget falls through to the REAL
    // `crontab -l` on non-darwin; a dev's real gbrain cron entry would flip
    // the verdict to linux-cron.
    writeFileSync(join(tmpbin, 'crontab'), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
    // gbrain breadcrumb — `which gbrain` at install time bakes THIS into the
    // wrapper's exec line. Records context, exits 0. NOTE: asserts "a process
    // execed gbrain from PATH", not "the daemon started" — assert on context.
    writeFileSync(join(tmpbin, 'gbrain'), `#!/bin/sh\necho "gbrain $*" >> '${breadcrumbFile}'\nexit 0\n`, { mode: 0o755 });
    for (const f of ['launchctl', 'crontab', 'gbrain']) chmodSync(join(tmpbin, f), 0o755);

    env = {
      PATH: basePath(tmpbin),
      HOME: home,
      GBRAIN_HOME: home,
      GBRAIN_AUTOPILOT_LABEL: label,
      TMPDIR: tmpdir(),
    };
    seedBrain(home, env);
  }, 180_000);

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(tmpbin, { recursive: true, force: true });
  });

  test('1. virgin status → not_installed, exit 0', () => {
    const r = runCli(['autopilot', '--status', '--json'], env, 90_000);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(report.state).toBe('not_installed');
  }, 120_000);

  test('2. install --target macos: plist + wrapper + recorded load', () => {
    // #677: a PGLite brain REFUSES a daemon install without --force (the
    // daemon would hold the single-writer DB lock 24/7). Pin the refusal at
    // the CLI boundary first, then run the lifecycle arc through the
    // documented dedicated-brain override.
    const refused = runCli(['autopilot', '--install', '--target', 'macos', '--repo', repoDir], env, 90_000);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('PGLite');
    expect(refused.stderr).toContain('--force');
    expect(existsSync(plist())).toBe(false);

    const r = runCli(['autopilot', '--install', '--force', '--target', 'macos', '--repo', repoDir], env, 90_000);
    expect(r.exitCode).toBe(0);
    expect(existsSync(plist())).toBe(true);
    const xml = readFileSync(plist(), 'utf8');
    expect(xml).toContain(`<string>${label}</string>`);
    expect(recorded()).toContain(`launchctl load ${plist()}`);
    const w = readFileSync(wrapper(), 'utf8');
    // Guard precedes exec — the self-disable must run before the daemon could start.
    expect(w.indexOf('repo path gone')).toBeGreaterThan(-1);
    expect(w.indexOf('repo path gone')).toBeLessThan(w.indexOf('exec '));
    expect(w).toContain(`gui/$(id -u)/${label}`);
    // #3696: the repo-cwd pin lives in the WRAPPER, between guard and exec
    // (a plist WorkingDirectory=repo would fail every respawn once the repo
    // is deleted, so the guard could never fire). The plist must therefore
    // NOT point its WorkingDirectory at the repo.
    expect(w.indexOf('repo path gone')).toBeLessThan(w.indexOf(`\ncd '`));
    expect(w.indexOf(`\ncd '`)).toBeLessThan(w.indexOf('exec '));
    expect(xml).not.toContain(`<key>WorkingDirectory</key><string>${repoDir}</string>`);
  }, 120_000);

  test('3. repo deleted → three strikes, THEN marker + recorded bootout', () => {
    rmSync(repoDir, { recursive: true, force: true });
    // One transient miss must not kill the install (repos on external or
    // cloud-synced volumes are routinely absent right after login) — the
    // guard requires three consecutive misses. Runs 1 and 2 exit 0 with no
    // marker and no bootout; run 3 disables for real.
    for (const run of [1, 2]) {
      const res = spawnSync('bash', [wrapper()], { env, encoding: 'utf8', timeout: 30_000 });
      expect(res.status).toBe(0);
      expect(existsSync(marker())).toBe(false);
      expect(recorded()).not.toContain('launchctl bootout gui/');
      expect(run).toBeGreaterThan(0);
    }
    const res = spawnSync('bash', [wrapper()], { env, encoding: 'utf8', timeout: 30_000 });
    expect(res.status).toBe(0);
    expect(existsSync(marker())).toBe(true);
    expect(readFileSync(marker(), 'utf8')).toContain(repoDir);
    expect(recorded()).toContain(`launchctl bootout gui/`);
    expect(recorded()).toContain(label);
  }, 120_000);

  test('4. status after self-disable → disabled, names the path, exit 2', () => {
    const r = runCli(['autopilot', '--status', '--json'], env, 90_000);
    expect(r.exitCode).toBe(2);
    const report = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(report.state).toBe('disabled');
    expect(report.disabled_reason).toContain(repoDir);
  }, 120_000);

  test('5. reinstall against a RECREATED repo clears the marker', () => {
    // Recreate first — reinstalling against the deleted path would only prove
    // marker-clearing while leaving an immediately-doomed install.
    mkdirSync(repoDir, { recursive: true });
    // --force: PGLite daemon guard (#677) — see test 2.
    const r = runCli(['autopilot', '--install', '--force', '--target', 'macos', '--repo', repoDir], env, 90_000);
    expect(r.exitCode).toBe(0);
    expect(existsSync(marker())).toBe(false);
  }, 120_000);

  test('6. uninstall: plist gone, recorded unload, markers cleared', () => {
    // Seed a disabled marker first: without the uninstall-time clear, a
    // self-disabled-then-uninstalled machine reports "DISABLED" with exit 2
    // forever ('disabled' outranks 'not_installed' in the classifier).
    writeFileSync(marker(), 'repo path gone: /somewhere\n');
    const r = runCli(['autopilot', '--uninstall'], env, 90_000);
    expect(r.exitCode).toBe(0);
    expect(existsSync(plist())).toBe(false);
    expect(recorded()).toContain(`launchctl unload ${plist()}`);
    expect(existsSync(marker())).toBe(false);

    const status = runCli(['autopilot', '--status', '--json'], env, 90_000);
    expect(JSON.parse(status.stdout).state).toBe('not_installed');
    expect(status.exitCode).toBe(0);
  }, 240_000);

  test('7. the daemon never started: breadcrumb has no autopilot exec', () => {
    const crumbs = existsSync(breadcrumbFile) ? readFileSync(breadcrumbFile, 'utf8') : '';
    expect(crumbs).not.toContain('autopilot --repo');
  });
});

// ── Describe B: REAL launchd (darwin, fail-SKIP) ────────────────────────────

function canUseLaunchd(): boolean {
  if (process.platform !== 'darwin') return false;
  if (process.env.GBRAIN_SKIP_LAUNCHD_E2E === '1') return false;
  if (typeof process.getuid !== 'function') return false;
  const probe = spawnSync('launchctl', ['print', `gui/${process.getuid()}`], { encoding: 'utf8', timeout: 10_000 });
  return probe.status === 0;
}

const LAUNCHD_OK = canUseLaunchd();
if (!LAUNCHD_OK && process.env.GBRAIN_REQUIRE_LAUNCHD === '1') {
  throw new Error('[autopilot-launchd-lifecycle] GBRAIN_REQUIRE_LAUNCHD=1 but the launchd GUI domain is unavailable');
}

describe.skipIf(SKIP_SUBPROCESS || !LAUNCHD_OK)('autopilot launchd lifecycle — REAL launchd (darwin)', () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const label = `com.gbrain.autopilot.e2e.${process.pid}.${Date.now()}`;
  let home = '';
  let tmpbin = '';
  let repoDir = '';
  let breadcrumbFile = '';
  let env: Record<string, string>;

  const plist = () => join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const marker = () => join(home, '.gbrain', 'autopilot-disabled');
  const printJob = () => spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8', timeout: 10_000 });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gb-launchd-b-'));
    tmpbin = mkdtempSync(join(tmpdir(), 'gb-launchd-b-bin-'));
    repoDir = join(home, 'brain-repo');
    mkdirSync(repoDir, { recursive: true });
    breadcrumbFile = join(tmpbin, 'execed.log');

    // gbrain breadcrumb only — NO launchctl shim here: install must reach the
    // real launchd. Breadcrumb path baked ABSOLUTE: launchd will not pass our
    // test env to the wrapper it spawns.
    writeFileSync(join(tmpbin, 'gbrain'), `#!/bin/sh\necho "gbrain $*" >> '${breadcrumbFile}'\nexit 0\n`, { mode: 0o755 });

    env = {
      PATH: basePath(tmpbin),
      HOME: home,
      GBRAIN_HOME: home,
      GBRAIN_AUTOPILOT_LABEL: label,
      TMPDIR: tmpdir(),
    };
    seedBrain(home, env);
  }, 180_000);

  afterAll(() => {
    // Own-label only. Bootout BEFORE removing files: launchd never rescans a
    // tmp-HOME LaunchAgents dir, so a leftover job dies at logout regardless,
    // but booting first keeps the teardown quiet.
    spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { timeout: 10_000 });
    rmSync(home, { recursive: true, force: true });
    rmSync(tmpbin, { recursive: true, force: true });
  });

  test('1. install loads a real job and RunAtLoad runs our wrapper', async () => {
    // --force: PGLite daemon guard (#677) — the shimmed describe pins the
    // refusal; this one exercises the real-launchd arc past it.
    const r = runCli(['autopilot', '--install', '--force', '--target', 'macos', '--repo', repoDir], env, 90_000);
    expect(r.exitCode).toBe(0);
    expect(existsSync(plist())).toBe(true);

    // Breadcrumb = launchd genuinely spawned the wrapper AND the wrapper ran
    // end-to-end to its exec line (repo exists, guard passed). This is the
    // "install verified nothing" gap actually closing.
    let sawBreadcrumb = false;
    for (let i = 0; i < 60; i++) {
      if (existsSync(breadcrumbFile) && readFileSync(breadcrumbFile, 'utf8').includes('autopilot --repo')) {
        sawBreadcrumb = true;
        break;
      }
      await sleep(500);
    }
    if (!sawBreadcrumb) {
      const p = printJob();
      throw new Error(
        `wrapper never ran under launchd within 30s.\n`
        + `Likely: a dotfile in the REAL user zshenv/zshrc exec'd another shell or stalled `
        + `(launchd runs the wrapper with your real HOME). Escape hatch: GBRAIN_SKIP_LAUNCHD_E2E=1.\n`
        + `launchctl print (exit ${p.status}):\n${(p.stdout || p.stderr).slice(0, 1500)}`,
      );
    }
    expect(printJob().status).toBe(0); // job registered; KeepAlive keeps it so
  }, 180_000);

  test('2. repo deleted → guard self-disables: marker written, job gone', async () => {
    rmSync(repoDir, { recursive: true, force: true });
    // The guard needs three consecutive misses before disabling; under real
    // launchd that is three ThrottleInterval windows (~3min). Pre-seed two
    // strikes so the NEXT respawned run crosses the threshold — this still
    // exercises the real counter read + threshold + bootout path while
    // keeping the poll inside one throttle window.
    writeFileSync(join(home, '.gbrain', 'autopilot-disable-strikes'), '2\n');
    // Best-effort accelerant only. Observed live: kickstart BLOCKS (not
    // errors) when the job is inside its ThrottleInterval window after the
    // shim's quick exits, so we must not assert its exit code or depend on
    // it at all. KeepAlive + ThrottleInterval=60 guarantees launchd respawns
    // the wrapper naturally within one throttle window, and the respawned
    // wrapper hits the guard. The poll therefore spans >60s.
    spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { encoding: 'utf8', timeout: 10_000 });

    let ok = false;
    for (let i = 0; i < 180; i++) { // 90s: one full throttle window + slack
      if (existsSync(marker()) && printJob().status !== 0) { ok = true; break; }
      await sleep(500);
    }
    if (!ok) {
      const p = printJob();
      const log = join(home, '.gbrain', 'autopilot.log');
      const err = join(home, '.gbrain', 'autopilot.err');
      throw new Error(
        `self-disable did not converge in 90s: marker=${existsSync(marker())} printExit=${p.status}\n`
        + `autopilot.log:\n${existsSync(log) ? readFileSync(log, 'utf8').slice(-1200) : '(absent)'}\n`
        + `autopilot.err:\n${existsSync(err) ? readFileSync(err, 'utf8').slice(-1200) : '(absent)'}`,
      );
    }
    expect(readFileSync(marker(), 'utf8')).toContain(repoDir);
  }, 240_000);

  test('3. status reports disabled with exit 2', () => {
    const r = runCli(['autopilot', '--status', '--json'], env, 90_000);
    expect(r.exitCode).toBe(2);
    const report = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(report.state).toBe('disabled');
  }, 120_000);
});
