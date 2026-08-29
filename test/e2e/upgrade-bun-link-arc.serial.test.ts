/**
 * E2E — the bun-link (from-source) upgrade arc, fully shimmed (test-gap plan G6).
 *
 * What the unit layer (test/upgrade.serial.test.ts) pins by SOURCE ANALYSIS,
 * this file pins BEHAVIORALLY, offline, against a throwaway git fixture:
 *
 *   1. Detection marker reality: `detectInstallMethod()` returns 'bun-link'
 *      when a `.git/config` within 6 parent hops of `process.argv[1]` contains
 *      the substring `garrytan/gbrain` (case-insensitive). There is NO bun-link
 *      receipt file — the git remote URL text is the whole marker. The fixture
 *      manufactures it by hosting the bare origin at a local path that itself
 *      contains `garrytan/gbrain`, so the clone's `.git/config` carries the
 *      marker while every git operation stays on the local filesystem.
 *   2. The upgrade sequence: REAL `git -C <root> pull --ff-only` against the
 *      local bare origin (one commit ahead), THEN `bun install` in the clone.
 *      Only `bun` and `gbrain` are PATH-shimmed (argv recorders that exit 0 and
 *      print nothing, except the `--version` reply verifyUpgrade needs). The
 *      bun recorder also notes `git rev-parse HEAD` at call time, so
 *      pull-BEFORE-install ordering is provable without shimming git.
 *   3. runPostUpgrade advances its checkpoint: the migration ledger at
 *      `$GBRAIN_HOME/.gbrain/migrations/completed.jsonl`
 *      (src/core/preferences.ts:appendCompletedMigration, written by the
 *      runApplyMigrations tail of runPostUpgrade), plus the
 *      `self_upgrade.mode/mode_prompted` one-shot in config.json.
 *   4. `--swap-only` stops after the swap + verify + breadcrumb: no
 *      `gbrain post-upgrade`, no `gbrain features` child.
 *
 * Drive mode (and why nothing here is in-process except pure detection):
 *   - `detectInstallMethod` spawns nothing on the bun-link path, so test 1
 *     calls it in-process with `process.argv[1]` patched into the fixture.
 *   - `runUpgrade` has no process.exit sites on this arc, but it CANNOT be
 *     driven in-process under a PATH shim: Bun snapshots PATH at process start
 *     for child-spawn resolution (verified on 1.3.10 — a `process.env.PATH`
 *     mutation is invisible to execFileSync lookup), so the recorder shims
 *     would never intercept `bun install`. Instead each fixture clone gets an
 *     UNTRACKED `src/cli.ts` driver that imports the real repo's runUpgrade —
 *     the honest bun-link shape (argv[1] lives inside the checkout, so
 *     detection resolves the clone with no patching) — and the test spawns it
 *     with the shim dir already first on PATH.
 *   - `runPostUpgrade` is driven by SPAWNING `bun src/cli.ts post-upgrade`
 *     from the real repo: its runApplyMigrations tail owns process.exit sites
 *     (exit(0) on "All migrations up to date"), which would kill an in-process
 *     test run.
 *
 * Safety: the dev checkout's own origin IS garrytan/gbrain, so the driver
 * carries a tripwire — if the "Upgrading bun-link source clone at ..." banner
 * ever names a root outside the fixture clone, it exits 3 BEFORE any git/bun
 * child runs. The real repo is never touched.
 *
 * Serial: test 1 mutates process.argv[1] file-wide (restored in afterEach);
 * run-e2e.sh runs each e2e file in its own bun process regardless.
 */

import { describe, test, expect, afterEach, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectInstallMethod } from '../../src/commands/upgrade.ts';
import { migrations } from '../../src/commands/migrations/index.ts';
import { VERSION } from '../../src/version.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const CLI_PATH = join(REPO_ROOT, 'src', 'cli.ts');
const REAL_UPGRADE_TS = join(REPO_ROOT, 'src', 'commands', 'upgrade.ts');

/** Version the gbrain shim reports, so verifyUpgrade's parse is deterministic. */
const SHIM_NEW_VERSION = '9.9.9.9';

