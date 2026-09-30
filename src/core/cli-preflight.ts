/**
 * CLI startup preflight — the FIRST statement of `cli.ts:main()`, before
 * global-flag parsing and any command dispatch. Ordered steps:
 *
 *   0. Sanitized re-run detection. When this process IS the re-run described
 *      in step 1b (verified, never trusted on the marker's say-so — see
 *      "Loop guard"), switch back to the caller's directory, arm the
 *      die-with-wrapper watchdog (see "Die with the wrapper") and skip step 1:
 *      the parent already quarantined and warned.
 *   1. `quarantineCwdDotenv()` — drop every protected key (env-trust.ts: the
 *      security-relevant GBRAIN_* keys plus the loader / git / node / XDG /
 *      TLS-trust / proxy / AI-endpoint hijack families) that a `.env` in the
 *      cwd assigns. GBRAIN_HOME is on that list, so it is quarantined BEFORE
 *      step 2 resolves the config dir. The 8 cwd .env files are parsed ONCE
 *      here and the parse is shared with the cwd == config dir check.
 *   1b. Re-run gbrain with the sanitized environment whenever anything was
 *      dropped (see "Why the re-run" below).
 *   2. `loadGbrainEnvFile(configDir)` — fill process.env from `~/.gbrain/.env`
 *      (never overriding an exported variable). `loadConfig()` does this too,
 *      but the guardrails loader in step 3 runs before any `loadConfig()`;
 *      without this step `~/.gbrain/.env` could not be the operator's home
 *      for GBRAIN_GUARDRAILS_MODULE.
 *   3. The #3688 guardrails loader (moved from cli.ts; now passes
 *      `skipCwdCheck`). Fail-closed: set-but-broken aborts rather than
 *      silently running without the operator's firewall; unset costs nothing.
 *
 * Fail-closed corollary of step 1 (see "GBRAIN_GUARDRAILS_MODULE" below): when
 * the quarantine dropped a NON-EMPTY `GBRAIN_GUARDRAILS_MODULE`, preflight
 * refuses to run at all instead of re-running without it.
 *
 * Every runtime entry — commands, `hook *`, `serve` (stdio and --http),
 * `mcp`, the supervisor-spawned `jobs work`, the per-job `jobs run-child` —
 * dispatches through `main()`, so this one call covers every gbrain process.
 * (`src/commands/auth.ts`'s `import.meta.main` seam is a dev-only
 * direct-script entry.)
 *
 * ## Why the re-run (step 1b)
 *
 * Deleting a key from process.env changes only THIS process's view. Bun hands
 * every child spawned without an explicit `env` option the environ snapshot
 * it took at startup — cwd-.env values included — so git, the claude CLI and
 * workers would still see the planted keys (verified on Bun 1.3.13: a `.env`
 * carrying `GIT_CONFIG_COUNT=1 / GIT_CONFIG_KEY_0=core.fsmonitor /
 * GIT_CONFIG_VALUE_0=./x.sh` runs x.sh from a plain `git status`). When the
 * quarantine dropped anything, preflight therefore spawns gbrain again with
 * an explicit, sanitized environment and exits with the re-run's status;
 * every descendant of the re-run inherits the clean view.
 *
 * The re-run starts in a NEUTRAL cwd: a fresh, empty `mkdtemp` directory that
 * is ours and by construction holds none of the `.env` family. Bun loads
 * `.env` from the process cwd only (no parent walk — verified on 1.3.13), so
 * the re-run's Bun never sees the hostile file and its environ simply LACKS
 * the dropped keys. They are deleted, never carried as empty strings: git and
 * the dynamic loader PRESENCE-check some of them (`GIT_SSL_NO_VERIFY=`
 * disables TLS verification, `LD_TRACE_LOADED_OBJECTS=` turns every
 * dynamically linked child into ldd, `GIT_DIR=` / `GIT_AUTHOR_NAME=` are hard
 * errors), so `''` would not have been neutral. Preflight in the re-run then
 * `chdir`s back to the caller's directory before anything else runs, so
 * relative arguments resolve exactly as typed. Nothing in cli.ts's import
 * graph captures `process.cwd()` at module-evaluation time (audited); every
 * read happens after this chdir.
 *
 * ## Loop guard
 *
 * The re-run carries `GBRAIN_CWD_ENV_QUARANTINED=<JSON {cwd, neutral,
 * wrapperPid}>`. The marker is NOT trusted by itself — a hostile .env could
 * plant one (the key is also on the protected list, so a planted copy is
 * dropped and named in the warning). It is honoured only when ALL of: it
 * parses to two strings (`wrapperPid` is informational — a positive integer
 * or ignored), this process's startup cwd IS `neutral` (realpath-compared),
 * and `neutral` contains none of the `.env` family. A process started from a hostile
 * directory fails the second check (its startup cwd has a `.env`) and the
 * third if it names its own directory — so it ignores the marker entirely
 * and never chdirs on one. Termination is structural: the re-run's startup
 * cwd has no `.env`, so it never drops anything and never re-runs. gbrain
 * self-spawns (supervisor → worker, hook → detached push, worker →
 * run-child) that start in the hostile cwd reload the file and perform the
 * hop once for their own subtree — accepted; one warning per subtree.
 *
 * ## Signals
 *
 * Handlers are installed BEFORE the spawn (a signal in the gap would take the
 * default action, kill the wrapper and orphan the re-run). The wrapper has no
 * duties of its own, so every listener some earlier module attached for the
 * forwarded signals is removed first: cli.ts installs its cleanup handlers
 * (process-cleanup.ts, SIGTERM → exit 143 / SIGHUP → exit 129) in its
 * `import.meta.main` block before `main()` reaches this preflight, and with
 * both attached a SIGTERM made the wrapper exit 143 before the re-run had
 * finished and before the neutral dir was removed. The wrapper's exit is
 * ALWAYS the child's. SIGTERM and SIGHUP — which a supervisor sends to the
 * wrapper pid alone — are always forwarded. SIGINT depends on whether the
 * process has a CONTROLLING TERMINAL (probed by opening `/dev/tty`; the
 * stdio `isTTY` flags on Windows), not on whether stdin is a tty:
 *   - a controlling terminal exists: the re-run shares the wrapper's
 *     foreground process group, so the terminal delivers Ctrl-C to it
 *     directly — ALSO when stdin/stdout/stderr are redirected
 *     (`serve --http </dev/null >log 2>&1` in a foreground shell). The wrapper
 *     does NOT forward (a second delivery would consume a `once('SIGINT')`
 *     graceful-shutdown handler such as serve-http's and turn Ctrl-C into an
 *     abrupt kill) and ignores the signal itself so it survives to relay the
 *     re-run's exit status.
 *   - no controlling terminal (a supervisor, cron, a detached agent harness):
 *     nothing does process-group delivery, so a SIGINT that reaches the
 *     wrapper pid alone would otherwise orphan the re-run. Each received
 *     SIGINT is forwarded once. (A harness that signals the whole group
 *     instead delivers twice here — accepted: no terminal, no graceful Ctrl-C
 *     expectation. A harness WITH a controlling terminal that signals the
 *     wrapper pid alone with SIGINT is not forwarded — the terminal is the
 *     delivery channel there; SIGTERM is what such harnesses send to stop a
 *     child, and it is always forwarded.)
 * Exit status: the re-run's code, or 128+signal when a signal killed it
 * (shell convention).
 *
 * ## Die with the wrapper
 *
 * SIGKILL cannot be forwarded. A supervisor that tracks the pid it spawned —
 * the WRAPPER's — and escalates to SIGKILL (minions/supervisor.ts
 * `restartCurrentChild`, job-isolation children, hook pushes) would leave the
 * real re-run running as an orphan while a replacement starts. So the marker
 * carries the wrapper's pid and a VERIFIED re-run arms a watchdog: every
 * second it compares `process.ppid` with that pid (Bun's `process.ppid` is
 * live — it flips to the reaper's pid once the parent is gone, whether it
 * exited or was killed; verified on 1.3.13) and, when they differ, prints one
 * line, removes the now-orphaned neutral dir (`rmdirSync` — it is empty by
 * construction, and a non-recursive remove can never take anything else
 * with it) and exits 137, mirroring the SIGKILL the wrapper took. The timer
 * is `unref()`ed so it never keeps a finished command alive. A marker without
 * a usable `wrapperPid` (planted, foreign, older) arms nothing.
 *
 * ## Runtime flags across the hop
 *
 * `bun <flags> src/cli.ts` re-inserts `process.execArgv` into the re-run (a
 * compiled binary has none). Bun reports path-bearing flags verbatim in both
 * spellings (`["--preload", "./x"]` and `["--preload=./x"]`) and resolves a
 * relative value against the process cwd — which for the re-run is the EMPTY
 * neutral dir, so `--preload ./probe.ts` died with `preload not found`. For
 * `--preload`/`-r`/`--require`/`--import`, `--config`/`-c`, `--env-file` and
 * `--tsconfig-override`, a value that is `./`- or `../`-relative, or a bare
 * relative name that exists in the original cwd, is resolved against the
 * ORIGINAL cwd; absolute values, bare package specifiers and every other
 * flag pass through untouched, in order.
 *
 * ## HOME after the drop
 *
 * HOME / USERPROFILE are on the protected list (a cron/systemd unit often has
 * HOME unset, and a planted value then reaches process.env and every child).
 * Dropping them must not leave the re-run with NO home at all: git fails
 * (`Author identity unknown`, `$HOME not set`) and every raw
 * `process.env.HOME || ''` read resolves cwd-relative INTO the checkout. So
 * when the quarantine dropped HOME (USERPROFILE on Windows), the sanitized env
 * gets it back from `os.userInfo().homedir` — Bun derives that from the REAL
 * startup environ (passwd when the variable was unset) BEFORE the .env merge,
 * so the planted value never reaches it (verified on Bun 1.3.13). Only a
 * DROPPED key is restored: a home that was simply never set stays unset, so a
 * hopped run and a plain run see the same environment.
 *
 * ## Script mode + cwd bunfig.toml
 *
 * The compiled binary is built with `--no-compile-autoload-bunfig`, so a cwd
 * `bunfig.toml` is inert for it. The documented install (`bun install -g
 * github:…`, `git clone` + `bun link`) maps the `gbrain` bin to src/cli.ts,
 * which runs as an ordinary Bun SCRIPT — and for a script Bun applies the cwd
 * bunfig.toml before any of the script's code: a top-level `preload` has
 * already run by the time preflight starts. Nothing here can undo that; only
 * `bun --config=/dev/null <entry>` suppresses it (verified on Bun 1.3.13: no
 * `-c`/`--no-bunfig` spelling and no `BUN_CONFIG_*` variable does). What
 * preflight CAN do is say so: when it detects the shape (script runtime + a
 * top-level `preload` in the startup cwd's bunfig.toml) it prints one stderr
 * line. The checkout that contains the running entry itself (a contributor's
 * own repo, whose bunfig is theirs) is exempt; the sanitized re-run started in
 * the neutral dir never saw a bunfig and does not repeat the warning.
 *
 * ## GBRAIN_GUARDRAILS_MODULE: fail closed, not open
 *
 * The quarantine is key-presence: when a cwd .env assigns the key, the value
 * in process.env is dropped whether it came from the file or from the
 * operator's shell (Bun merges the file before any code runs and never
 * overrides a live variable, so the two are indistinguishable). For every
 * other protected key a false drop is a loud downgrade with the fix in the
 * warning. For THIS key it would be the opposite of the #3688 contract: the
 * re-run would simply have no module and run without the operator's firewall,
 * with nothing but a stderr line. So when a non-empty value was dropped,
 * preflight refuses to run (exit 1). A benign repository never assigns this
 * gbrain-specific key, and the `~/.gbrain/.env` home is unaffected: it is
 * read AFTER the quarantine (step 2), never dropped by it.
 *
 * Zero cost on the normal path: no .env in the cwd, or nothing protected
 * assigned there, means no spawn.
 *
 * ## cwd == config dir
 *
 * Running gbrain from INSIDE `~/.gbrain` (or `$GBRAIN_HOME/.gbrain`) makes Bun
 * load the operator's own `.env` as a "cwd .env". That file is operator-owned,
 * so the quarantine and the guardrails loader's cwd check are skipped when
 * `realpath(cwd) === realpath(configDir())` — but ONLY when no cwd .env file
 * assigns any key the config dir is DERIVED from: GBRAIN_HOME, HOME or
 * USERPROFILE (a hostile checkout laid out as `<checkout>/.gbrain` could
 * otherwise try to point the home at itself to manufacture the collision; a
 * planted home is never the operator's config dir). Measured on Bun 1.3.13,
 * `os.homedir()` is captured from the real startup environ before the .env
 * merge, so a planted HOME does not actually reach `configDir()` — the check
 * is belt-and-braces against that implementation detail changing.
 */
