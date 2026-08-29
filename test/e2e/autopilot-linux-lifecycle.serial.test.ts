/**
 * G5 (missing-test-coverage plan) — Linux autopilot install/uninstall
 * lifecycle, end-to-end. CI runs ubuntu, so this file is the platform's only
 * BEHAVIORAL pin on the linux-cron and linux-systemd install arms of
 * `src/commands/autopilot.ts` (`installCrontab`, `installSystemd`,
 * `uninstallDaemon`, `runAutopilotStatus`).
 *
 * Hermetic by construction:
 *   - `crontab` and `systemctl` are PATH shims inside a tempdir — the fake
 *     crontab round-trips a state file (`-l` prints it; `crontab <file>`
 *     replaces it), the fake systemctl appends its argv to a recorder file.
 *     The real machine's cron table and systemd are NEVER touched.
 *   - HOME (and XDG_CONFIG_HOME) point at a temp root; GBRAIN_HOME is
 *     deleted so gbrainHomePath() and the raw-$HOME paths autopilot.ts uses
 *     (systemdUnitPath, installCrontab's log path) resolve into the SAME
 *     temp tree.
 *   - No DATABASE_URL / provider keys: `gbrain init --pglite` seeds the
 *     brain `--install` needs (cli.ts connects an engine before dispatching
 *     `autopilot --install`; `--status`/`--uninstall` are engine-free).
 *
 * Install mechanism: SPAWNED `bun run src/cli.ts autopilot ...`, not
 * in-process. Two reasons, both load-bearing:
 *   1. Bun's execSync snapshots process.env at Bun's OWN startup (#2747), so
 *      an in-process PATH mutation would be invisible to autopilot.ts's
 *      `execSync('crontab ...')` calls — which would then hit the REAL
 *      crontab. Spawning with the shimmed PATH in the child's startup env is
 *      the only safe wiring.
 *   2. Several arms process.exit (installDaemon on bad target, status via
 *      the cli-force-exit verdict seam) — the exit code IS part of the
 *      contract under test.
 *
 * Real argv sequences pinned here (read from the code, asserted end-to-end):
 *   install linux-cron:    crontab -l   → crontab <home>/.gbrain/crontab.tmp
 *   reinstall linux-cron:  crontab -l   (no table write — idempotent)
 *   install linux-systemd: systemctl --user daemon-reload
 *                          → systemctl --user enable --now gbrain-autopilot.service
 *                          → systemctl --user try-restart gbrain-autopilot.service
 *   uninstall:             systemctl --user disable --now gbrain-autopilot.service
 *                          → systemctl --user daemon-reload
 *                          → crontab -l → crontab <home>/.gbrain/crontab.tmp
 *
 * The autopilot cron line carries no comment marker: it is identified by the
 * wrapper filename `autopilot-run.sh` (uninstall filters lines containing
 * 'gbrain autopilot' OR 'autopilot-run.sh'; crontabIndicatesAutopilotInstall
 * matches the same). That identification-by-substring is exactly why the
 * destructive-filter assertion (foreign lines survive byte-identical) matters.
 *
 * .serial: each test spawns a real bun subprocess; the install spawns
 * cold-start PGLite WASM. Tests share one temp HOME and MUST run in
 * declaration order (bun runs tests within a file sequentially).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

let tmpRoot: string;
let home: string;
let repoDir: string;
let shimDir: string;
let cronState: string; // the fake crontab "table"
let cronArgvLog: string; // one line per fake-crontab invocation ("$*")
let sysctlLog: string; // one line per fake-systemctl invocation ("$*")
let runEnv: NodeJS.ProcessEnv;

// Foreign crontab content seeded BEFORE any install. Deliberately awkward
// bytes (quotes, double spaces, trailing comment) so "survives byte-identical"
// is a real assertion, not a trivial one.
const FOREIGN =
  'MAILTO="ops@example.com"\n' +
  "*/10 * * * *  /usr/local/bin/backup.sh --label 'nightly  backup' # keep me\n";