const cleanupDirs: string[] = [];

// Isolated HOME for fixture git invocations (no user/system gitconfig).
const GIT_HOME = mkdtempSync(join(tmpdir(), 'gbrain-bunlink-githome-'));
cleanupDirs.push(GIT_HOME);
const GIT_IDENTITY = ['-c', 'user.name=gbrain-e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false'];

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: GIT_HOME,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

interface BaseFixture {
  root: string;
  home: string;    // temp HOME + GBRAIN_HOME parent (`.gbrain` appended by config resolution)
  shimDir: string; // PATH-prepended recorder shims: bun, gbrain (+ crontab/systemctl containment)
  argvLog: string;
}

interface Fixture extends BaseFixture {
  origin: string;          // local bare origin; its PATH carries the detection marker
  clone: string;           // the "bun-linked" source clone, one commit behind origin
  driver: string;          // untracked <clone>/src/cli.ts — the bun-link entry point
  originHead: string;      // commit B (ahead)
  cloneHeadBefore: string; // commit A
}

function writeShim(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
}

function makeBase(label: string): BaseFixture {
  const root = mkdtempSync(join(tmpdir(), `gbrain-bunlink-${label}-`));
  cleanupDirs.push(root);
  const home = join(root, 'home');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  const argvLog = join(root, 'argv.log');
  writeFileSync(argvLog, '');

  const shimDir = join(root, 'bin');
  mkdirSync(shimDir, { recursive: true });
  // Recorder ONLY (never runs the real bun, prints nothing). Also notes the
  // cwd repo's HEAD at call time so "git pull ran BEFORE bun install" is
  // provable without shimming git itself.
  writeShim(
    shimDir,
    'bun',
    `printf 'bun %s ::head=%s\\n' "$*" "$(git rev-parse HEAD 2>/dev/null || echo none)" >> "${argvLog}"\nexit 0\n`,
  );
  // Recorder; answers --version so verifyUpgrade resolves a new version.
  writeShim(
    shimDir,
    'gbrain',
    `printf 'gbrain %s\\n' "$*" >> "${argvLog}"\nif [ "\${1:-}" = "--version" ]; then echo 'gbrain ${SHIM_NEW_VERSION}'; fi\nexit 0\n`,
  );
  // Containment no-ops: nothing in these arcs should reach machine-global
  // schedulers; if a future regression does, it lands here, not in crontab.
  for (const name of ['crontab', 'systemctl']) {
    writeShim(shimDir, name, `printf '${name} %s\\n' "$*" >> "${argvLog}"\nexit 0\n`);
  }
  return { root, home, shimDir, argvLog };
}