import { closeSync, constants as fsConstants, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmdirSync, rmSync } from 'fs';
import { constants as osConstants, homedir, tmpdir, userInfo } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import {
  CWD_DOTENV_FILES,
  cwdDotenvAssignsKey,
  parseCwdDotenv,
  quarantineCwdDotenv,
  type DotenvAssignment,
} from './env-trust.ts';
import { loadGbrainEnvFile } from './gbrain-env-file.ts';
import { configDir } from './config.ts';

/**
 * Set on the sanitized re-run to `JSON {cwd, neutral}` (see "Loop guard").
 * Internal — not a setting; verified against the startup cwd, never trusted.
 */
export const CWD_ENV_QUARANTINED_MARKER = 'GBRAIN_CWD_ENV_QUARANTINED';

interface HopMarker {
  /** The caller's directory the re-run must switch back to. */
  cwd: string;
  /** The fresh empty directory the re-run was started in. */
  neutral: string;
  /** The wrapper's pid, for the die-with-wrapper watchdog; absent → no watchdog. Informational, not part of verification. */
  wrapperPid?: number;
}

function parseHopMarker(raw: string | undefined): HopMarker | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (
      v !== null && typeof v === 'object' &&
      typeof (v as HopMarker).cwd === 'string' && (v as HopMarker).cwd !== '' &&
      typeof (v as HopMarker).neutral === 'string' && (v as HopMarker).neutral !== ''
    ) {
      const marker: HopMarker = { cwd: (v as HopMarker).cwd, neutral: (v as HopMarker).neutral };
      const pid = (v as HopMarker).wrapperPid;
      if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) marker.wrapperPid = pid;
      return marker;
    }
  } catch {
    // not JSON — a planted or foreign value; ignored
  }
  return null;
}

