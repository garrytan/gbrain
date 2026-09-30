/**
 * End-to-end: a `.env` in the CURRENT DIRECTORY must not be able to make the
 * gbrain CLI load code. Bun auto-loads cwd `.env` files (compiled binaries
 * included) and expands `${VAR}` inside them, so both the relative and the
 * `${PWD}`-expanded spellings of a code-loading variable are tried here.
 *
 * This test deliberately does NOT use the shared `cli-spawn.ts` helper under
 * test/helpers/: that helper passes `--no-env-file`, which would keep Bun from loading the hostile `.env`
 * and make every assertion below vacuous. The CLI is spawned directly with a
 * hermetic env (HOME / GBRAIN_HOME in a scratch dir) and the hostile dir as
 * cwd. The quarantine warning on stderr only appears when Bun really loaded
 * the file, so it doubles as the harness self-check.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { cwdIsOperatorConfigDir } from '../src/core/cli-preflight.ts';
import { withEnv } from './helpers/with-env.ts';

function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'src', 'cli.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no src/cli.ts above ${from}`);
    dir = parent;
  }
}
const REPO_ROOT = findRepoRoot(import.meta.dir);
const CLI_PATH = join(REPO_ROOT, 'src', 'cli.ts');
// The compiled case must RUN where a binary exists: `bun build --compile --no-compile-autoload-bunfig --outfile bin/gbrain src/cli.ts`
// (bin/ is gitignored); GBRAIN_COMPILED_BIN points at a binary built elsewhere.
const COMPILED_BIN = process.env.GBRAIN_COMPILED_BIN ?? join(REPO_ROOT, 'bin', 'gbrain');
const PREFLIGHT_MODULE = join(REPO_ROOT, 'src', 'core', 'cli-preflight.ts');

const EXPECTED_WARNING =
  '[env] Ignoring GBRAIN_GUARDRAILS_MODULE because a .env file in the current directory ' +
  'assigns it — cwd .env files are untrusted for security settings. Export it from your ' +
  'shell or set it in ~/.gbrain/.env.';

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** A cloned-repo lookalike: `.env` naming a module inside the repo whose top level drops a marker. */
function hostileRepo(envLine: (dir: string) => string): { dir: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-hostile-repo-'));
  scratch.push(dir);
  const marker = join(dir, 'PROBE_RAN');
  mkdirSync(join(dir, 'tooling'));
  writeFileSync(
    join(dir, 'tooling', 'probe.ts'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default undefined;\n`,
  );
  writeFileSync(join(dir, '.env'), envLine(dir) + '\n');
  return { dir, marker };
}

function hermeticEnv(cwd: string, extra: Record<string, string> = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-hostile-home-'));
  scratch.push(home);
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    GBRAIN_HOME: home,
    PWD: cwd, // what a shell would set; feeds Bun's ${PWD} expansion
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    ...extra,
  };
}

// Reap a hung child before bun's per-test ceiling fires. Named (not a trailing
// numeric literal) so the run-unit-shard timeout-pin lint reads it as a kill
// timer, not a hand-pinned test timeout; the test itself inherits the bunfig default.
const CHILD_KILL_AFTER_MS = 55_000;
// Fixture-body timings (interpolated into the spawned entries' source).
const KEEPALIVE_INTERVAL_MS = 1000;   // an idle setInterval that keeps a signal-test child alive
const GRACEFUL_EXIT_DELAY_MS = 400;   // a graceful-shutdown handler's delay before it exits

async function runCli(cmd: string[], cwd: string, env: Record<string, string>) {
  const proc = Bun.spawn(cmd, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

describe('cwd .env cannot drive GBRAIN_GUARDRAILS_MODULE (advisory PoC)', () => {
  const cases: Array<[string, (dir: string) => string]> = [
    ['relative spec', () => 'GBRAIN_GUARDRAILS_MODULE=./tooling/probe.ts'],
    ['${PWD}-expanded absolute spec', () => 'GBRAIN_GUARDRAILS_MODULE=${PWD}/tooling/probe.ts'],
  ];

  for (const [label, envLine] of cases) {
    // A3-3: a cwd .env assigning a non-empty GBRAIN_GUARDRAILS_MODULE now fails
    // CLOSED — the module still never runs (marker absent), but instead of
    // quarantining + re-running (the old exit 0) preflight refuses (exit 1), so
    // the process never continues without the firewall the assignment implied.
    test(`${label}: gbrain --version from the hostile dir runs no code and refuses (fail-closed)`, async () => {
      const { dir, marker } = hostileRepo(envLine);
      const r = await runCli([process.execPath, CLI_PATH, '--version'], dir, hermeticEnv(dir));
      expect(existsSync(marker)).toBe(false);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(EXPECTED_WARNING); // the quarantine warning still prints …
      expect(r.stderr).toContain("refusing to run without the operator's firewall"); // … then the refusal
      expect(r.stdout).not.toMatch(/^gbrain \d/);
    });
  }

  test('control: the same module exported from the shell (absolute path) IS loaded', async () => {
    const { dir, marker } = hostileRepo(() => 'UNRELATED=1');
    const clean = mkdtempSync(join(tmpdir(), 'gbrain-clean-cwd-'));
    scratch.push(clean);
    const env = hermeticEnv(clean, { GBRAIN_GUARDRAILS_MODULE: join(dir, 'tooling', 'probe.ts') });
    const r = await runCli([process.execPath, CLI_PATH, '--version'], clean, env);
    expect(existsSync(marker)).toBe(true); // operator-provided → loader ran the module
    expect(r.exitCode).toBe(1); // …and fail-closed on "registered no guardrail provider"
    expect(r.stderr).toContain('registered no guardrail provider');
    expect(r.stderr).not.toContain('[env] Ignoring');
  });

  // A3-3: fail-CLOSED when a cwd .env assigns GBRAIN_GUARDRAILS_MODULE. Key
  // presence, not value: Bun merges the file before gbrain starts and never
  // overrides a live variable, so an operator-exported module cannot be told
  // apart from the file's. Dropping it and re-running would leave the child
  // with NO firewall (the #3688 contract is fail-closed), so preflight refuses
  // to run at all rather than silently downgrade.
  test('fail-closed: a cwd .env assigning GBRAIN_GUARDRAILS_MODULE (operator also exported one) refuses to run — exit 1, module NOT loaded', async () => {
    const { dir, marker } = hostileRepo(() => 'GBRAIN_GUARDRAILS_MODULE=./tooling/probe.ts');
    const env = hermeticEnv(dir, { GBRAIN_GUARDRAILS_MODULE: join(dir, 'tooling', 'probe.ts') });
    const r = await runCli([process.execPath, CLI_PATH, '--version'], dir, env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("refusing to run without the operator's firewall");
    expect(existsSync(marker)).toBe(false); // the module never imported
    expect(r.stdout).not.toMatch(/^gbrain \d/);
  });

  test('control: an exported GBRAIN_GUARDRAILS_MODULE survives when the cwd .env assigns a DIFFERENT protected key — the re-run still loads it', async () => {
    const { dir, marker } = hostileRepo(() => 'GBRAIN_ALLOW_SHELL_JOBS=1'); // a different protected key
    const env = hermeticEnv(dir, { GBRAIN_GUARDRAILS_MODULE: join(dir, 'tooling', 'probe.ts') });
    const r = await runCli([process.execPath, CLI_PATH, '--version'], dir, env);
    // The other key is quarantined and the process re-runs; the exported module
    // rides the sanitized env and the loader still imports it (marker written),
    // then fail-closes on the probe registering zero providers.
    expect(existsSync(marker)).toBe(true);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('registered no guardrail provider');
    expect(r.stderr).not.toContain("refusing to run without the operator's firewall");
  });

  const compiledTest = existsSync(COMPILED_BIN) ? test : test.skip;
  compiledTest('compiled binary: same fail-closed refusal (bin/gbrain present)', async () => {
    const { dir, marker } = hostileRepo(() => 'GBRAIN_GUARDRAILS_MODULE=./tooling/probe.ts');
    const r = await runCli([COMPILED_BIN, '--version'], dir, hermeticEnv(dir));
    expect(existsSync(marker)).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(EXPECTED_WARNING);
    expect(r.stderr).toContain("refusing to run without the operator's firewall");
  });
});

// ── Preflight ORDER: quarantine → $GBRAIN_HOME/.gbrain/.env → guardrails ────
//
// Step 2 of cli-preflight.ts exists so the operator-owned ~/.gbrain/.env can
// be the home for GBRAIN_GUARDRAILS_MODULE; step 1 runs first so a cwd .env
// cannot pick WHICH home that is (GBRAIN_HOME is on the protected list).
describe('cli preflight ordering: cwd quarantine → ~/.gbrain/.env → guardrails loader', () => {
  test('the operator-owned $GBRAIN_HOME/.gbrain/.env IS honored as the home for GBRAIN_GUARDRAILS_MODULE', async () => {
    const { dir, marker } = hostileRepo(() => 'UNRELATED=1'); // probe lives here; its .env is harmless
    const clean = mkdtempSync(join(tmpdir(), 'gbrain-clean-cwd-'));
    scratch.push(clean);
    const env = hermeticEnv(clean);
    // configDir() === $GBRAIN_HOME/.gbrain — the loader reads <configDir>/.env.
    mkdirSync(join(env.GBRAIN_HOME, '.gbrain'), { recursive: true });
    writeFileSync(
      join(env.GBRAIN_HOME, '.gbrain', '.env'),
      `GBRAIN_GUARDRAILS_MODULE=${join(dir, 'tooling', 'probe.ts')}\n`,
    );
    const r = await runCli([process.execPath, CLI_PATH, '--version'], clean, env);
    expect(existsSync(marker)).toBe(true); // operator home → loader ran the module …
    expect(r.exitCode).toBe(1); // … and fail-closed on "registered no guardrail provider"
    expect(r.stderr).toContain('registered no guardrail provider');
    expect(r.stderr).not.toContain('[env] Ignoring');
  });

  test('a cwd .env cannot relocate GBRAIN_HOME to smuggle in its own .gbrain/.env: quarantined BEFORE the config dir resolves', async () => {
    const { dir, marker } = hostileRepo(() => 'GBRAIN_HOME=${PWD}/evil-home');
    // The planted "home" carries a .gbrain/.env naming the probe as guardrails module.
    mkdirSync(join(dir, 'evil-home', '.gbrain'), { recursive: true });
    writeFileSync(
      join(dir, 'evil-home', '.gbrain', '.env'),
      `GBRAIN_GUARDRAILS_MODULE=${join(dir, 'tooling', 'probe.ts')}\n`,
    );
    const env = hermeticEnv(dir);
    delete env.GBRAIN_HOME; // exported vars beat .env in Bun; the attack needs the .env value to land
    const r = await runCli([process.execPath, CLI_PATH, '--version'], dir, env);
    expect(existsSync(marker)).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^gbrain \d/);
    expect(r.stderr).toContain('[env] Ignoring GBRAIN_HOME because a .env file in the current directory assigns it');
  });
});

// ── Descendants: the sanitized re-run from a neutral cwd (A2) ────────────────
//
// Removing a key from the parent environment is invisible to children spawned
// without an explicit `env` — Bun hands them its startup environ snapshot,
// cwd-.env values included. Preflight therefore re-runs gbrain once from a
// fresh EMPTY temp dir with the sanitized environment whenever the quarantine
// dropped anything, and the re-run chdirs back in its own preflight
// (cli-preflight.ts). The entry script below stands in for any gbrain command
// that shells out from the cwd: real preflight, then `git status --porcelain`
// with NO env/cwd option — the exact spawn shape the snapshot would poison —
// plus a `sh` PRESENCE probe: `GIT_SSL_NO_VERIFY=` (empty) still disables TLS
// verification in git, so a dropped key must be ABSENT, not ''.
const GIT_BIN = Bun.which('git');
// util-linux `script` gives the wrapper a real pty so process.stdin.isTTY is
// true — the only way to exercise the tty (ignore-only) SIGINT branch faithfully.
const SCRIPT_BIN = Bun.which('script');
/**
 * The command line handed to `script -c`. `script` runs it through `$SHELL`
 * (falling back to /bin/sh — hermeticEnv sets no SHELL), and the pty delivers
 * Ctrl-C to the WHOLE foreground group, that shell included. Which /bin/sh it
 * is then decides what `script` reports, not the wrapper or the re-run:
 *   - bash waits for its foreground child and, when the child did NOT die of
 *     SIGINT, treats the signal as handled and relays the child's status (42);
 *   - dash (/bin/sh on Debian/Ubuntu, whose package also patches out upstream
 *     dash's `sh -c cmd` → exec optimisation) remembers the SIGINT while it
 *     waits, then re-raises it on itself once the child returns — `script` sees
 *     a child killed by SIGINT and exits 128+2 = 130 although wrapper and
 *     re-run both behaved (the ubuntu-latest-only failure of the two pty tests).
 * `exec` replaces the shell with the wrapper, so no intermediate shell is left
 * in the foreground group and the status `script` relays is the wrapper's under
 * either shell. Redirections stay on the exec line: the shell applies them
 * before it execs, so the all-stdio-non-tty shape below still holds.
 */
const ptyCommand = (argv: string, redirects = '') => `exec ${argv}${redirects}`;

const HOSTILE_ENV_LINES = [
  'GBRAIN_ALLOW_SHELL_JOBS=1',
  'GIT_CONFIG_COUNT=1',
  'GIT_CONFIG_KEY_0=core.fsmonitor',
  'GIT_CONFIG_VALUE_0=./tooling/evil.sh',
  'GIT_SSL_NO_VERIFY=1', // presence-checked by git: must end up unset, never ''
  'PROJECT_NAME=demo', // an ordinary project variable: must keep loading
];
const HOSTILE_WARNING_KEYS =
  'GBRAIN_ALLOW_SHELL_JOBS, GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0, GIT_SSL_NO_VERIFY';

/** The default entry body: git probe + presence probe + a one-line report, exit 7. */
const PROBE_BODY = [
  `const r = Bun.spawnSync(['git', 'status', '--porcelain']); // no env/cwd option: inherits the startup snapshot, runs in process.cwd()`,
  `const sh = Bun.spawnSync(['sh', '-c', 'echo "GIT_SSL_NO_VERIFY=[\${GIT_SSL_NO_VERIFY-unset}]"']);`,
  'process.stdout.write(`GIT_EXIT=${r.exitCode} GIT_CONFIG_COUNT=${JSON.stringify(process.env.GIT_CONFIG_COUNT ?? null)} ' +
    'PROJECT_NAME=${process.env.PROJECT_NAME ?? ""} CWD=${process.cwd()} ' +
    'MARKER=${JSON.stringify(process.env.GBRAIN_CWD_ENV_QUARANTINED ?? null)} ' +
    'ARGS=${JSON.stringify(process.argv.slice(2))} ${sh.stdout.toString().trim()}\\n`);',
  `process.exit(7);`,
].join('\n');

interface HostileGitRepo { dir: string; evilMarker: string; entry: string; ready: string }

/**
 * Hostile checkout: a git repo whose .env plants a git config injection
 * (core.fsmonitor → marker script) next to a GBRAIN_* opt-in. `envLines`
 * replaces the default .env body (a function of the dir for absolute paths);
 * `entryBody` replaces the probe that runs after preflight.
 */
function hostileGitRepo(opts: { envLines?: (dir: string) => string[]; entryBody?: string } = {}): HostileGitRepo {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-hostile-git-'));
  scratch.push(dir);
  Bun.spawnSync([GIT_BIN!, 'init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'tooling'));
  const evilMarker = join(dir, 'EVIL_RAN');
  writeFileSync(join(dir, 'tooling', 'evil.sh'), `#!/bin/sh\ntouch ${JSON.stringify(evilMarker)}\n`, { mode: 0o755 });
  writeFileSync(join(dir, '.env'), [...(opts.envLines ?? (() => HOSTILE_ENV_LINES))(dir), ''].join('\n'));
  const entry = join(dir, 'tooling', 'entry.ts');
  const ready = join(dir, 'READY');
  writeFileSync(entry, [
    `import { writeFileSync, renameSync } from 'node:fs';`,
    `import { runCliPreflight } from ${JSON.stringify(PREFLIGHT_MODULE)};`,
    `const READY = ${JSON.stringify(ready)};`,
    // Atomic READY write: a plain writeFileSync can be observed mid-write and
    // `Number('')` reads back 0 — write a .tmp then renameSync (atomic on the
    // same fs) so waitReady never sees a partial file.
    `const writeReady = (v) => { writeFileSync(READY + '.tmp', String(v)); renameSync(READY + '.tmp', READY); };`,
    `if (process.argv.includes('--preflight')) await runCliPreflight();`,
    opts.entryBody ?? PROBE_BODY,
    '',
  ].join('\n'));
  return { dir, evilMarker, entry, ready };
}

const warningLines = (stderr: string) => stderr.split('\n').filter((l) => l.startsWith('[env] Ignoring'));

/** Poll for the READY file the signal-test entries write once their handlers are installed. */
async function waitReady(path: string): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Number(readFileSync(path, 'utf8'));
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('entry never signalled readiness');
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe('a cwd .env cannot reach the programs gbrain spawns (sanitized re-run)', () => {
  test.skipIf(!GIT_BIN)('control: without preflight the planted git config runs the script and the TLS knob is live (the PoC is live here)', async () => {
    const { dir, evilMarker, entry } = hostileGitRepo();
    const r = await runCli([process.execPath, entry], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(7);
    expect(existsSync(evilMarker)).toBe(true);
    expect(r.stdout).toContain('GIT_SSL_NO_VERIFY=[1]');
  });

  test.skipIf(!GIT_BIN)('with preflight: git never sees the injection, dropped keys are ABSENT (not ""), cwd + argv restored, exit code passes through, ONE warning', async () => {
    const { dir, evilMarker, entry } = hostileGitRepo();
    const r = await runCli([process.execPath, entry, '--preflight', '--probe=./relative/thing'], dir, hermeticEnv(dir));
    expect(existsSync(evilMarker)).toBe(false);
    expect(r.exitCode).toBe(7); // the re-run's status, not the wrapper's
    expect(r.stdout).toContain('GIT_EXIT=0');
    expect(r.stdout).toContain('GIT_CONFIG_COUNT=null'); // in-process view: absent
    expect(r.stdout).toContain('GIT_SSL_NO_VERIFY=[unset]'); // presence probe: the sh child never saw the key
    expect(r.stdout).toContain('PROJECT_NAME=demo'); // unprotected keys still load from the cwd .env
    expect(r.stdout).toContain(`CWD=${realpathSync(dir)}`); // the re-run switched back to the caller's directory
    expect(r.stdout).toContain('MARKER=null'); // the internal marker is not visible to the command
    expect(r.stdout).toContain('ARGS=["--preflight","--probe=./relative/thing"]'); // relative argv preserved verbatim
    const warnings = warningLines(r.stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Ignoring ${HOSTILE_WARNING_KEYS} because a .env file in the current directory assigns it`);
  });

  // The marker that tells the re-run "you already hopped" is a plain env var,
  // so a hostile .env can plant one. It is honoured only when the process's
  // startup cwd IS the .env-free neutral dir it names — impossible from a
  // hostile checkout, whose startup cwd has a .env by construction.
  const forged: Array<[label: string, value: (dir: string) => string]> = [
    ['flag-like value', () => '1'],
    ['the real parent pid (the old ppid-shaped guard)', () => String(process.pid)],
    ['JSON naming the hostile dir as neutral', (dir) => `'${JSON.stringify({ cwd: dir, neutral: dir })}'`],
    ['JSON naming a genuine .env-free dir as neutral', (dir) => {
      const decoy = mkdtempSync(join(tmpdir(), 'gbrain-decoy-neutral-'));
      scratch.push(decoy);
      return `'${JSON.stringify({ cwd: dir, neutral: decoy })}'`;
    }],
  ];
  for (const [label, value] of forged) {
    test.skipIf(!GIT_BIN)(`forged marker (${label}) planted in the .env does not suppress the hop`, async () => {
      const { dir, evilMarker, entry } = hostileGitRepo({
        envLines: (d) => [...HOSTILE_ENV_LINES, `GBRAIN_CWD_ENV_QUARANTINED=${value(d)}`],
      });
      const r = await runCli([process.execPath, entry, '--preflight'], dir, hermeticEnv(dir));
      expect(existsSync(evilMarker)).toBe(false);
      expect(r.exitCode).toBe(7);
      expect(r.stdout).toContain('GIT_EXIT=0');
      expect(r.stdout).toContain('GIT_SSL_NO_VERIFY=[unset]');
      expect(r.stdout).toContain('MARKER=null');
      const warnings = warningLines(r.stderr);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('GBRAIN_CWD_ENV_QUARANTINED'); // planted copy: dropped and named like any protected key
    });
  }

  test.skipIf(!GIT_BIN)('harness self-check: a planted JSON marker really lands in process.env (no preflight)', async () => {
    const { dir, entry } = hostileGitRepo({
      envLines: (d) => [...HOSTILE_ENV_LINES, `GBRAIN_CWD_ENV_QUARANTINED='${JSON.stringify({ cwd: d, neutral: d })}'`],
    });
    const r = await runCli([process.execPath, entry], dir, hermeticEnv(dir));
    expect(r.stdout).toContain(`MARKER=${JSON.stringify(JSON.stringify({ cwd: dir, neutral: dir }))}`);
  });

  test.skipIf(!GIT_BIN)('depth 2: a hopped process that spawns gbrain again from the hostile cwd hops once more and stops — exit code and exactly two warnings', async () => {
    const { dir, evilMarker, entry } = hostileGitRepo({
      entryBody: [
        `if (process.argv.includes('--level1')) { Bun.spawnSync(['git', 'status', '--porcelain']); process.exit(5); }`,
        // level 0: the shape of every gbrain self-spawn — explicit env (the quarantined view), the hostile cwd.
        `const r = Bun.spawnSync([process.execPath, process.argv[1], '--preflight', '--level1'], { env: process.env, cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit'] });`,
        `process.exit(r.exitCode ?? 1);`,
      ].join('\n'),
    });
    const r = await runCli([process.execPath, entry, '--preflight'], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(5);
    expect(existsSync(evilMarker)).toBe(false);
    expect(warningLines(r.stderr)).toHaveLength(2); // one per subtree that started in the hostile cwd; no runaway
  });

  test.skipIf(!GIT_BIN)('SIGTERM sent to the wrapper is forwarded: the re-run exits 99 by its own handler, the wrapper relays 99, the re-run is gone', async () => {
    const { dir, entry, ready } = hostileGitRepo({
      entryBody: [
        `process.on('SIGTERM', () => process.exit(99));`,
        `writeReady(process.pid);`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    });
    const proc = Bun.spawn([process.execPath, entry, '--preflight'], { cwd: dir, env: hermeticEnv(dir), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
    try {
      const childPid = await waitReady(ready);
      expect(childPid).not.toBe(proc.pid); // the entry ran in the re-run, not in the wrapper
      proc.kill('SIGTERM');
      const code = await proc.exited;
      expect(code).toBe(99);
      expect(await gone(childPid)).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  test.skipIf(!GIT_BIN)('the re-run killed by SIGKILL → the wrapper exits 137 (128+signal)', async () => {
    const { dir, entry } = hostileGitRepo({ entryBody: `process.kill(process.pid, 'SIGKILL');\nsetInterval(() => {}, 1000);` });
    const r = await runCli([process.execPath, entry, '--preflight'], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(137);
  });

  // A3-5(b): with a real terminal attached the wrapper's stdin IS a tty, so it
  // takes the ignore-only SIGINT branch. `script` runs the wrapper under a pty;
  // writing \x03 to script's stdin is the terminal Ctrl-C, delivered by the pty
  // to the whole foreground process group (wrapper + re-run) exactly like a real
  // terminal. The tty wrapper does NOT forward, so the re-run receives SIGINT
  // exactly once and its once() graceful handler completes (exit 42) — a second,
  // forwarded delivery would have killed it after once() removed its listener.
  test.skipIf(!GIT_BIN || !SCRIPT_BIN)('Ctrl-C from a real terminal (pty) reaches the re-run exactly once: the tty wrapper ignores SIGINT and the once() graceful handler completes (exit 42)', async () => {
    const { dir, entry, ready } = hostileGitRepo({
      entryBody: [
        // serve-http's shape: once('SIGINT') + a graceful-shutdown delay before exit.
        `process.once('SIGINT', () => { setTimeout(() => process.exit(42), ${GRACEFUL_EXIT_DELAY_MS}); });`,
        `writeReady(process.pid);`,
        `setInterval(() => {}, ${KEEPALIVE_INTERVAL_MS});`,
      ].join('\n'),
    });
    const cmd = ptyCommand(`${process.execPath} ${entry} --preflight`); // exec'd: see ptyCommand
    const proc = Bun.spawn([SCRIPT_BIN!, '-qec', cmd, '/dev/null'], {
      cwd: dir, env: hermeticEnv(dir), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const drain = (async () => { for await (const _ of proc.stdout) { /* mux pty output */ } })();
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
    try {
      await waitReady(ready);
      proc.stdin!.write('\x03'); // terminal Ctrl-C → pty → the foreground group
      proc.stdin!.flush();
      const code = await proc.exited;
      await drain;
      expect(proc.signalCode).toBeNull();
      expect(code).toBe(42);
    } finally {
      clearTimeout(timer);
    }
  });

  // A3-5(b) + E4-6: the mirror case. With NO controlling terminal there is no
  // process-group delivery, so a SIGINT that reaches the wrapper pid alone (a
  // supervisor, cron, a detached agent harness) would orphan the re-run under
  // ignore-only. Such a wrapper forwards it once; the re-run's handler runs
  // (exit 97). `detached: true` starts the wrapper in its own session, which is
  // what actually detaches it from the terminal `bun test` may be running in —
  // piped stdio alone does not (E4-6 below).
  test.skipIf(!GIT_BIN)('SIGINT to a wrapper with NO controlling terminal (own session) is forwarded once: the re-run receives it and exits 97', async () => {
    const { dir, entry, ready } = hostileGitRepo({
      entryBody: [
        `process.on('SIGINT', () => process.exit(97));`,
        `writeReady(process.pid);`,
        `setInterval(() => {}, ${KEEPALIVE_INTERVAL_MS});`,
      ].join('\n'),
    });
    const proc = nodeSpawn(process.execPath, [entry, '--preflight'], { cwd: dir, env: hermeticEnv(dir), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout!.resume(); proc.stderr!.resume(); // drain
    const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
    try {
      const childPid = await waitReady(ready);
      expect(childPid).not.toBe(proc.pid); // the handler ran in the re-run
      proc.kill('SIGINT'); // wrapper pid only — no controlling terminal ⇒ nothing else delivers it
      expect(await exited).toBe(97);
      expect(await gone(childPid)).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  // E4-6 (review cycle 4): `process.stdin.isTTY` was the proxy for "a terminal
  // delivers Ctrl-C to the whole group". `gbrain serve --http </dev/null` in a
  // foreground terminal has a non-tty stdin AND a controlling terminal, so
  // Ctrl-C reached wrapper and child and the wrapper forwarded a SECOND SIGINT,
  // aborting the child's once('SIGINT') graceful handler (exit 130). The wrapper
  // now probes for a controlling terminal (open("/dev/tty")) and forwards only
  // when there is none. `script` provides the pty; the shell inside it redirects
  // ALL THREE stdio to non-tty files — the `</dev/null >log 2>&1` shape.
  test.skipIf(!GIT_BIN || !SCRIPT_BIN)('Ctrl-C with a controlling terminal but all three stdio non-tty: the wrapper does NOT forward; the once() graceful handler completes (exit 42)', async () => {
    const { dir, entry, ready } = hostileGitRepo({
      entryBody: [
        `process.once('SIGINT', () => { setTimeout(() => process.exit(42), ${GRACEFUL_EXIT_DELAY_MS}); });`,
        `writeReady(process.pid);`,
        `setInterval(() => {}, ${KEEPALIVE_INTERVAL_MS});`,
      ].join('\n'),
    });
    const out = join(dir, 'wrapper.out');
    const err = join(dir, 'wrapper.err');
    const cmd = ptyCommand(`${process.execPath} ${entry} --preflight`, ` </dev/null >${out} 2>${err}`); // exec'd: see ptyCommand
    const proc = Bun.spawn([SCRIPT_BIN!, '-qec', cmd, '/dev/null'], {
      cwd: dir, env: hermeticEnv(dir), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const drain = (async () => { for await (const _ of proc.stdout) { /* mux pty output */ } })();
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
    try {
      await waitReady(ready);
      proc.stdin!.write('\x03'); // terminal Ctrl-C → pty → the foreground group (wrapper AND re-run)
      proc.stdin!.flush();
      const code = await proc.exited;
      await drain;
      expect(code).toBe(42);
      expect(readFileSync(err, 'utf8')).toContain('[env] Ignoring'); // the wrapper's stderr really was the file, not the pty
    } finally {
      clearTimeout(timer);
    }
  });

  // A3-6(iii): SIGHUP is always forwarded (a supervisor sends it to the wrapper
  // pid alone). The re-run exits 98 by its own handler; the wrapper relays it.
  test.skipIf(!GIT_BIN)('SIGHUP sent to the wrapper is forwarded: the re-run exits 98 by its own handler, the wrapper relays it', async () => {
    const { dir, entry, ready } = hostileGitRepo({
      entryBody: [
        `process.on('SIGHUP', () => process.exit(98));`,
        `writeReady(process.pid);`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    });
    const proc = Bun.spawn([process.execPath, entry, '--preflight'], { cwd: dir, env: hermeticEnv(dir), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
    try {
      const childPid = await waitReady(ready);
      proc.kill('SIGHUP');
      const code = await proc.exited;
      expect(code).toBe(98);
      expect(await gone(childPid)).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  // E4-3 (review cycle 4): cli.ts installs its own SIGTERM/SIGHUP handlers
  // (process-cleanup.ts: cleanup pass → exit 143/129) in its import.meta.main
  // block, BEFORE main() reaches preflight. In the wrapper a SIGTERM therefore
  // ran BOTH that handler and the forwarder, and the wrapper exited 143 before
  // the re-run finished and before the neutral dir was removed. The wrapper has
  // no duties of its own, so reexecSanitized removes every pre-existing listener
  // for the forwarded signals: its exit is ALWAYS the child's. This pin goes
  // through the REAL cli.ts (not the preflight-only entry) so cli.ts's handlers
  // are actually installed in the wrapper. The child's graceful shutdown is
  // modelled by an operator-EXPORTED guardrails module: it replaces the child's
  // own prompt SIGTERM exit with a delayed exit(0) and writes a marker first.
  /**
   * An operator-EXPORTED guardrails module that runs `prelude` first, reports
   * its pid through a READY file, then holds its import open — so the real
   * cli.ts child stays alive inside the guardrails loader until a signal (or
   * the watchdog) ends it. `marker` is a path the prelude may write.
   */
  function holdingProvider(prelude: (files: { marker: string }) => string[] = () => []): { path: string; marker: string; ready: string } {
    const d = mkdtempSync(join(tmpdir(), 'gbrain-hold-provider-'));
    scratch.push(d);
    const marker = join(d, 'MARKER');
    const ready = join(d, 'READY');
    const path = join(d, 'provider.mjs');
    writeFileSync(path, [
      `import { writeFileSync, renameSync } from 'node:fs';`,
      ...prelude({ marker }),
      `writeFileSync(${JSON.stringify(ready + '.tmp')}, String(process.pid)); renameSync(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)});`,
      `setInterval(() => {}, ${KEEPALIVE_INTERVAL_MS});`,
      `await new Promise(() => {});`, // hold the import open
      `export default { id: 'fixture-hold', classify() {} };`,
      '',
    ].join('\n'));
    return { path, marker, ready };
  }
  const hopDirsIn = (tmp: string) => readdirSync(tmp).filter((n) => n.startsWith('gbrain-hop-'));
  /** Poll `cond` until true or `ms` elapsed. */
  async function within(ms: number, cond: () => boolean): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return cond();
  }

  test("through cli.ts: SIGTERM to the wrapper — the wrapper outlives the child's graceful exit(0), relays 0, the marker is present, the neutral dir is removed", async () => {
    const { dir } = hostileRepo(() => 'GBRAIN_ALLOW_SHELL_JOBS=1'); // protected, NOT the guardrails key → quarantine + re-run, no refusal
    // The child's cli.ts handler would exit 143 at once; this models a command that shuts down gracefully instead.
    const provider = holdingProvider(({ marker }) => [
      `process.removeAllListeners('SIGTERM');`,
      `process.on('SIGTERM', () => { setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(0); }, ${GRACEFUL_EXIT_DELAY_MS}); });`,
    ]);
    const hopTmp = mkdtempSync(join(tmpdir(), 'gbrain-e43-hoptmp-')); // private TMPDIR: the neutral dir is created — and must be removed — in here
    scratch.push(hopTmp);
    const env = hermeticEnv(dir, { GBRAIN_GUARDRAILS_MODULE: provider.path, TMPDIR: hopTmp });
    const proc = Bun.spawn([process.execPath, CLI_PATH, '--version'], { cwd: dir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const stdoutP = new Response(proc.stdout).text();
    const stderrP = new Response(proc.stderr).text();
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
    let childPid = 0;
    try {
      childPid = await waitReady(provider.ready);
      expect(childPid).not.toBe(proc.pid); // the provider loaded in the re-run, not in the wrapper
      expect(hopDirsIn(hopTmp)).toHaveLength(1); // the neutral dir exists while the child runs
      proc.kill('SIGTERM');
      const [code, stderr] = await Promise.all([proc.exited, stderrP, stdoutP]);
      expect(code).toBe(0); // the CHILD's exit — not cli.ts's own 143
      expect(existsSync(provider.marker)).toBe(true); // written by the child's delayed handler BEFORE the wrapper exited
      expect(hopDirsIn(hopTmp)).toEqual([]); // finally { rmSync(neutral) } ran
      expect(stderr).toContain('Ignoring GBRAIN_ALLOW_SHELL_JOBS because');
      expect(await gone(childPid)).toBe(true);
    } finally {
      clearTimeout(timer);
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  });

  // E5-1 (review cycle 5): a supervisor that tracks the WRAPPER pid escalates
  // to SIGKILL on it (ChildWorkerSupervisor.restartCurrentChild); SIGKILL
  // cannot be forwarded, so the re-run used to survive as an orphan while the
  // supervisor started a replacement. The hop marker now carries the wrapper's
  // pid and the verified re-run runs a 1 s die-with-parent watchdog on
  // `process.ppid` (LIVE in Bun 1.3.13 — measured: it flips to the reaper's pid
  // after the parent dies, whether it exited or was SIGKILLed). The child also
  // removes the (empty) neutral dir the wrapper's own `finally` never reached.
  const WATCHDOG_NOTICE_MS = 4_000; // the watchdog ticks every second; allow for a loaded box
  test('SIGKILL on the wrapper: the re-run notices within seconds, exits (137) and removes the neutral dir the wrapper could not', async () => {
    const { dir } = hostileRepo(() => 'GBRAIN_ALLOW_SHELL_JOBS=1');
    const provider = holdingProvider();
    const hopTmp = mkdtempSync(join(tmpdir(), 'gbrain-e51-hoptmp-'));
    scratch.push(hopTmp);
    const env = hermeticEnv(dir, { GBRAIN_GUARDRAILS_MODULE: provider.path, TMPDIR: hopTmp });
    const proc = Bun.spawn([process.execPath, CLI_PATH, '--version'], { cwd: dir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const stdoutP = new Response(proc.stdout).text();
    const stderrP = new Response(proc.stderr).text(); // resolves when the LAST writer (the child) closes the inherited pipe
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, CHILD_KILL_AFTER_MS);
    let childPid = 0;
    try {
      childPid = await waitReady(provider.ready);
      expect(childPid).not.toBe(proc.pid);
      expect(hopDirsIn(hopTmp)).toHaveLength(1);
      proc.kill('SIGKILL'); // the supervisor's escalation, aimed at the pid it tracks: the wrapper
      await proc.exited;
      expect(await within(WATCHDOG_NOTICE_MS, () => { try { process.kill(childPid, 0); return false; } catch { return true; } })).toBe(true); // the re-run is gone
      expect(await within(WATCHDOG_NOTICE_MS, () => hopDirsIn(hopTmp).length === 0)).toBe(true); // …and it cleaned up the neutral dir
      const [stderr] = await Promise.all([stderrP, stdoutP]);
      expect(stderr).toContain('[env] sanitized re-run lost its wrapper (killed); exiting');
    } finally {
      clearTimeout(timer);
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  });

  // E4-5 (review cycle 4): dropping a planted HOME must not leave the re-run
  // with NO $HOME — git then fails (`Author identity unknown`, `$HOME not set`)
  // and every raw `process.env.HOME || ''` read resolves INTO the checkout. The
  // sanitized env gets HOME back from os.userInfo().homedir, which Bun derives
  // from the REAL startup environ (passwd when HOME was unset) before the .env
  // merge — the planted value never reaches it (measured on Bun 1.3.13).
  const HOME_PROBE_BODY = `process.stdout.write('HOME=' + JSON.stringify(process.env.HOME ?? null) + '\\n');\nprocess.exit(7);`;
  /** What the wrapper will resolve: userInfo().homedir for a process started with `env` (HOME unset → passwd). */
  async function homeSeenBy(env: Record<string, string>): Promise<string> {
    const p = Bun.spawn(
      [process.execPath, '--no-env-file', '-e', 'process.stdout.write(require("node:os").userInfo().homedir)'],
      { env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
    );
    const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return out;
  }

  test.skipIf(!GIT_BIN)('a planted HOME (HOME unset at spawn) is dropped AND the re-run gets the real home back — never the planted path, never empty', async () => {
    const { dir, entry } = hostileGitRepo({ envLines: (d) => [`HOME=${d}`, 'PROJECT_NAME=demo'], entryBody: HOME_PROBE_BODY });
    const env = hermeticEnv(dir);
    delete env.HOME; // cron/systemd shape: nothing exported HOME, so Bun fills it from the .env
    const expected = await homeSeenBy(env);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected).not.toBe(dir);
    const r = await runCli([process.execPath, entry, '--preflight'], dir, env);
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toContain(`HOME=${JSON.stringify(expected)}`);
    const warnings = warningLines(r.stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Ignoring HOME because a .env file in the current directory assigns it');
  });

  test.skipIf(!GIT_BIN)("an exported HOME shadowed by a .env assignment (key-presence false drop) comes back as the operator's own value", async () => {
    const { dir, entry } = hostileGitRepo({ envLines: (d) => [`HOME=${d}`], entryBody: HOME_PROBE_BODY });
    const env = hermeticEnv(dir); // HOME exported (scratch home): Bun keeps it, the quarantine still drops it (presence, not value)
    const r = await runCli([process.execPath, entry, '--preflight'], dir, env);
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toContain(`HOME=${JSON.stringify(env.HOME)}`);
    expect(warningLines(r.stderr)[0]).toContain('Ignoring HOME because');
  });

  // A3-6(i): a dev-runtime re-run (`bun src/cli.ts`) must re-insert the runtime
  // flags from process.execArgv, or `--smol`/`--inspect`/`--preload` would be
  // dropped on the hop. Only the re-run reaches entryBody (the wrapper re-execs
  // and exits), so the printed execArgv is the re-run's.
  test.skipIf(!GIT_BIN)('the re-run preserves the dev-runtime execArgv (--smol) across the hop', async () => {
    const { dir, entry } = hostileGitRepo({
      entryBody: `process.stdout.write('EXECARGV=' + JSON.stringify(process.execArgv) + '\\n');\nprocess.exit(7);`,
    });
    const r = await runCli([process.execPath, '--smol', entry, '--preflight'], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toContain('EXECARGV=["--smol"]');
  });

  // E5-2 (review cycle 5): execArgv was copied verbatim, so a RELATIVE runtime
  // path (`bun --preload ./probe.ts src/cli.ts`) resolved from the EMPTY neutral
  // dir and the re-run died with `preload not found`. Path-bearing runtime
  // flags (--preload/-r/--require/--import, --config/-c, --env-file,
  // --tsconfig-override; both `--flag value` and `--flag=value` — Bun reports
  // both spellings verbatim) now have a relative value resolved against the
  // ORIGINAL cwd. pre.ts appends one line per load: parent + re-run = 2.
  const EXECARGV_BODY = `process.stdout.write('EXECARGV=' + JSON.stringify(process.execArgv) + '\\n');\nprocess.exit(7);`;
  function countingPreload(dir: string): { rel: string; abs: string; loads: string } {
    const loads = join(dir, 'PRELOAD_LOADS');
    writeFileSync(join(dir, 'tooling', 'pre.ts'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(loads)}, process.pid + '\\n');\n`);
    return { rel: './tooling/pre.ts', abs: join(dir, 'tooling', 'pre.ts'), loads };
  }
  const loadCount = (loads: string) => (existsSync(loads) ? readFileSync(loads, 'utf8').trim().split('\n').length : 0);

  const relativeSpellings: Array<[label: string, argv: (rel: string) => string[]]> = [
    ['--preload ./x (two entries)', (rel) => ['--preload', rel]],
    ['--preload=./x (one entry)', (rel) => [`--preload=${rel}`]],
    ['-r ./x', (rel) => ['-r', rel]],
    ['--smol before --import ./x (order kept)', (rel) => ['--smol', '--import', rel]],
  ];
  for (const [label, argv] of relativeSpellings) {
    test.skipIf(!GIT_BIN)(`a relative runtime path survives the hop: ${label} → loads in the parent AND the re-run, no "preload not found"`, async () => {
      const { dir, entry } = hostileGitRepo({ entryBody: EXECARGV_BODY });
      const pre = countingPreload(dir);
      const r = await runCli([process.execPath, ...argv(pre.rel), entry, '--preflight'], dir, hermeticEnv(dir));
      expect(r.stderr).not.toContain('preload not found');
      expect(r.exitCode).toBe(7);
      expect(loadCount(pre.loads)).toBe(2);
      // The re-run's execArgv carries the ABSOLUTE spelling, other flags untouched, order preserved.
      const expected = argv(pre.rel).map((a) => a.replace(pre.rel, realpathSync(pre.abs)));
      expect(r.stdout).toContain(`EXECARGV=${JSON.stringify(expected)}`);
    });
  }

  test.skipIf(!GIT_BIN)('control: an absolute --preload path is passed through unchanged (still loads twice)', async () => {
    const { dir, entry } = hostileGitRepo({ entryBody: EXECARGV_BODY });
    const pre = countingPreload(dir);
    const r = await runCli([process.execPath, '--preload', pre.abs, entry, '--preflight'], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(7);
    expect(loadCount(pre.loads)).toBe(2);
    expect(r.stdout).toContain(`EXECARGV=${JSON.stringify(['--preload', pre.abs])}`);
  });

  // A3-4 (red team): a relative `TMPDIR=t` in the .env would make mkdtemp return
  // a relative neutral path, breaking the re-run's realpath marker check. TMPDIR
  // is now protected, so the parent drops it BEFORE makeNeutralDir consults
  // os.tmpdir(); realpathSync then guarantees `neutral` is absolute + canonical.
  // The hop still completes: cwd restored to the caller, marker not leaked.
  test.skipIf(!GIT_BIN)('a relative TMPDIR planted by the .env is quarantined before the neutral dir is made; the hop completes and cwd is restored', async () => {
    const { dir, entry } = hostileGitRepo({
      envLines: () => ['TMPDIR=t', 'PROJECT_NAME=demo'],
      entryBody: `process.stdout.write('CWD=' + process.cwd() + ' MARKER=' + JSON.stringify(process.env.GBRAIN_CWD_ENV_QUARANTINED ?? null) + '\\n');\nprocess.exit(7);`,
    });
    const r = await runCli([process.execPath, entry, '--preflight'], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toContain(`CWD=${realpathSync(dir)}`); // switched back to the caller
    expect(r.stdout).toContain('MARKER=null');              // internal marker not visible
    const warnings = warningLines(r.stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Ignoring TMPDIR because a .env file in the current directory assigns it');
  });

  // A2-3 (red team): git reads $XDG_CONFIG_HOME/git/config as GLOBAL config,
  // so a non-GIT_ variable carries the same core.fsmonitor RCE.
  const xdgLines = (d: string) => [`XDG_CONFIG_HOME=${d}/.xdg`, 'PROJECT_NAME=demo'];
  function plantXdgFsmonitor(dir: string): void {
    mkdirSync(join(dir, '.xdg', 'git'), { recursive: true });
    writeFileSync(join(dir, '.xdg', 'git', 'config'), '[core]\n\tfsmonitor = ./tooling/evil.sh\n');
  }

  test.skipIf(!GIT_BIN)('control: XDG_CONFIG_HOME planted by the .env makes git run the script (no preflight)', async () => {
    const { dir, evilMarker, entry } = hostileGitRepo({ envLines: xdgLines });
    plantXdgFsmonitor(dir);
    const r = await runCli([process.execPath, entry], dir, hermeticEnv(dir));
    expect(r.exitCode).toBe(7);
    expect(existsSync(evilMarker)).toBe(true);
  });

  test.skipIf(!GIT_BIN)('with preflight: XDG_CONFIG_HOME is quarantined and git from the original cwd does NOT run the planted fsmonitor', async () => {
    const { dir, evilMarker, entry } = hostileGitRepo({ envLines: xdgLines });
    plantXdgFsmonitor(dir);
    const r = await runCli([process.execPath, entry, '--preflight'], dir, hermeticEnv(dir));
    expect(existsSync(evilMarker)).toBe(false);
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toContain('GIT_EXIT=0');
    expect(r.stdout).toContain(`CWD=${realpathSync(dir)}`);
    expect(r.stdout).toContain('PROJECT_NAME=demo');
    const warnings = warningLines(r.stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Ignoring XDG_CONFIG_HOME because a .env file in the current directory assigns it');
  });

  const compiledTest = existsSync(COMPILED_BIN) ? test : test.skip;
  compiledTest.skipIf(!GIT_BIN)('compiled binary from the hostile git checkout: one warning, exit 0, a single stdout line, no script run', async () => {
    // `--version` itself spawns nothing, so the marker check guards the harness;
    // the re-run's argv shape (compiled: user args only, no /$bunfs entry) is
    // what the single clean stdout line + exit 0 prove.
    const { dir, evilMarker } = hostileGitRepo();
    const r = await runCli([COMPILED_BIN, '--version'], dir, hermeticEnv(dir));
    expect(existsSync(evilMarker)).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stdout).toMatch(/^gbrain \d/);
    const warnings = warningLines(r.stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Ignoring ${HOSTILE_WARNING_KEYS} because`);
  });
});

// ── cwd == config dir: the operator's own .env is not a "cwd .env" (A4) ──────
describe('running gbrain from inside its own config dir', () => {
  /** A VALID provider module (registers one guardrail) that also drops a marker when imported. */
  function validProvider(): { path: string; marker: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-a4-provider-'));
    scratch.push(dir);
    const marker = join(dir, 'PROVIDER_LOADED');
    const path = join(dir, 'provider.mjs');
    writeFileSync(
      path,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n` +
      `export default { id: 'fixture-a4', classify() {} };\n`,
    );
    return { path, marker };
  }

  test('$GBRAIN_HOME/.gbrain as cwd: its .env is honored, no quarantine warning, exit 0', async () => {
    const clean = mkdtempSync(join(tmpdir(), 'gbrain-clean-cwd-'));
    scratch.push(clean);
    const env = hermeticEnv(clean);
    const cfgDir = join(env.GBRAIN_HOME, '.gbrain');
    mkdirSync(cfgDir, { recursive: true });
    const { path, marker } = validProvider();
    writeFileSync(join(cfgDir, '.env'), `GBRAIN_GUARDRAILS_MODULE=${path}\n`);
    const r = await runCli([process.execPath, CLI_PATH, '--version'], cfgDir, { ...env, PWD: cfgDir });
    expect(r.stderr).not.toContain('[env] Ignoring');
    expect(r.stderr).not.toContain('guardrails:');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^gbrain \d/);
    expect(existsSync(marker)).toBe(true); // the operator's provider loaded
  });

  test('hostile variant: a checkout whose .env assigns GBRAIN_HOME to manufacture the collision is still quarantined', async () => {
    const { dir, marker } = hostileRepo(() => 'UNRELATED=1'); // the probe module lives here
    // The checkout IS <dir>/evil-home/.gbrain and points GBRAIN_HOME at <dir>/evil-home, so configDir() === cwd.
    const fakeCfg = join(dir, 'evil-home', '.gbrain');
    mkdirSync(fakeCfg, { recursive: true });
    writeFileSync(
      join(fakeCfg, '.env'),
      `GBRAIN_HOME=${join(dir, 'evil-home')}\nGBRAIN_GUARDRAILS_MODULE=${join(dir, 'tooling', 'probe.ts')}\n`,
    );
    const env = hermeticEnv(fakeCfg);
    delete env.GBRAIN_HOME; // exported vars beat .env in Bun; the attack needs the .env value to land
    const r = await runCli([process.execPath, CLI_PATH, '--version'], fakeCfg, env);
    expect(existsSync(marker)).toBe(false);
    // Both keys are quarantined (one warning names them) and, because the
    // dropped set includes GBRAIN_GUARDRAILS_MODULE, preflight then fails closed.
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('[env] Ignoring GBRAIN_GUARDRAILS_MODULE, GBRAIN_HOME because a .env file in the current directory assigns it');
    expect(r.stderr).toContain("refusing to run without the operator's firewall");
    expect(r.stdout).not.toMatch(/^gbrain \d/);
  });

  // E4-2 (review cycle 4): the exemption compares cwd with configDir(), which
  // is derived from HOME / USERPROFILE / GBRAIN_HOME. A cwd .env that assigns
  // ANY of those cannot be the operator's own file — a planted home is never
  // the operator's config dir — so the exemption is refused for all three, not
  // just GBRAIN_HOME. Unit: the predicate itself.
  test('cwdIsOperatorConfigDir: refused when the cwd .env assigns HOME / USERPROFILE / GBRAIN_HOME; granted for a genuine collision', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-e42-home-'));
    scratch.push(home);
    const cfgDir = join(home, '.gbrain');
    mkdirSync(cfgDir);
    await withEnv({ GBRAIN_HOME: home }, () => {
      expect(cwdIsOperatorConfigDir(cfgDir, [['UNRELATED', '1']])).toBe(true);                // control: a genuine collision
      expect(cwdIsOperatorConfigDir(cfgDir, [['GBRAIN_GUARDRAILS_MODULE', '/x']])).toBe(true); // the operator's own security key in their own .env
      for (const key of ['GBRAIN_HOME', 'HOME', 'USERPROFILE']) {
        expect(cwdIsOperatorConfigDir(cfgDir, [[key, home]])).toBe(false);
      }
      expect(cwdIsOperatorConfigDir(join(home, 'elsewhere'), [['UNRELATED', '1']])).toBe(false); // not the config dir at all
    });
  });

  // E4-2 e2e — the forged-home shape. HOME and GBRAIN_HOME are both ABSENT from
  // the spawn env (a cron / systemd unit), the checkout is laid out as
  // <hostile>/.gbrain and its .env assigns HOME=<hostile> (Bun sets it because
  // nothing exported it) next to GBRAIN_GUARDRAILS_MODULE. Measured on Bun
  // 1.3.13: os.homedir() is captured from the REAL environ before the .env
  // merge, so configDir() never followed the planted HOME and the collision was
  // not manufactured even before the predicate change — this pins the invariant
  // that must hold either way: exemption refused, the planted module never
  // loads, preflight fails closed, and the warning names HOME.
  test('forged home: cwd = <hostile>/.gbrain whose .env assigns HOME (HOME + GBRAIN_HOME unset at spawn) — module not loaded, exit 1, warning names HOME', async () => {
    const { dir, marker } = hostileRepo(() => 'UNRELATED=1'); // the probe module lives here
    const fakeCfg = join(dir, '.gbrain');
    mkdirSync(fakeCfg);
    writeFileSync(join(fakeCfg, '.env'), `HOME=${dir}\nGBRAIN_GUARDRAILS_MODULE=${join(dir, 'tooling', 'probe.ts')}\n`);
    const env = hermeticEnv(fakeCfg);
    delete env.HOME;
    delete env.GBRAIN_HOME; // the cron/systemd shape: Bun fills HOME from the .env because nothing exported it
    const r = await runCli([process.execPath, CLI_PATH, '--version'], fakeCfg, env);
    expect(existsSync(marker)).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('[env] Ignoring GBRAIN_GUARDRAILS_MODULE, HOME because a .env file in the current directory assigns it');
    expect(r.stderr).toContain("refusing to run without the operator's firewall");
    expect(r.stdout).not.toMatch(/^gbrain \d/);
  });
});


// ── A3-1: a cwd bunfig.toml cannot preload code into the COMPILED binary ─────
//
// A standalone Bun executable auto-loads a `bunfig.toml` from the process cwd
// and runs its `preload` scripts BEFORE any of the binary's own code — before
// cli-preflight, before the cwd-.env quarantine. gbrain is a global CLI that
// runs from arbitrary checkouts, so a hostile repo carrying bunfig.toml +
// `preload` would get RCE from a plain `gbrain --version`. The binary is now
// built with `--no-compile-autoload-bunfig`, which makes a cwd bunfig.toml
// inert (guarded at build time by scripts/check-compile-autoload.sh). The dev
// runtime `bun src/cli.ts` stays bun-native — a contributor's cwd is trusted —
// so this behavior is only assertable against a compiled binary.
describe('a cwd bunfig.toml cannot preload code into the compiled binary', () => {
  /** A hostile checkout: bunfig.toml whose preload script drops a marker. */
  function hostileBunfig(): { dir: string; marker: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-hostile-bunfig-'));
    scratch.push(dir);
    const marker = join(dir, 'PRELOAD_RAN');
    mkdirSync(join(dir, 'tooling'));
    writeFileSync(
      join(dir, 'tooling', 'pre.ts'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`,
    );
    writeFileSync(join(dir, 'bunfig.toml'), 'preload = ["./tooling/pre.ts"]\n');
    return { dir, marker };
  }

  const compiledTest = existsSync(COMPILED_BIN) ? test : test.skip;
  compiledTest('the preload script does NOT run under the compiled binary', async () => {
    const { dir, marker } = hostileBunfig();
    const r = await runCli([COMPILED_BIN, '--version'], dir, hermeticEnv(dir));
    expect(existsSync(marker)).toBe(false); // --no-compile-autoload-bunfig made it inert
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^gbrain \d/);
  });
});

// ── E4-4 (review cycle 4): script mode honours a cwd bunfig.toml — say so ────
//
// The documented install (`bun install -g github:…`, `git clone` + `bun link`)
// maps the `gbrain` bin to src/cli.ts, so gbrain runs as an ordinary Bun
// SCRIPT and Bun applies the cwd bunfig.toml — a top-level `preload` runs
// before any gbrain code (measured on Bun 1.3.13: only `--config=/dev/null`
// suppresses it; `-c`, `--no-bunfig`, `BUN_CONFIG_*` and a `[test]`-section
// preload do not / do not apply). Preflight cannot undo what already ran; it
// prints ONE stderr line naming the fact when it detects the shape — script
// runtime + a top-level preload in the startup cwd's bunfig.toml — except when
// the cwd IS the checkout containing the running entry (a contributor's own
// repo). The compiled binary is protected at build time (pinned above).
describe('script mode + cwd bunfig.toml: preflight names the already-applied preload (E4-4)', () => {
  const SCRIPT_MODE_WARNING_HEAD =
    '[env] gbrain is running as a bun script (not the compiled binary) and the bunfig.toml in the current directory declares a top-level preload';
  const scriptModeWarnings = (stderr: string) => stderr.split('\n').filter((l) => l.startsWith(SCRIPT_MODE_WARNING_HEAD));

  /** A dir whose bunfig.toml is `bunfig`; tooling/pre.ts drops the returned marker when Bun preloads it. */
  function bunfigDir(bunfig: string, prefix = 'gbrain-script-bunfig-'): { dir: string; marker: string } {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratch.push(dir);
    const marker = join(dir, 'PRELOAD_RAN');
    mkdirSync(join(dir, 'tooling'));
    writeFileSync(join(dir, 'tooling', 'pre.ts'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    writeFileSync(join(dir, 'bunfig.toml'), bunfig);
    return { dir, marker };
  }
  const TOP_LEVEL_PRELOAD = 'preload = ["./tooling/pre.ts"]\n';

  test('bun src/cli.ts from a dir whose bunfig.toml has a top-level preload: the preload RUNS (Bun, before gbrain) and preflight prints the one-line warning', async () => {
    const { dir, marker } = bunfigDir(TOP_LEVEL_PRELOAD);
    const r = await runCli([process.execPath, CLI_PATH, '--version'], dir, hermeticEnv(dir));
    expect(existsSync(marker)).toBe(true); // honest: script mode cannot prevent this — the warning IS the mitigation
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^gbrain \d/);
    expect(scriptModeWarnings(r.stderr)).toHaveLength(1);
  });

  test('controls: a [test]-section preload (not applied by bun run) and no bunfig at all → no warning', async () => {
    const testOnly = bunfigDir('[test]\npreload = ["./tooling/pre.ts"]\n');
    const r1 = await runCli([process.execPath, CLI_PATH, '--version'], testOnly.dir, hermeticEnv(testOnly.dir));
    expect(existsSync(testOnly.marker)).toBe(false);
    expect(r1.exitCode).toBe(0);
    expect(scriptModeWarnings(r1.stderr)).toEqual([]);
    const none = mkdtempSync(join(tmpdir(), 'gbrain-clean-cwd-'));
    scratch.push(none);
    const r2 = await runCli([process.execPath, CLI_PATH, '--version'], none, hermeticEnv(none));
    expect(r2.exitCode).toBe(0);
    expect(scriptModeWarnings(r2.stderr)).toEqual([]);
  });

  test('the checkout containing the running entry is exempt; the same entry from a foreign preload dir warns; a hop warns exactly once (wrapper only)', async () => {
    // A package-shaped checkout: <pkg>/src/entry.ts (preflight only) + <pkg>/bunfig.toml with a top-level preload.
    const pkg = bunfigDir(TOP_LEVEL_PRELOAD, 'gbrain-script-pkg-');
    mkdirSync(join(pkg.dir, 'src'));
    const entry = join(pkg.dir, 'src', 'entry.ts');
    writeFileSync(entry, `import { runCliPreflight } from ${JSON.stringify(PREFLIGHT_MODULE)};\nawait runCliPreflight();\nprocess.exit(3);\n`);
    // cwd == the entry's own package root → a contributor's checkout → exempt.
    const own = await runCli([process.execPath, entry], pkg.dir, hermeticEnv(pkg.dir));
    expect(existsSync(pkg.marker)).toBe(true);
    expect(own.exitCode).toBe(3);
    expect(scriptModeWarnings(own.stderr)).toEqual([]);
    // The same entry run from a foreign dir carrying a preload bunfig → warns.
    const foreign = bunfigDir(TOP_LEVEL_PRELOAD);
    const far = await runCli([process.execPath, entry], foreign.dir, hermeticEnv(foreign.dir));
    expect(existsSync(foreign.marker)).toBe(true);
    expect(far.exitCode).toBe(3);
    expect(scriptModeWarnings(far.stderr)).toHaveLength(1);
    // Foreign dir with BOTH a preload bunfig and a protected-key .env → the wrapper warns once; the re-run (started in the neutral dir) does not.
    const hop = bunfigDir(TOP_LEVEL_PRELOAD);
    writeFileSync(join(hop.dir, '.env'), 'GBRAIN_ALLOW_SHELL_JOBS=1\n');
    const hopped = await runCli([process.execPath, entry], hop.dir, hermeticEnv(hop.dir));
    expect(hopped.exitCode).toBe(3);
    expect(scriptModeWarnings(hopped.stderr)).toHaveLength(1);
    expect(warningLines(hopped.stderr)).toHaveLength(1);
  });
});

// ── A3-6(ii): the sanitized re-run chdirs back to the caller ─────────────────
//
// On a verified hop the re-run switches back to the caller's directory before
// anything else runs. If that directory has vanished, it aborts with a clear
// message rather than continuing from the neutral temp dir. Both branches are
// driven by planting a VALID hop marker (startup cwd IS the .env-free neutral
// dir it names) so verifiedHop honours it.
describe('sanitized re-run: chdir back to the caller', () => {
  function preflightOnlyEntry(): string {
    const d = mkdtempSync(join(tmpdir(), 'gbrain-preflight-entry-'));
    scratch.push(d);
    const p = join(d, 'entry.ts');
    writeFileSync(p, [
      `import { realpathSync } from 'node:fs';`,
      `import { runCliPreflight } from ${JSON.stringify(PREFLIGHT_MODULE)};`,
      `await runCliPreflight();`,
      `process.stdout.write('CWD=' + realpathSync(process.cwd()) + '\\n');`,
      `process.exit(3);`,
      '',
    ].join('\n'));
    return p;
  }

  test('a re-run whose original cwd vanished aborts with a clear error (exit 1)', async () => {
    const entry = preflightOnlyEntry();
    const gone = mkdtempSync(join(tmpdir(), 'gbrain-vanished-cwd-'));
    const neutral = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-neutral-'))); scratch.push(neutral);
    rmSync(gone, { recursive: true, force: true }); // the caller's dir no longer exists
    const env = { ...hermeticEnv(neutral), GBRAIN_CWD_ENV_QUARANTINED: JSON.stringify({ cwd: gone, neutral }) };
    const r = await runCli([process.execPath, entry, '--preflight'], neutral, env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`[env] cannot return to ${gone}`);
  });

  test('a re-run with a live original cwd chdirs back and proceeds (exit 3)', async () => {
    const entry = preflightOnlyEntry();
    const live = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-live-cwd-'))); scratch.push(live);
    const neutral = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-neutral-'))); scratch.push(neutral);
    const env = { ...hermeticEnv(neutral), GBRAIN_CWD_ENV_QUARANTINED: JSON.stringify({ cwd: live, neutral }) };
    const r = await runCli([process.execPath, entry, '--preflight'], neutral, env);
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain(`CWD=${live}`);
    expect(r.stderr).not.toContain('cannot return');
  });
});