/** Local seed repo → bare origin (path contains the marker) → clone one commit behind. */
function buildFixture(label: string): Fixture {
  const base = makeBase(label);

  const seed = join(base.root, 'seed');
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, 'notes.txt'), 'commit one\n');
  git(['init', '-q'], seed);
  git(['add', '-A'], seed);
  git([...GIT_IDENTITY, 'commit', '-q', '-m', 'c1'], seed);

  // The bare origin lives at a path whose text contains `garrytan/gbrain`,
  // so the clone's .git/config remote URL carries the detection marker.
  const origin = join(base.root, 'remotes', 'garrytan', 'gbrain');
  mkdirSync(join(base.root, 'remotes', 'garrytan'), { recursive: true });
  git(['clone', '-q', '--bare', seed, origin]);

  const clone = join(base.root, 'clone');
  git(['clone', '-q', origin, clone]);

  // Advance the origin one commit past the clone via a second working copy.
  const ahead = join(base.root, 'ahead');
  git(['clone', '-q', origin, ahead]);
  writeFileSync(join(ahead, 'feature.txt'), 'commit two\n');
  git(['add', '-A'], ahead);
  git([...GIT_IDENTITY, 'commit', '-q', '-m', 'c2'], ahead);
  git(['push', '-q', 'origin', 'HEAD'], ahead);

  const originHead = git(['rev-parse', 'HEAD'], origin).trim();
  const cloneHeadBefore = git(['rev-parse', 'HEAD'], clone).trim();
  expect(originHead).not.toBe(cloneHeadBefore);

  // Detection-marker reality check: no receipt file — the marker is the
  // remote URL text inside the clone's .git/config.
  const cloneGitConfig = readFileSync(join(clone, '.git', 'config'), 'utf-8');
  expect(cloneGitConfig.toLowerCase()).toContain('garrytan/gbrain');

  // UNTRACKED driver at the bun-link entry-point path. Mirrors a real
  // bun-link install: argv[1] lives inside the checkout, so detectBunLink
  // resolves THIS clone with no argv patching. The tripwire exits 3 before
  // any git/bun child if detection ever names a root outside this clone.
  const driver = join(clone, 'src', 'cli.ts');
  mkdirSync(join(clone, 'src'), { recursive: true });
  writeFileSync(
    driver,
    [
      "import { dirname } from 'node:path';",
      'const expectedRoot = dirname(import.meta.dir);',
      'const origLog = console.log;',
      'console.log = (...a) => {',
      "  const s = a.map(String).join(' ');",
      "  if (s.startsWith('Upgrading bun-link source clone at ') && !s.includes(expectedRoot)) {",
      "    origLog('TRIPWIRE_MISMATCH ' + s);",
      '    process.exit(3);',
      '  }',
      '  origLog(...a);',
      '};',
      `const { runUpgrade } = await import(${JSON.stringify(REAL_UPGRADE_TS)});`,
      'await runUpgrade(process.argv.slice(2));',
      "console.log('DRIVER_EXIT_OK');",
      '',
    ].join('\n'),
  );

  return { ...base, origin, clone, driver, originHead, cloneHeadBefore };
}

function argvLines(fx: BaseFixture): string[] {
  return readFileSync(fx.argvLog, 'utf-8').split('\n').filter(Boolean);
}

interface SpawnResult { code: number; out: string; err: string }