const WRAPPER_WATCHDOG_INTERVAL_MS = 1000;

/** See "Die with the wrapper". Only ever called for a VERIFIED hop. */
function installWrapperWatchdog(hop: HopMarker): void {
  const wrapperPid = hop.wrapperPid;
  if (wrapperPid === undefined) return;
  const t = setInterval(() => {
    if (process.ppid === wrapperPid) return;
    console.error('[env] sanitized re-run lost its wrapper (killed); exiting');
    try { rmdirSync(hop.neutral); } catch { /* already gone, or not empty — never ours to force */ }
    process.exit(137);
  }, WRAPPER_WATCHDOG_INTERVAL_MS);
  t.unref(); // must never keep a finished command alive
}

/**
 * The marker, but ONLY when this process provably is the re-run: it started
 * inside the neutral dir the marker names, and that dir holds no .env family
 * member. Anything else (absent, malformed, planted from a hostile cwd) → null.
 */
function verifiedHop(startupCwd: string): HopMarker | null {
  const marker = parseHopMarker(process.env[CWD_ENV_QUARANTINED_MARKER]);
  if (!marker) return null;
  try {
    if (realpathSync(startupCwd) !== realpathSync(marker.neutral)) return null;
  } catch {
    return null;
  }
  for (const name of CWD_DOTENV_FILES) {
    if (existsSync(join(marker.neutral, name))) return null;
  }
  return marker;
}