function writeShim(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function runCli(
  args: string[],
  timeoutMs = 120_000,
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['run', CLI, ...args], {
    cwd: REPO_ROOT,
    env: runEnv,
    encoding: 'utf-8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function readCronState(): string {
  return readFileSync(cronState, 'utf-8');
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter((l) => l.length > 0);
}

/** stdout of `--status --json` is the JSON report line; parse the last {...} line. */
function parseStatusJson(stdout: string): Record<string, unknown> {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop();
  if (!line) throw new Error(`no JSON line in status stdout:\n${stdout}`);
  return JSON.parse(line) as Record<string, unknown>;
}

const wrapperPath = () => join(home, '.gbrain', 'autopilot-run.sh');
const unitPath = () => join(home, '.config', 'systemd', 'user', 'gbrain-autopilot.service');
const autopilotCronLine = () =>
  `*/5 * * * * '${wrapperPath()}' >> '${home}/.gbrain/autopilot.log' 2>&1`;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-linux-'));
  home = join(tmpRoot, 'home');
  repoDir = join(tmpRoot, 'brain-repo');
  shimDir = join(tmpRoot, 'shims');
  cronState = join(tmpRoot, 'cron-state.txt');
  cronArgvLog = join(tmpRoot, 'cron-argv.log');
  sysctlLog = join(tmpRoot, 'systemctl-argv.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(shimDir, { recursive: true });

  // Fake crontab: round-trips cronState. NEVER the machine's real cron.
  writeShim(
    join(shimDir, 'crontab'),
    `#!/bin/sh
# PATH-shim crontab for gbrain e2e — round-trips a state file.
printf '%s\\n' "$*" >> '${cronArgvLog}'
if [ "$1" = "-l" ]; then
  if [ -f '${cronState}' ]; then cat '${cronState}'; exit 0; else exit 1; fi
fi
if [ "$1" = "-r" ]; then rm -f '${cronState}'; exit 0; fi
cat "$1" > '${cronState}'
exit 0
`,
  );

  // Fake systemctl: records argv, always succeeds. NEVER the real systemd.
  writeShim(
    join(shimDir, 'systemctl'),
    `#!/bin/sh
# PATH-shim systemctl for gbrain e2e — argv recorder only.
printf '%s\\n' "$*" >> '${sysctlLog}'
exit 0
`,
  );

  // Fake gbrain: writeWrapperScript resolves the CLI via `which gbrain` and
  // bakes the resolved path into the wrapper; it is never EXECUTED by these
  // tests, it just has to resolve deterministically.
  writeShim(join(shimDir, 'gbrain'), '#!/bin/sh\nexit 0\n');

  runEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    PATH: `${shimDir}:${process.env.PATH ?? ''}`,
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
  };
  // HOME (not GBRAIN_HOME) must drive path resolution: autopilot.ts mixes
  // gbrainHomePath() with raw process.env.HOME joins, and the two only agree
  // when GBRAIN_HOME is unset.
  delete runEnv.GBRAIN_HOME;
  // Hermetic: no shared Postgres, no provider keys (init's multi-provider
  // ambiguity check refuses when several are ambient).
  delete runEnv.DATABASE_URL;
  delete runEnv.GBRAIN_DATABASE_URL;
  delete runEnv.GBRAIN_PGBOUNCER_URL;
  delete runEnv.GBRAIN_PGBOUNCER_DIRECT_URL;
  delete runEnv.VOYAGE_API_KEY;
  delete runEnv.ZEROENTROPY_API_KEY;
  delete runEnv.OPENAI_API_KEY;
  delete runEnv.ANTHROPIC_API_KEY;
  delete runEnv.GOOGLE_API_KEY;
  delete runEnv.OPENCLAW_HOME;

  // Sanity: the shims MUST shadow any real binaries before a single gbrain
  // command runs — fail loud here rather than touching the real machine.
  for (const bin of ['crontab', 'systemctl']) {
    const which = spawnSync('sh', ['-c', `command -v ${bin}`], {
      env: runEnv,
      encoding: 'utf-8',
    });
    if (which.stdout.trim() !== join(shimDir, bin)) {
      throw new Error(`PATH shim not first for ${bin}: resolved ${which.stdout.trim()}`);
    }
  }

  // PRE-SEED two foreign cron lines before any install.
  writeFileSync(cronState, FOREIGN);

  // `autopilot --install` dispatches AFTER connectEngine in cli.ts, so the
  // temp home needs a real (PGLite) brain. --status/--uninstall stay
  // engine-free by contract.
  const init = spawnSync(
    process.execPath,
    ['run', CLI, 'init', '--pglite', '--no-embedding', '--non-interactive'],
    { cwd: REPO_ROOT, env: runEnv, encoding: 'utf-8', timeout: 120_000 },
  );
  if (init.status !== 0) {
    throw new Error(
      `gbrain init failed (code=${init.status}):\nSTDOUT:\n${init.stdout}\nSTDERR:\n${init.stderr}`,
    );
  }
}, 150_000);

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('autopilot linux lifecycle (PATH-shimmed crontab/systemctl)', () => {
  // Snapshot of the table after the first install; the reinstall test asserts
  // byte-identity against it.
  let stateAfterInstall = '';

  test('PGLite refusal: install without --force exits 1 recommending `gbrain serve` (single-writer lock)', () => {
    // Master's db-availability wave: a daemonized autopilot on a PGLite
    // brain would hold the exclusive DB lock 24/7, so install refuses
    // without --force. Pin the refusal (exit 1, serve recommendation, no
    // crontab write) — the lifecycle tests below all pass --force.
    const r = runCli(['autopilot', '--install', '--target', 'linux-cron', '--repo', repoDir]);
    expect(r.status).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain('PGLite');
    expect(out).toContain('--force');
    expect(readCronState()).toBe(FOREIGN);
  });

  test('install --target linux-cron adds ONE autopilot line; foreign lines survive byte-identical', () => {
    const r = runCli(['autopilot', '--install', '--force', '--target', 'linux-cron', '--repo', repoDir]);
    expect(r.status, `install failed:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('Installed crontab entry for gbrain autopilot (every 5 minutes)');

    // Exact table: foreign block byte-identical, autopilot line appended.
    // The line's "marker" is the wrapper filename autopilot-run.sh — that
    // substring is what status detection and the uninstall filter key on.
    stateAfterInstall = readCronState();
    expect(stateAfterInstall).toBe(FOREIGN + autopilotCronLine() + '\n');

    // Real argv sequence: read-modify-write through a temp file.
    const calls = readLines(cronArgvLog);
    expect(calls[calls.length - 2]).toBe('-l');
    expect(calls[calls.length - 1]).toBe(join(home, '.gbrain', 'crontab.tmp'));
    // The temp file is cleaned up after `crontab <file>` succeeds.
    expect(existsSync(join(home, '.gbrain', 'crontab.tmp'))).toBe(false);

    // Wrapper written where the cron line points, owner-executable, not
    // group/world-writable; env template exists with no group/other bits.
    const wMode = statSync(wrapperPath()).mode & 0o777;
    expect(wMode & 0o700).toBe(0o700);
    expect(wMode & 0o022).toBe(0);
    const wrapper = readFileSync(wrapperPath(), 'utf-8');
    expect(wrapper).toContain(`exec '${join(shimDir, 'gbrain')}' autopilot --repo '${repoDir}'`);
    expect((statSync(join(home, '.gbrain', 'env')).mode & 0o077)).toBe(0);
  }, 120_000);

  test('reinstall is idempotent: exactly one autopilot line, no table rewrite, foreign intact', () => {
    const callsBefore = readLines(cronArgvLog).length;
    const r = runCli(['autopilot', '--install', '--force', '--target', 'linux-cron', '--repo', repoDir]);
    expect(r.status, `reinstall failed:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('Crontab entry already exists');

    // Table byte-identical to the first install — still exactly one
    // autopilot line, foreign block untouched.
    const state = readCronState();
    expect(state).toBe(stateAfterInstall);
    const autopilotLines = state.split('\n').filter((l) => l.includes('autopilot-run.sh'));
    expect(autopilotLines).toEqual([autopilotCronLine()]);

    // Idempotency at the argv level: the reinstall only READ the table
    // (`crontab -l`) — it never wrote a replacement.
    const appended = readLines(cronArgvLog).slice(callsBefore);
    expect(appended).toEqual(['-l']);
  }, 120_000);

  test('status reports installed (linux-cron, never_run) with exit 1', () => {
    const r = runCli(['autopilot', '--status', '--json'], 60_000);
    const report = parseStatusJson(r.stdout);
    expect(report.installed).toBe(true);
    expect(report.install_target).toBe('linux-cron');
    // The daemon has never ticked in this hermetic home, so the honest state
    // is never_run — and the documented exit-code contract for
    // installed-but-not-syncing is 1 (autopilotStatusExitCode).
    expect(report.state).toBe('never_run');
    expect(r.status).toBe(1);
  }, 90_000);

  test('install --target linux-systemd writes a 0644 unit and runs daemon-reload → enable --now → try-restart', () => {
    rmSync(sysctlLog, { force: true });
    const r = runCli(['autopilot', '--install', '--force', '--target', 'linux-systemd', '--repo', repoDir]);
    expect(r.status, `systemd install failed:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('Installed systemd user service: gbrain-autopilot.service');

    // Unit file where the code writes it, 0644 exactly (writeFileSync mode +
    // unconditional chmodSync normalization — umask-independent).
    expect(existsSync(unitPath())).toBe(true);
    expect(statSync(unitPath()).mode & 0o777).toBe(0o644);
    const unit = readFileSync(unitPath(), 'utf-8');
    expect(unit).toContain('Description=GBrain Autopilot');
    expect(unit).toContain(`ExecStart=${wrapperPath()}`);
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=30');
    expect(unit).toContain('StandardOutput=append:%h/.gbrain/autopilot.log');

    // The documented command sequence, in order (try-restart is the #2608
    // reload guarantee: enable --now does not restart an already-active unit).
    expect(readLines(sysctlLog)).toEqual([
      '--user daemon-reload',
      '--user enable --now gbrain-autopilot.service',
      '--user try-restart gbrain-autopilot.service',
    ]);

    // Detection precedence: with both a unit and a crontab entry present,
    // status reports linux-systemd (detectInstalledTarget checks it first).
    const s = runCli(['autopilot', '--status', '--json'], 60_000);
    expect(parseStatusJson(s.stdout).install_target).toBe('linux-systemd');
  }, 120_000);

  test('uninstall removes ONLY autopilot artifacts: systemd disable sequence + destructive cron filter keeps foreign lines byte-identical', () => {
    rmSync(sysctlLog, { force: true });
    const callsBefore = readLines(cronArgvLog).length;
    const r = runCli(['autopilot', '--uninstall'], 60_000);
    expect(r.status, `uninstall failed:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('Removed systemd user service: gbrain-autopilot.service');
    expect(r.stdout).toContain('Removed crontab entry for gbrain autopilot');

    // systemd arm: disable --now, unlink the unit, then daemon-reload.
    expect(existsSync(unitPath())).toBe(false);
    expect(readLines(sysctlLog)).toEqual([
      '--user disable --now gbrain-autopilot.service',
      '--user daemon-reload',
    ]);

    // THE destructive-filter assertion: the rewritten table is the foreign
    // block byte-identical — awkward quoting, double spaces, trailing
    // comment and all — with the autopilot line (and nothing else) gone.
    expect(readCronState()).toBe(FOREIGN);

    // The rewrite went through the same -l → temp-file replace sequence.
    const appended = readLines(cronArgvLog).slice(callsBefore);
    expect(appended).toEqual(['-l', join(home, '.gbrain', 'crontab.tmp')]);

    // The shared wrapper is removed too.
    expect(existsSync(wrapperPath())).toBe(false);
  }, 90_000);

  test('status after uninstall: not installed, exit 0', () => {
    const r = runCli(['autopilot', '--status', '--json'], 60_000);
    const report = parseStatusJson(r.stdout);
    expect(report.installed).toBe(false);
    expect(report.install_target).toBe(null);
    expect(report.state).toBe('not_installed');
    expect(r.status).toBe(0);
  }, 90_000);
});