/** Spawn a bun child with the shim dir FIRST on its STARTUP PATH. */
async function spawnWithShims(
  fx: BaseFixture,
  argv: string[],
  extraEnv: Record<string, string> = {},
): Promise<SpawnResult> {
  const env: Record<string, string> = {
    PATH: `${fx.shimDir}:${process.env.PATH ?? ''}`,
    HOME: fx.home,
    GBRAIN_HOME: fx.home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    ...extraEnv,
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;

  // process.execPath = the REAL bun binary (absolute), so the child itself
  // never resolves through the shim dir.
  const proc = Bun.spawn([process.execPath, ...argv], {
    cwd: fx.home,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Hard kill under the per-test budget so a wedged child can't outlive the test.
  const hardKill = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 140_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  } finally {
    clearTimeout(hardKill);
  }
}

function assertExit0(label: string, r: SpawnResult): void {
  if (r.code !== 0) {
    throw new Error(
      `${label} exited ${r.code}\n--- stdout tail ---\n${r.out.slice(-1500)}\n--- stderr tail ---\n${r.err.slice(-1500)}`,
    );
  }
}

// ── argv[1] restore (test 1 patches it in-process) ───────────────────────────

const ORIG_ARGV1 = process.argv[1];
afterEach(() => { process.argv[1] = ORIG_ARGV1; });
afterAll(() => {
  process.argv[1] = ORIG_ARGV1;
  for (const d of cleanupDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── 1. detection (in-process: the bun-link path spawns nothing) ─────────────

describe('detectInstallMethod — bun-link marker', () => {
  test("a .git/config within the argv[1] walk containing 'garrytan/gbrain' → 'bun-link'", () => {
    const fx = buildFixture('detect');
    try {
      process.argv[1] = fx.driver;
      expect(detectInstallMethod()).toBe('bun-link');
    } finally {
      process.argv[1] = ORIG_ARGV1;
    }
  }, 60_000);

  test('a source checkout of some OTHER repo is NOT bun-link', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-bunlink-ctrl-'));
    cleanupDirs.push(root);
    const ctrl = join(root, 'other');
    mkdirSync(join(ctrl, 'src'), { recursive: true });
    writeFileSync(join(ctrl, 'src', 'cli.ts'), '// stub\n');
    git(['init', '-q'], ctrl);
    git(['remote', 'add', 'origin', 'https://github.com/example-org/other-tool.git'], ctrl);
    try {
      process.argv[1] = join(ctrl, 'src', 'cli.ts');
      // The walk stops at the FIRST .git/config it finds; a foreign remote
      // must fall through to the non-bun-link detection chain.
      expect(detectInstallMethod()).not.toBe('bun-link');
    } finally {
      process.argv[1] = ORIG_ARGV1;
    }
  }, 60_000);
});

// ── 2 + 4. the upgrade arc (spawned fixture-entry driver; see header) ────────

describe('runUpgrade — bun-link arc (real git vs local bare origin; bun/gbrain shimmed)', () => {
  test('full arc: pull --ff-only THEN bun install; state + breadcrumb written; post-upgrade chained', async () => {
    const fx = buildFixture('full');
    // Pre-seed the update-check cache + snooze so the clear-on-upgrade step is observable.
    writeFileSync(join(fx.home, '.gbrain', 'last-update-check'), 'stale\n');
    writeFileSync(join(fx.home, '.gbrain', 'update-snoozed'), 'stale\n');

    const run = await spawnWithShims(fx, [fx.driver]);
    assertExit0('upgrade driver (full arc)', run);
    expect(run.out).toContain('Detected install method: bun-link');
    expect(run.out).toContain(`Upgrading bun-link source clone at ${fx.clone}...`);
    expect(run.out).toContain('DRIVER_EXIT_OK');
    expect(run.out).not.toContain('TRIPWIRE_MISMATCH');
    expect(run.err).not.toContain('Auto-upgrade failed');

    // The clone fast-forwarded to the origin's head — a REAL offline git pull.
    expect(git(['rev-parse', 'HEAD'], fx.clone).trim()).toBe(fx.originHead);

    // Recorder sequence: the bun shim saw the POST-pull HEAD (pull ran first),
    // then verify → post-upgrade → features, in order, and nothing else.
    expect(argvLines(fx)).toEqual([
      `bun install ::head=${fx.originHead}`,
      'gbrain --version',
      'gbrain post-upgrade',
      'gbrain features',
    ]);

    // saveUpgradeState checkpoint: $HOME/.gbrain/upgrade-state.json.
    const state = JSON.parse(readFileSync(join(fx.home, '.gbrain', 'upgrade-state.json'), 'utf-8'));
    expect(state.last_upgrade.from).toBe(VERSION);
    expect(state.last_upgrade.to).toBe(SHIM_NEW_VERSION);

    // Self-upgrade breadcrumb written; update cache + snooze cleared.
    expect(readFileSync(join(fx.home, '.gbrain', 'just-upgraded-from'), 'utf-8').trim()).toBe(VERSION);
    expect(existsSync(join(fx.home, '.gbrain', 'last-update-check'))).toBe(false);
    expect(existsSync(join(fx.home, '.gbrain', 'update-snoozed'))).toBe(false);
  }, 120_000);

  test('--swap-only: swap + verify + breadcrumb, but NO post-upgrade and NO features child', async () => {
    const fx = buildFixture('swap');
    const run = await spawnWithShims(fx, [fx.driver, '--swap-only']);
    assertExit0('upgrade driver (--swap-only)', run);
    expect(run.out).toContain('DRIVER_EXIT_OK');

    // Swap still happened...
    expect(git(['rev-parse', 'HEAD'], fx.clone).trim()).toBe(fx.originHead);
    // ...but the child chain stops after the version verify.
    expect(argvLines(fx)).toEqual([
      `bun install ::head=${fx.originHead}`,
      'gbrain --version',
    ]);

    // State + breadcrumb still written (the next launch runs post-upgrade).
    const state = JSON.parse(readFileSync(join(fx.home, '.gbrain', 'upgrade-state.json'), 'utf-8'));
    expect(state.last_upgrade.from).toBe(VERSION);
    expect(state.last_upgrade.to).toBe(SHIM_NEW_VERSION);
    expect(readFileSync(join(fx.home, '.gbrain', 'just-upgraded-from'), 'utf-8').trim()).toBe(VERSION);
  }, 120_000);
});

// ── 3. runPostUpgrade checkpoint (spawned — runApplyMigrations owns exit(0)) ──

describe('runPostUpgrade — migration-ledger checkpoint (spawned)', () => {
  test('advances .gbrain/migrations/completed.jsonl for the pending migration, then no-ops on re-run', async () => {
    const fx = makeBase('post');
    const dotG = join(fx.home, '.gbrain');
    writeFileSync(
      join(dotG, 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: join(dotG, 'db') }, null, 2) + '\n',
      { mode: 0o600 },
    );

    // Seed the checkpoint ledger complete for every registered migration
    // EXCEPT v0.46.3 — the detect-and-notify-only orchestrator (no autopilot
    // install, no host rewrites, no token spend): the cheapest real advance.
    // If v0.46.3 is ever retired from the registry, re-point this at another
    // known-cheap orchestrator.
    expect(migrations.some((m) => m.version === '0.46.3')).toBe(true);
    mkdirSync(join(dotG, 'migrations'), { recursive: true });
    const seeded = migrations
      .filter((m) => m.version !== '0.46.3')
      .map((m) => JSON.stringify({ ts: new Date().toISOString(), version: m.version, status: 'complete' }))
      .join('\n') + '\n';
    const ledgerPath = join(dotG, 'migrations', 'completed.jsonl');
    writeFileSync(ledgerPath, seeded);

    // Prior-binary pointer so the feature-pitch pass has a from-version.
    writeFileSync(
      join(dotG, 'upgrade-state.json'),
      JSON.stringify({ last_upgrade: { from: '0.45.0', to: VERSION, ts: new Date().toISOString() } }) + '\n',
    );

    const postUpgradeEnv: Record<string, string> = { GBRAIN_SKIP_REFERENCE_SWEEP: '1' };
    // Snapshot fast-path (when the runner exports it) — pure accelerant.
    if (process.env.GBRAIN_PGLITE_SNAPSHOT) postUpgradeEnv.GBRAIN_PGLITE_SNAPSHOT = process.env.GBRAIN_PGLITE_SNAPSHOT;

    const run1 = await spawnWithShims(fx, [CLI_PATH, 'post-upgrade'], postUpgradeEnv);
    assertExit0('post-upgrade run 1', run1);
    // Pitch pass fired for the one migration newer than the prior binary...
    expect(run1.out).toContain('NEW:');
    // ...and the runner applied it and reported completion.
    expect(run1.out).toContain('Migration v0.46.3 complete.');

    // THE checkpoint: the ledger gained exactly one terminal entry for 0.46.3.
    const entries = readFileSync(ledgerPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { version: string; status: string });
    const advanced = entries.filter((e) => e.version === '0.46.3');
    expect(advanced).toHaveLength(1);
    expect(advanced[0].status).toBe('complete');

    // applySelfUpgradeSetup's one-shot also checkpointed into config.json.
    const cfg = JSON.parse(readFileSync(join(dotG, 'config.json'), 'utf-8'));
    expect(cfg.self_upgrade?.mode).toBe('notify');
    expect(cfg.self_upgrade?.mode_prompted).toBe(true);

    // Idempotent re-run: checkpoint already advanced → nothing pending, no new
    // ledger lines (appendCompletedMigration's complete-wins guard + the
    // runner's "All migrations up to date" fast exit).
    const run2 = await spawnWithShims(fx, [CLI_PATH, 'post-upgrade'], postUpgradeEnv);
    assertExit0('post-upgrade run 2', run2);
    expect(run2.out).toContain('All migrations up to date.');
    const after = readFileSync(ledgerPath, 'utf-8').split('\n').filter(Boolean);
    expect(after).toHaveLength(entries.length);

    // Containment: nothing in the arc reached the machine-global schedulers.
    const recorded = argvLines(fx);
    expect(recorded.filter((l) => l.startsWith('crontab') || l.startsWith('systemctl'))).toEqual([]);
  }, 170_000);
});