/** The keys `configDir()` is derived from; a cwd .env assigning any of them forfeits the cwd == config dir exemption. */
const CONFIG_DIR_SOURCE_KEYS: readonly string[] = ['GBRAIN_HOME', 'HOME', 'USERPROFILE'];

/**
 * True when `cwd` IS the operator's config dir (see "cwd == config dir") and
 * no cwd .env file assigns a key the config dir is derived from. Exported for
 * tests.
 */
export function cwdIsOperatorConfigDir(cwd: string, assignments: readonly DotenvAssignment[]): boolean {
  for (const key of CONFIG_DIR_SOURCE_KEYS) {
    if (cwdDotenvAssignsKey(key, assignments)) return false;
  }
  try {
    return realpathSync(cwd) === realpathSync(configDir());
  } catch {
    return false; // invalid GBRAIN_HOME or a config dir that does not exist yet — no collision
  }
}

/**
 * argv (after execPath) that runs THIS gbrain again. A compiled Bun binary
 * reports its virtual entrypoint as argv[1] (`/$bunfs/root/...`; `~BUN` on
 * Windows) and execPath IS gbrain, so the user args are the whole argv;
 * `bun src/cli.ts` needs the runtime flags (`--inspect`, `--preload`, … from
 * process.execArgv, relative paths resolved against `originalCwd` — see
 * "Runtime flags across the hop") and the entry file re-inserted — Bun
 * reports the entry as an absolute path, so it survives the neutral-cwd start
 * (cli.ts computes rawArgs as `process.argv.slice(2)` in both modes). null
 * when there is no re-runnable entry (`bun -e`).
 */
function selfArgv(originalCwd: string): string[] | null {
  const entry = process.argv[1];
  const userArgs = process.argv.slice(2);
  if (!isScriptRuntime()) return userArgs;
  if (!entry || entry.startsWith('-')) return null;
  return [...resolveRuntimePaths(process.execArgv, originalCwd), entry, ...userArgs];
}

/** Bun runtime flags whose value is a filesystem path (or, for the preload family, a path OR a package specifier). */
const PATH_RUNTIME_FLAGS: ReadonlySet<string> = new Set([
  '--preload', '-r', '--require', '--import',
  '--config', '-c',
  '--env-file',
  '--tsconfig-override',
]);

/** A path-flag value the re-run must see from `cwd`: relative → absolute; everything else verbatim. */
function resolveRuntimePath(value: string, cwd: string): string {
  if (value === '' || isAbsolute(value)) return value;
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- value is a --preload/--env-file/... path the operator passed on THIS process's own bun command line (process.execArgv) and cwd is the process's own startup cwd; absolutizing it so the sanitized re-run (which starts in a neutral dir) sees the same file IS the point, and no fs operation happens here
  if (/^\.\.?(?:[\\/]|$)/.test(value)) return resolve(cwd, value); // ./x  ../x  .  ..
  try {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- same operator-supplied runtime-flag value against the process's own cwd; existsSync only decides whether a bare name is a file here or a package specifier
    if (existsSync(resolve(cwd, value))) return resolve(cwd, value); // a bare relative name that IS a file here (`--env-file .env.ci`)
  } catch {
    // unreadable — treat as a specifier
  }
  return value; // a package specifier (`--preload some-pkg`) or a non-path
}

/** `execArgv` with every path-bearing flag's relative value resolved against `cwd`; order and every other flag preserved. */
function resolveRuntimePaths(execArgv: readonly string[], cwd: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]!;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!PATH_RUNTIME_FLAGS.has(flag)) {
      out.push(arg);
      continue;
    }
    if (eq !== -1) {
      out.push(`${flag}=${resolveRuntimePath(arg.slice(eq + 1), cwd)}`); // --flag=value
      continue;
    }
    out.push(arg); // --flag value
    if (i + 1 < execArgv.length) out.push(resolveRuntimePath(execArgv[++i]!, cwd));
  }
  return out;
}

/**
 * True when this process is `bun <entry>` (the dev runtime or a `bun install
 * -g` / `bun link` install running src/cli.ts through its shebang), false for
 * a compiled binary (execPath IS gbrain; the entry is a `/$bunfs/` virtual
 * path, `~BUN` on Windows).
 */
function isScriptRuntime(): boolean {
  const entry = process.argv[1];
  const bunfsEntry = entry !== undefined && (/^\/\$bunfs\//.test(entry) || /[\\/]~BUN[\\/]/.test(entry));
  const devRuntime = /[/\\](bun|node)(\.exe)?$/.test(process.execPath);
  return !bunfsEntry && devRuntime;
}

/**
 * The one line preflight prints for the shape described in "Script mode + cwd
 * bunfig.toml". Exported for tests.
 */
export const SCRIPT_MODE_BUNFIG_WARNING =
  '[env] gbrain is running as a bun script (not the compiled binary) and the bunfig.toml in the current ' +
  'directory declares a top-level preload — Bun ran it before gbrain started. A cwd bunfig.toml is untrusted: ' +
  'run gbrain from a directory you control, or start it as `bun --config=/dev/null <path-to-gbrain/src/cli.ts> …`.';

/**
 * Does `bunfig.toml` in `dir` declare a TOP-LEVEL `preload` (the one Bun
 * applies to `bun <entry>`; a `[test]`-section preload applies to `bun test`
 * only)? Lines before the first `[section]` header are the top level.
 * Fail-quiet: unreadable → false (Bun would have failed on it first).
 */
function bunfigDeclaresTopLevelPreload(dir: string): boolean {
  let text: string;
  try {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- dir is the process's own startup cwd (process.cwd() in runCliPreflight) and the tail is the fixed literal 'bunfig.toml'; read-only probe for a top-level preload declaration
    text = readFileSync(join(dir, 'bunfig.toml'), 'utf-8');
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return false; // first section header: top level ends
    if (/^\s*preload\s*=/.test(line)) return true;
  }
  return false;
}

/** The startup cwd is the checkout that contains the running entry (`<root>/src/cli.ts`). */
function cwdIsOwnCheckout(startupCwd: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(startupCwd) === realpathSync(dirname(dirname(entry)));
  } catch {
    return false;
  }
}

function warnScriptModeBunfig(startupCwd: string): void {
  if (!isScriptRuntime()) return;
  if (!bunfigDeclaresTopLevelPreload(startupCwd)) return;
  if (cwdIsOwnCheckout(startupCwd)) return;
  console.error(SCRIPT_MODE_BUNFIG_WARNING);
}

/**
 * Does this process have a controlling terminal — i.e. will a terminal deliver
 * Ctrl-C to the whole foreground process group (wrapper AND re-run) itself?
 * POSIX: `open("/dev/tty")` succeeds exactly then (ENXIO otherwise), whatever
 * stdin/stdout/stderr are redirected to. Windows has no /dev/tty; the stdio
 * `isTTY` flags are the closest proxy there.
 */
function hasControllingTerminal(): boolean {
  if (process.platform === 'win32') {
    return Boolean(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY);
  }
  try {
    closeSync(openSync('/dev/tty', fsConstants.O_RDONLY | fsConstants.O_NOCTTY));
    return true;
  } catch {
    return false;
  }
}

/**
 * The operator's real home for "HOME after the drop": `os.userInfo().homedir`
 * (Bun: the startup environ's value, passwd when unset — never the merged
 * .env value), then `os.homedir()`. undefined when neither is available
 * (uid-less containers throw from userInfo).
 */
function realHomeDir(): string | undefined {
  try {
    const h = userInfo().homedir;
    if (h) return h;
  } catch {
    // no passwd entry for this uid — fall through
  }
  try {
    return homedir() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A fresh, empty directory that is ours, as an ABSOLUTE canonical path.
 * `tmpdir()` first — it reads TMPDIR/TMP/TEMP at call time, and those are on
 * the protected list, so a value planted by the cwd .env (a relative `t`, a
 * path inside the checkout) is already gone when this runs; the home dir when
 * the temp root is unusable. A mkdtemp dir is new by definition, so neither
 * can hold a .env. `realpathSync` so the marker's `neutral` and the re-run's
 * startup cwd compare canonically even if a caller-exported TMPDIR is
 * relative or a symlink.
 */
function makeNeutralDir(): string {
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-hop-'));
  } catch {
    dir = mkdtempSync(join(homedir(), '.gbrain-hop-'));
  }
  return realpathSync(dir);
}

/** The home variables restored after a drop (see "HOME after the drop"): HOME everywhere, USERPROFILE on Windows. */
const HOME_KEYS: readonly string[] = process.platform === 'win32' ? ['HOME', 'USERPROFILE'] : ['HOME'];

async function reexecSanitized(originalCwd: string, dropped: readonly string[]): Promise<void> {
  const argv = selfArgv(originalCwd);
  if (!argv) return; // in-process view is clean; nothing re-runnable for the descendants' sake
  const neutral = makeNeutralDir();
  // The quarantine already deleted the dropped keys from process.env; they are
  // NOT added back (not even empty — see "Why the re-run") …
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // … except a dropped HOME, which comes back as the operator's REAL home
  // (see "HOME after the drop") — the planted value is still discarded.
  for (const key of HOME_KEYS) {
    if (!dropped.includes(key) || env[key] !== undefined) continue;
    const real = realHomeDir();
    if (real) env[key] = real;
  }
  env[CWD_ENV_QUARANTINED_MARKER] = JSON.stringify({ cwd: originalCwd, neutral, wrapperPid: process.pid } satisfies HopMarker);
  let code: number;
  let signalCode: string | null;
  // See "Signals". Installed BEFORE the spawn; the spawn is synchronous in the
  // same tick, so a handler can only ever run with `child` set.
  let child: ReturnType<typeof Bun.spawn> | null = null;
  const forward = (sig: NodeJS.Signals) => () => {
    try { child?.kill(sig); } catch { /* already exited */ }
  };
  // The wrapper's only job is to relay the child. Any listener an earlier
  // module attached for these signals (cli.ts's cleanup handlers: SIGTERM →
  // exit 143 / SIGHUP → exit 129, installed before main()) would exit the
  // wrapper on its own schedule — before the child has finished and before the
  // neutral dir is removed. Remove them; the forwarders below are the only ones.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.removeAllListeners(sig);
  process.on('SIGTERM', forward('SIGTERM'));
  process.on('SIGHUP', forward('SIGHUP'));
  // controlling terminal: it already delivered Ctrl-C to the child; only outlive it.
  // none: nothing else will deliver it — forward.
  process.on('SIGINT', hasControllingTerminal() ? () => {} : forward('SIGINT'));
  try {
    child = Bun.spawn([process.execPath, ...argv], {
      cwd: neutral,
      env,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    code = await child.exited;
    signalCode = child.signalCode;
  } finally {
    rmSync(neutral, { recursive: true, force: true });
  }
  if (signalCode) {
    const signals = osConstants.signals as Record<string, number | undefined>;
    process.exit(128 + (signals[signalCode] ?? 1)); // shell convention for a signal death
  }
  process.exit(code);
}

/**
 * The refusal printed when a non-empty GBRAIN_GUARDRAILS_MODULE was dropped
 * (see "GBRAIN_GUARDRAILS_MODULE: fail closed, not open"). Exported for tests.
 */
export const GUARDRAILS_ASSIGNED_BY_CWD_DOTENV =
  'guardrails: GBRAIN_GUARDRAILS_MODULE is assigned by a .env file in the current directory; ' +
  "refusing to run without the operator's firewall. Bun merges that file before gbrain starts, " +
  "so a value you exported cannot be told apart from the file's — remove the assignment from the " +
  "project's .env, or run gbrain from a directory that does not assign it. Your own setting " +
  'belongs in your shell environment or in ~/.gbrain/.env (never in a project .env).';

export async function runCliPreflight(): Promise<void> {
  const startupCwd = process.cwd();
  const hop = verifiedHop(startupCwd);
  if (hop) {
    delete process.env[CWD_ENV_QUARANTINED_MARKER]; // never inherited further: a later self-spawn decides for itself
    try {
      process.chdir(hop.cwd);
    } catch (err) {
      console.error(`[env] cannot return to ${hop.cwd} after the sanitized re-run: ${(err as Error)?.message ?? String(err)}`);
      process.exit(1);
    }
    installWrapperWatchdog(hop); // after the chdir: the neutral dir may be removed only from outside it
  } else {
    // Bun applied the STARTUP cwd's bunfig.toml to this process (script mode
    // only); the re-run started in the neutral dir, so it has nothing to say.
    warnScriptModeBunfig(startupCwd);
  }
  const cwd = process.cwd();
  const assignments = parseCwdDotenv(cwd);
  const collision = cwdIsOperatorConfigDir(cwd, assignments);
  if (!hop && !collision) {
    const hadGuardrailsModule = (process.env.GBRAIN_GUARDRAILS_MODULE ?? '').trim() !== '';
    const dropped = quarantineCwdDotenv(process.env, cwd, { assignments });
    if (hadGuardrailsModule && dropped.includes('GBRAIN_GUARDRAILS_MODULE')) {
      console.error(GUARDRAILS_ASSIGNED_BY_CWD_DOTENV);
      process.exit(1);
    }
    if (dropped.length > 0) await reexecSanitized(cwd, dropped);
  }
  loadGbrainEnvFile(configDir);
  if (process.env.GBRAIN_GUARDRAILS_MODULE) {
    try {
      const { loadGuardrailProvidersFromEnv } = await import('./guardrails.ts');
      await loadGuardrailProvidersFromEnv(process.env, { skipCwdCheck: collision });
    } catch (err) {
      console.error(`guardrails: ${(err as Error)?.message ?? String(err)}`);
      process.exit(1);
    }
  }
}
