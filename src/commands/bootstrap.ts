/**
 * `gbrain bootstrap` — the dispatcher tying the bootstrap lane modules into
 * one CLI family (agent-bootstrap plan: D3, G9, B1, CX2-5, A7).
 *
 * Engine discipline (plan D5 + ENG-2): every subcommand except `verify` is
 * ENGINE-FREE — a live `gbrain serve` may hold the PGLite single-writer lock
 * while the human is mid-install, and interview/render/hooks/repo/status/
 * uninstall/attach must keep working. `verify` NEEDS the engine and manages
 * its own connection (the commands/cache.ts pattern: loadConfig →
 * createEngine → connect → finally disconnect) — it runs precisely when no
 * serve is live (pre-registration, or the operator closed sessions for the
 * weekly re-run) [CX2-5].
 *
 * [G9] Mutating subcommands (render/repo/hooks/uninstall/attach) run under
 * the workspace bootstrap mutex; a collision is the typed
 * BOOTSTRAP_IN_PROGRESS refusal the runbook relays.
 *
 * [B1] Every subcommand (except the read-only `status`) appends one line to
 * `<home>/bootstrap/install.jsonl`.
 *
 * [A7] `GBRAIN_BOOTSTRAP_ABORT_AFTER=<phase>` is the deterministic
 * kill-mid-phase seam: after the named phase's main mutation completes (and
 * BEFORE the install-log/receipt finalization) the dispatcher throws — the
 * lifecycle e2e then asserts `bootstrap status` resumes from the artifacts.
 *
 * Every error path prints agent-readable text plus the support hint (the
 * B5 relay instruction), never a stack trace.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { VERSION } from '../version.ts';
import { loadConfig, loadConfigFileOnly, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import { resolveGbrainHome } from '../core/gbrain-home.ts';
import { detectExecutionEnvironment } from '../core/execution-env.ts';
import { realpathOrResolve } from '../core/path-confine.ts';
import { loadQuestionBank } from '../core/bootstrap/assets.ts';
import {
  initState,
  setAnswer,
  skipAnswer,
  status as interviewStatus,
  show as interviewShow,
  confirm as interviewConfirm,
  readBackHash,
  readInterviewState,
  routeProviderKeyToConfig,
} from '../core/bootstrap/interview.ts';
import { renderWorkspace, BootstrapRenderError } from '../core/bootstrap/render.ts';
import { acquireBootstrapLock, BootstrapError } from '../core/bootstrap/lock.ts';
import { createPrivateRepo, defaultRunner, type ExecRunner, type RepoReceipt } from '../core/bootstrap/repo.ts';
import { attachWorkspace } from '../core/bootstrap/attach.ts';
import { uninstallWorkspace } from '../core/bootstrap/uninstall.ts';
import {
  registerClaudeMcp,
  registerCodexMcp,
  writeClaudeHooks,
  writeCommittedClaudeHooks,
  removeClaudeHooks,
} from '../core/bootstrap/hooks.ts';
import {
  guardReceiptOverwrite,
  readHarnessReceiptState,
  readManifest,
  readReceipt,
  writeReceipt,
  type InstallReceipt,
} from '../core/bootstrap/format.ts';
import {
  applyHarness,
  claudePluginProvidesName,
  codexBlockOwnsName,
  codexPluginProvidesName,
  ensureHarnessHome,
  parseHarnessArgs,
  removeHarness,
  statusHarness,
  type HarnessDeps,
} from '../core/bootstrap/harness.ts';
import { claudeUserSettingsPath, codexConfigPath, opencodeConfigDir, opencodeGlobalConfigPath, opencodeProjectConfigPath } from '../core/bootstrap/host-specs.ts';
import {
  opencodeEntryKind,
  opencodeEntrySnippet,
  opencodeRemoteEntryExists,
  parseOpencodeConfig,
  reconcileOpencodeSiblingGlobal,
  removeOpencodeMcpEntry,
  writeOpencodeMcpEntry,
} from '../core/bootstrap/opencode-json.ts';
import { promptLine } from '../core/cli-util.ts';
import {
  appendInstallLog,
  gitOriginUrl,
  probeOriginVisibility,
  statusReport,
  type StatusReport,
} from '../core/bootstrap/status.ts';
import { verifyWorkspace, resolveVerifySourceId, deriveWorkspaceSourceId } from '../core/bootstrap/verify.ts';

export const BOOTSTRAP_HELP = `gbrain bootstrap — paste-in agent install (Claude Code / Codex / opencode)

Usage: gbrain bootstrap <subcommand> [flags]

Subcommands (run \`gbrain bootstrap status\` first — it is the resume entrypoint):
  status [--json]                 Phase list + next action + support blob. The CLI's
                                  phase list is the source of truth the runbook defers to.
  interview --init                Create state/interview.json.
            --set KEY "value"     Record one answer verbatim (never invent answers).
            --skip KEY            Decline an optional question.
            --status              Gate: exits nonzero until required answers exist.
            --show                Read-back payload (all answers + confirm hash).
            --confirm <hash>      Record the human's confirmation of the read-back.
  render [--force] [--only F] [--minimal]
                                  Render identity files from the confirmed answers.
                                  Never clobbers; --force backs up first.
  hooks [--harness claude-code|codex|opencode] [--repair] [--no-hooks] [--gbrain-bin <path>]
                                  Register MCP (+ per-turn hooks on Claude Code,
                                  ON by default; --no-hooks opts out, GBRAIN_HOOKS=0
                                  disables at runtime). opencode registrations are
                                  written directly into its JSONC config (user-global
                                  by default; MCP_SCOPE=project is an explicit opt-in
                                  with a sharing warning).
  repo                            Create the dedicated PRIVATE GitHub repo (or adopt
                                  an EMPTY private repo you created under your own
                                  account), verify the privacy bit via the API, push.
  verify [--json]                 The whole install contract (round-trip, graph floor,
                                  magic moment, scans, hooks smoke). Exit 0 or not done.
  attach [--harness H]            Machine two: adopt a cloned agent workspace.
  harness [--harness claude-code|codex|opencode|all] [--url U | --port N] [--source ID]
          [--token-name NAME | --token TOK] [--name MCPNAME] [--project DIR]...
          [--no-hooks] [--no-capture] [--force] [--status] [--remove] [--yes] [--json]
                                  Wire framework-spawned Claude Code / Codex / opencode
                                  sessions to a RUNNING \`gbrain serve --http\` on this box
                                  (#4043): scoped bearer token, user-scope MCP + headless
                                  pre-approval, lifecycle hooks (user scope, or per --project
                                  dir), codex config block, opencode config entry. No
                                  agent.json needed. Idempotent; --remove tears it down.
                                  (--local is an accepted no-op alias.)
  cloud-setup-script              Print the paste-ready cloud environment setup
                                  script (installs the gbrain binary into the
                                  environment snapshot; npm-based — bun fetching
                                  is proxy-incompatible in cloud sandboxes).
  uninstall [--delete-brain] [--home <dir>] [--yes]
                                  Receipt-keyed removal. The repo stays yours.

Global flags: --workspace <dir> (default: cwd; refuses if the resolved
             path is your home directory — status/uninstall are exempt so
             an existing $HOME install can still be inspected and removed),
             --help.
Env: GBRAIN_BOOTSTRAP_ABORT_AFTER=<phase> (test seam — abort after that phase's work).
`;

const SUPPORT_HINT =
  'If you are stuck: run `gbrain bootstrap status --json` and relay the "support" block verbatim.';

/**
 * Per-subcommand `--help`/`-h`/`help` usage text for the subcommands that
 * MUTATE state (create a repo, register MCP/hooks, run the verify contract,
 * adopt a workspace, remove receipt-tracked paths, record an interview
 * answer). `runBootstrap`'s dispatch checks `args[0]` for top-level help
 * (`--help`/`-h`/`help`/no args), but a help token AFTER the subcommand name
 * (e.g. `gbrain bootstrap repo --help`, `gbrain bootstrap uninstall help`)
 * previously fell straight into the subcommand's own arg parsing, which had
 * no help handling of its own — so it ran the real mutation instead of
 * printing help. `status`/`cloud-setup-script` are pure reads, so they don't
 * need a guard.
 */
const SUBCOMMAND_HELP: Record<string, string> = {
  render:
    'gbrain bootstrap render [--force] [--only F] [--minimal]\n' +
    '  Render identity files from the confirmed interview answers. Never clobbers; --force backs up first.',
  repo:
    'gbrain bootstrap repo\n' +
    '  Create the dedicated PRIVATE GitHub repo (or adopt an EMPTY private repo you created\n' +
    '  under your own account), verify the privacy bit via the API, push.',
  hooks:
    'gbrain bootstrap hooks [--harness claude-code|codex|opencode] [--repair] [--no-hooks] [--gbrain-bin <path>]\n' +
    '  Register MCP (+ per-turn hooks on Claude Code, ON by default; --no-hooks opts out).',
  verify:
    'gbrain bootstrap verify [--json]\n' +
    '  The whole install contract (round-trip, graph floor, magic moment, scans, hooks smoke). Exit 0 or not done.',
  attach:
    'gbrain bootstrap attach [--harness H]\n' +
    '  Machine two: adopt a cloned agent workspace.',
  uninstall:
    'gbrain bootstrap uninstall [--delete-brain] [--home <dir>] [--yes]\n' +
    '  Receipt-keyed removal. The repo stays yours.',
  interview:
    'gbrain bootstrap interview --init | --set KEY "value" | --skip KEY | --status | --show | --confirm <hash>\n' +
    '  Create/record/read interview state. See `gbrain bootstrap --help` for the per-flag description.',
};

/**
 * `--help`/`-h` are always recognized. The bare word `help` (no dashes) is
 * ALSO recognized for every subcommand above EXCEPT `interview` — mirroring
 * the top-level `sub === 'help'` handling for a user who tries the same
 * spelling after a subcommand name. `interview` is excluded from the
 * bare-word form because its `--set KEY "value"` free-text answers could
 * legitimately BE the literal word "help" (e.g. a one-word answer); none of
 * the other subcommands' flags take arbitrary prose, only booleans, enums,
 * or paths, so the bare-word collision risk there is negligible (matches the
 * already-accepted low-impact risk of `-h` colliding with a literal path
 * value like `--home -h`).
 */
function hasHelpToken(args: string[], allowBareWord: boolean): boolean {
  if (args.includes('--help') || args.includes('-h')) return true;
  return allowBareWord && args.includes('help');
}

/** Thrown by the A7 abort seam; mapped to exit 130 (simulated kill). */
export class BootstrapAbortInjected extends Error {
  constructor(phase: string) {
    super(`bootstrap aborted after phase '${phase}' (GBRAIN_BOOTSTRAP_ABORT_AFTER) — re-run and \`gbrain bootstrap status\` resumes from the artifacts`);
    this.name = 'BootstrapAbortInjected';
  }
}

function abortIfInjected(phase: string): void {
  if (process.env.GBRAIN_BOOTSTRAP_ABORT_AFTER === phase) {
    throw new BootstrapAbortInjected(phase);
  }
}

// ── Flag helpers ────────────────────────────────────────────────────────────

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : undefined;
}

function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) {
      out.push(...args[i + 1].split(',').map((s) => s.trim()).filter(Boolean));
    }
  }
  return out;
}

/**
 * SSH sessions frequently land in `$HOME` before the operator `cd`s into a
 * project, and `--workspace` defaults to `process.cwd()` — so an unqualified
 * `gbrain bootstrap` run can silently target the home directory. Bootstrap's
 * later phases stage `git add -A` over the resolved workspace, which is both
 * slow (a home-directory-scale scan has run 50+ minutes in practice) and
 * unsafe (the generated `.gitignore` is not a guaranteed superset of every
 * sensitive dotfile `$HOME` may hold, e.g. `~/.ssh/`). Refuse outright rather
 * than attempt to enumerate every risky path — the fix is a real project
 * directory, not a bigger ignore list [HOME_WORKSPACE].
 *
 * `HOME_WORKSPACE_GUARD_EXEMPT` carves out the subcommands that never do any
 * of that: `status` only reads and prints a report, `uninstall` removes
 * EXACTLY `receipt.created_paths` (each containment-checked, see
 * `core/bootstrap/uninstall.ts`) — never a `git add`/commit/push, never a
 * workspace-wide scan — and `harness` operates only on `home` and never even
 * receives a `ws` argument (`runHarness` — #4043 machine-level wiring), so
 * the value resolved here is used only for `LogCtx.ws` bookkeeping.
 * Exempting `status`/`uninstall` keeps the recovery path reachable for the
 * guard's own victims: someone who already bootstrapped into `$HOME` before
 * this guard existed needs `status` to see what's there and `uninstall` to
 * remove it, both run with `--workspace` pointing AT `$HOME`. Every other
 * subcommand (`interview`/`render`/`repo`/`hooks`/`verify`/`attach`) stages,
 * commits, pushes, or writes identity/registration files into the
 * workspace, so they stay refused.
 */
const HOME_WORKSPACE_GUARD_EXEMPT = new Set(['status', 'uninstall', 'harness']);

function resolveWorkspace(args: string[], sub: string): string {
  const ws = flagValue(args, '--workspace');
  const resolved = ws ? resolve(ws) : process.cwd();
  const resolvedReal = realpathOrResolve(resolved);
  // `os.homedir()` in Bun mirrors `process.env.HOME` as of process start
  // (and ignores LATER `process.env.HOME` mutations — same pattern as
  // `src/core/preferences.ts:home()` / `src/commands/upgrade.ts`) rather
  // than doing an independent OS/uid lookup; a process already launched
  // with HOME pointed away from the real account home is NOT caught by
  // this guard, since both would read back the same overridden value. What
  // this guard DOES cover is the documented real-world trigger — an SSH
  // session whose shell sets HOME normally and whose cwd defaults there
  // before the operator `cd`s into a project — with `homedir()` only as
  // the fallback when HOME is unset. Compared via realpath (not the raw
  // strings) so a symlinked $HOME or a symlinked cwd (e.g. macOS's
  // /var -> /private/var tmp roots) still matches.
  const home = process.env.HOME || homedir();
  if (!HOME_WORKSPACE_GUARD_EXEMPT.has(sub) && home && realpathOrResolve(home) === resolvedReal) {
    throw new BootstrapError(
      'HOME_WORKSPACE',
      `refusing to bootstrap directly into your home directory (${resolved}) — SSH sessions often land here by default. ` +
        'If you already bootstrapped here, `gbrain bootstrap status` and `gbrain bootstrap uninstall` still work ' +
        'directly at $HOME to inspect and remove it; otherwise re-run with `--workspace <dir>` pointing at the ' +
        'project directory you actually want to bootstrap.',
      { details: { candidate: resolved } },
    );
  }
  return resolved;
}

/**
 * POSIX single-quote anything not already shell-safe, for commands printed
 * as copy/paste guidance (mirror of the private `shellQuote` in
 * core/bootstrap/hooks.ts, core/sources-ops.ts, and commands/connect.ts —
 * same contract: `$()`/backticks in a value are inert literals once quoted).
 * A workspace path containing a space or shell metacharacter must not turn
 * "the exact command to run" into a broken (or, pasted blind, dangerous) one.
 */
function shellQuoteForDisplay(arg: string): string {
  if (/^[A-Za-z0-9_.:/@=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ── Shared plumbing ─────────────────────────────────────────────────────────

type Harness = 'claude-code' | 'codex' | 'opencode';

/** Every workspace-lane harness — exhaustive-switch anchors key off this so
 * a future member is a COMPILE error at each dispatch site, not a silent
 * fall-through into another harness's branch (the union-widening trap: a
 * `harness === 'claude-code' ? A : B` ternary routes every new member down
 * B). */
const HARNESSES = ['claude-code', 'codex', 'opencode'] as const satisfies readonly Harness[];

function isHarness(v: string | undefined): v is Harness {
  return (HARNESSES as readonly string[]).includes(v ?? '');
}

/** Best-effort harness auto-detect; the --harness flag always wins.
 * opencode sets OPENCODE=1 (+OPENCODE_PID) in its bash-tool children —
 * verified against opencode 1.18.18 (OPENCODE-CLI-PIN.md §Environment). */
export function detectHarness(env: Record<string, string | undefined> = process.env): Harness | null {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_CI) return 'codex';
  if (env.OPENCODE || env.OPENCODE_PID) return 'opencode';
  return null;
}

/** Absolute gbrain binary path for registrations/hook commands [CX-P1.4].
 * GUI hosts inherit no PATH, so a bare name is never acceptable. */
function resolveGbrainBin(): string | null {
  try {
    const which = Bun.which('gbrain');
    if (which && isAbsolute(which)) return which;
  } catch {
    /* fall through */
  }
  // Compiled-binary case: this process IS the gbrain binary.
  if (basename(process.execPath).startsWith('gbrain')) return process.execPath;
  return null;
}

/**
 * [FIX7] Does the host's existing `gbrain` MCP registration target THIS
 * workspace's serve? An "already exists/registered" error is NOT proof the
 * registration is ours — it could point at a different workspace's binary or
 * a stale/foreign install. Verify via `<host> mcp get <name>` that the command
 * carries both the expected absolute gbrain binary AND GBRAIN_SOURCE=<sourceId>.
 *
 * Returns 'match' (ours), 'mismatch' (points elsewhere — caller re-registers or
 * warns), or 'unknown' (the host has no `mcp get` / empty output — inconclusive,
 * never silently blessed).
 */
async function verifyMcpTargetsWorkspace(
  runner: ExecRunner,
  harness: Harness,
  name: string,
  gbrainBin: string,
  sourceId: string,
): Promise<'match' | 'mismatch' | 'unknown'> {
  // Exec-lane harnesses only. opencode registrations go through the direct
  // JSONC writer whose 4-state fingerprint IS the [FIX7] check (structural,
  // no exec) — it never routes here; 'unknown' keeps a stray call honest.
  const EXEC_HARNESS_BIN = {
    'claude-code': 'claude',
    codex: 'codex',
    opencode: null,
  } as const satisfies Record<Harness, string | null>;
  const bin = EXEC_HARNESS_BIN[harness];
  if (bin === null) return 'unknown';
  let res;
  try {
    res = await runner([bin, 'mcp', 'get', name]);
  } catch {
    return 'unknown';
  }
  if (res.code !== 0) return 'unknown';
  const out = `${res.stdout}\n${res.stderr}`;
  if (out.trim() === '') return 'unknown';
  const hasBin = out.includes(gbrainBin);
  const hasSource = out.includes(`GBRAIN_SOURCE=${sourceId}`);
  return hasBin && hasSource ? 'match' : 'mismatch';
}

/** Wall-clock cap on the best-effort `opencode mcp list` probe: `mcp list`
 * SPAWNS every configured server, and a hung spawn must not hang the install
 * — on timeout the probe child is actually TERMINATED (SIGTERM, then SIGKILL
 * ~2s later) and the result degrades to the could-not-confirm branch (code
 * 124, repo-visibility's raced-runner convention). */
const OPENCODE_PROBE_TIMEOUT_MS = 20_000;

/** Injectable probe-spawn seam (the door serial tests capture argv + cwd +
 * env and fake the child). The default holds the REAL process handle via
 * Bun.spawn — a Promise.race that merely abandons a hung `opencode mcp list`
 * leaves its spawned MCP servers running (including the just-registered
 * `gbrain serve`, which then squats the PGLite single-writer lock) and keeps
 * the CLI's event loop alive past flushThenExit. */
export interface OpencodeProbeHandle {
  exited: Promise<number>;
  kill(force?: boolean): void;
  stdout: Promise<string>;
  stderr: Promise<string>;
  /** Detach the child + its pipes from the event loop (called when the probe
   * gives up on a hung child/grandchild so the CLI can still exit). */
  unref?: () => void;
}
export type OpencodeProbeSpawn = (
  argv: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => OpencodeProbeHandle;

function defaultOpencodeProbeSpawn(
  argv: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
): OpencodeProbeHandle {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exited: proc.exited,
    kill: (force?: boolean) => {
      try {
        proc.kill(force ? 9 : undefined);
      } catch {
        /* already dead */
      }
    },
    stdout: new Response(proc.stdout).text().catch(() => ''),
    stderr: new Response(proc.stderr).text().catch(() => ''),
    unref: () => {
      try {
        proc.unref();
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Run the opencode registration probe with OPENCODE_DISABLE_AUTOUPDATE=1 on
 * the spawn env (OPENCODE-CLI-PIN.md §Probes: the auto-updater must never
 * fire mid-probe) from an explicit `cwd` — callers pass a fresh EMPTY temp
 * dir, never the invoking cwd, because opencode merges a project
 * opencode.json from cwd and spawns its local servers with NO trust prompt
 * (a cloned malicious repo must not get code execution out of an install
 * probe). On timeout the child is killed (SIGTERM → SIGKILL) and the pipes
 * are drained BOUNDED (a spawned MCP-server grandchild can inherit the pipe
 * fds and hold them open past the direct child's death). Exported for the
 * timeout-kill unit test. */
export async function runOpencodeProbe(
  argv: string[],
  opts: { cwd: string; spawn?: OpencodeProbeSpawn; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const spawnFn = opts.spawn ?? defaultOpencodeProbeSpawn;
  const timeoutMs = opts.timeoutMs ?? OPENCODE_PROBE_TIMEOUT_MS;
  const env: Record<string, string | undefined> = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' };
  let handle: OpencodeProbeHandle;
  try {
    handle = spawnFn(argv, { cwd: opts.cwd, env });
  } catch (e) {
    // Bun.spawn throws synchronously when the binary is absent — map to the
    // shell's 127 convention so the caller's not-on-PATH branch fires.
    return { code: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
  // Bounded race helper that never leaves a live timer holding the loop.
  const raceMs = async <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p, new Promise<T>((res) => { timer = setTimeout(() => res(fallback), ms); })]);
    } finally {
      clearTimeout(timer);
    }
  };
  let code = await raceMs<number | null>(handle.exited, timeoutMs, null);
  const timedOut = code === null;
  if (code === null) {
    handle.kill(); // graceful first — opencode tears its servers down on TERM
    code = await raceMs<number | null>(handle.exited, 2_000, null);
    if (code === null) {
      handle.kill(true); // SIGKILL is not refusable; the wait below is paranoia-bounded
      code = await raceMs<number | null>(handle.exited, 2_000, null);
    }
  }
  const drainCap = timedOut ? 2_000 : 5_000;
  const [stdout, stderr] = await Promise.all([
    raceMs(handle.stdout, drainCap, ''),
    raceMs(handle.stderr, drainCap, ''),
  ]);
  if (timedOut || code === null) {
    handle.unref?.(); // a grandchild may still hold the pipes — never hold the CLI's exit
    return { code: 124, stdout, stderr: stderr || `timeout after ${timeoutMs}ms` };
  }
  return { code, stdout, stderr };
}

async function withLock<T>(ws: string, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireBootstrapLock(ws);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}

interface LogCtx {
  home: string;
  ws: string;
  harness?: string;
}

function logPhase(ctx: LogCtx, phase: string, outcome: 'ok' | 'error' | 'aborted', t0: number): void {
  appendInstallLog(ctx.home, {
    ts: new Date().toISOString(),
    phase,
    outcome,
    duration_ms: Date.now() - t0,
    binary_version: VERSION,
    ...(ctx.harness ? { harness: ctx.harness } : {}),
    workspace: ctx.ws,
  });
}

/** Consent answer resolution: persisted interview answer > bank default.
 * An explicitly SKIPPED answer is a DECLINE ('no'), never the bank default —
 * skipping HOOKS_CONSENT (bank default 'yes') must not install hooks. */
function consentAnswer(ws: string, key: string): string | undefined {
  const bank = loadQuestionBank();
  const read = readInterviewState(ws);
  if (read.ok) {
    const a = read.state.answers[key];
    if (a?.skipped === true) return 'no';
    // Shape-tolerant: interview.json is user-editable and readInterviewState
    // validates only that `answers` is an object — a hand-edited unusable
    // value (non-string, empty, or a bare {}) must never throw at a
    // `.toLowerCase()` call site. FAIL CLOSED, loudly: falling through to a
    // permissive bank default could flip a damaged opt-out into consent
    // (cross-model adversarial finding); 'no' resolves every consent key to
    // its safe reading (no hooks, no cron, project scope).
    if (a && typeof a.value === 'string' && a.value) return a.value;
    if (a) {
      console.error(
        `note: the recorded ${key} answer in state/interview.json is unusable (invalid shape) — ` +
          'treating it as declined (fail-closed). Re-record it with `gbrain bootstrap interview` ' +
          'if that is not what you want.',
      );
      return 'no';
    }
  }
  return bank.questions[key]?.default;
}

/** Post-render machine receipt [CX2-1/CX2-12]; preserves an existing same-
 * workspace receipt's ownership fields (mirrors attach.ts). */
function writeRenderReceipt(home: string, ws: string): void {
  const state = readManifest(ws);
  if (state.state !== 'initialized') return;
  // Pre-write guard [CX2-12]: a newer-format receipt refuses (upgrade first);
  // an unreadable one is backed up loudly, never silently clobbered.
  const guard = guardReceiptOverwrite(home);
  if (guard.brokenBackupPath) {
    console.error(`WARNING: the install receipt was unreadable; backed it up to ${guard.brokenBackupPath} and wrote a fresh one.`);
  }
  const manifest = state.manifest;
  const resolvedWs = realpathOrResolve(ws);
  const existing = readReceipt(home);
  const same = existing !== null && realpathOrResolve(existing.workspace_dir) === resolvedWs;
  const receipt: InstallReceipt = {
    receipt_version: 1,
    workspace_dir: resolvedWs,
    source_id: manifest.source_id,
    agent_name: manifest.agent_name,
    created_at: same ? existing.created_at : new Date().toISOString(),
    created_by: `gbrain@${VERSION}`,
    brain_created_by_bootstrap: same ? existing.brain_created_by_bootstrap : false,
    created_paths: same ? existing.created_paths : [],
    registrations: same ? existing.registrations : [],
  };
  // Preserve structural extensions (repo_url) from a prior run.
  const prior = existing as (InstallReceipt & { repo_url?: string }) | null;
  if (same && prior?.repo_url) (receipt as InstallReceipt & { repo_url?: string }).repo_url = prior.repo_url;
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  writeReceipt(home, receipt);
}

function appendReceiptRegistration(
  home: string,
  ws: string,
  reg: { host: Harness; scope: string; detail?: string },
): void {
  // Pre-write guard [CX2-12]: newer-format → refuse; unreadable → loud backup.
  const guard = guardReceiptOverwrite(home);
  if (guard.brokenBackupPath) {
    console.error(`WARNING: the install receipt was unreadable; backed it up to ${guard.brokenBackupPath} and wrote a fresh one.`);
  }
  const existing = readReceipt(home);
  const resolvedWs = realpathOrResolve(ws);
  // Fresh-receipt identity comes from the workspace manifest (source_id may be
  // a collision-derived id like 'workspace-<hash>'), never a hardcoded default.
  const manifest = readManifest(ws);
  const base: InstallReceipt =
    existing !== null && realpathOrResolve(existing.workspace_dir) === resolvedWs
      ? existing
      : {
          receipt_version: 1,
          workspace_dir: resolvedWs,
          source_id: manifest.state === 'initialized' ? manifest.manifest.source_id : 'workspace',
          agent_name: manifest.state === 'initialized' ? manifest.manifest.agent_name : 'agent',
          created_at: new Date().toISOString(),
          created_by: `gbrain@${VERSION}`,
          brain_created_by_bootstrap: false,
          created_paths: [],
          registrations: [],
        };
  const dedup = base.registrations.filter((r) => !(r.host === reg.host && r.scope === reg.scope));
  base.registrations = [...dedup, reg];
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  writeReceipt(home, base);
}

// ── Subcommands ─────────────────────────────────────────────────────────────

async function runStatus(ws: string, rest: string[], home: string): Promise<number> {
  const report: StatusReport = await statusReport(ws, { gbrainHomeDir: home });
  // Template-door privacy gate: PUBLIC origin on a template clone is a hard
  // stop (exit non-zero) — identity files must never land in a public repo.
  const gate = report.privacy_gate;
  if (rest.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    if (gate?.verdict === 'public') {
      console.error(
        `STOP: this template clone's origin (${gate.origin}) is PUBLIC. Make the repository private first ` +
          `(gh repo edit --visibility private --accept-visibility-change-consequences, or the GitHub settings page), then re-run \`gbrain bootstrap status\`.`,
      );
      return 1;
    }
    return 0;
  }
  console.log(`gbrain bootstrap status — ${ws}`);
  for (const p of report.phases) {
    const mark = p.state === 'done' ? 'done   ' : p.state === 'partial' ? 'partial' : p.state === 'skipped' ? 'skipped' : 'pending';
    console.log(`  [${mark}] ${p.id.padEnd(9)} ${p.title}${p.detail ? ` — ${p.detail}` : ''}`);
  }
  if (report.next) {
    console.log(`\nNext: ${report.next}`);
  } else {
    console.log('\nAll phases done. Weekly self-check: `gbrain bootstrap verify` (close agent sessions first — PGLite is single-writer).');
  }
  if (report.runbookSkew) {
    console.log(
      `\nWARNING: runbook stamp ${report.runbookSkew.runbookStamp} != installed binary ${report.runbookSkew.binaryVersion} — ` +
        'prefer the binary; re-fetch the runbook from the latest-stable ref.',
    );
  }
  console.log('\nSupport (relay verbatim when something is broken):');
  console.log(JSON.stringify(report.support, null, 2));
  if (gate?.verdict === 'public') {
    console.error(
      `\nSTOP: this template clone's origin (${gate.origin}) is PUBLIC. Identity files must never land in a ` +
        `public repository. Make it private first (gh repo edit --visibility private ` +
        `--accept-visibility-change-consequences, or the GitHub settings page), then re-run \`gbrain bootstrap status\`.`,
    );
    return 1;
  }
  if (gate?.verdict === 'unknown') {
    console.error(
      `\nWARNING: could not verify the origin's visibility (${gate.detail}). Treat the repository as public ` +
        'until `gh` can verify it — nothing has been pushed; fix gh (install / `gh auth login` / network) and re-run.',
    );
  }
  return 0;
}

/** One copy of the A8 invalidation warning — shared by --set and --skip so
 *  the operator-facing instructions cannot drift between the two branches. */
function warnInvalidatedConfirmation(): void {
  console.error(
    'note: this change voided the prior confirmation — read the full answer set back ' +
    'to the human, then `gbrain bootstrap interview --confirm <hash>` again before render.',
  );
}

async function runInterview(ws: string, rest: string[]): Promise<number> {
  if (rest.includes('--init')) {
    const r = initState(ws);
    if (!r.ok) {
      console.error(r.message);
      return 1;
    }
    console.log(r.created ? `created ${r.path}` : `already present: ${r.path}`);
    // Print the question bank so the runbook agent can ask from the CLI's copy.
    const bank = loadQuestionBank();
    console.log(`\nAsk in batches (${bank.interviewKeys.length} interview keys, required first):`);
    for (const key of bank.interviewKeys) {
      const q = bank.questions[key];
      console.log(`  [batch ${q?.batch ?? '-'}]${q?.required ? ' (required)' : ''} ${key}: ${q?.question ?? ''}`);
    }
    return 0;
  }
  const setIdx = rest.indexOf('--set');
  if (setIdx >= 0) {
    const key = rest[setIdx + 1];
    const value = rest[setIdx + 2];
    if (!key || value === undefined) {
      console.error('usage: gbrain bootstrap interview --set KEY "value"');
      return 2;
    }
    const r = setAnswer(ws, key, value);
    if (!r.ok) {
      console.error(r.message);
      return 1;
    }
    if (r.sink === 'config') {
      // [CX2-13] Config-sink key: route the raw value to the 0600 config file;
      // nothing lands in interview.json, hashes, or logs.
      const routed = routeProviderKeyToConfig(value);
      if (!routed.ok) {
        console.error(routed.message);
        return 1;
      }
      console.log(`${key}: routed to the 0600 config file (${routed.configKey}). Not recorded in interview state.`);
      return 0;
    }
    if (r.invalidatedConfirmation) warnInvalidatedConfirmation();
    console.log(`${key} recorded.`);
    return 0;
  }
  const skipIdx = rest.indexOf('--skip');
  if (skipIdx >= 0) {
    const key = rest[skipIdx + 1];
    if (!key) {
      console.error('usage: gbrain bootstrap interview --skip KEY');
      return 2;
    }
    const r = skipAnswer(ws, key);
    if (!r.ok) {
      console.error(r.message);
      return 1;
    }
    if (r.invalidatedConfirmation) warnInvalidatedConfirmation();
    console.log(`${key} skipped.`);
    return 0;
  }
  if (rest.includes('--status')) {
    const st = interviewStatus(ws);
    if (!st.ok) {
      console.error(st.message);
      return 1;
    }
    console.log(`answered: ${st.answered.join(', ') || '(none)'}`);
    console.log(`skipped:  ${st.skipped.join(', ') || '(none)'}`);
    if (!st.complete) {
      console.log(`missing required: ${st.missingRequired.join(', ')}`);
      return 1; // the gate: nonzero until required answers exist
    }
    const h = readBackHash(ws);
    if (h.ok) {
      console.log(`complete. read-back hash: ${h.hash}`);
      console.log(st.confirmed ? 'confirmed.' : 'NOT confirmed — read every answer back to the human, then `--confirm <hash>`.');
    }
    return 0;
  }
  if (rest.includes('--show')) {
    const r = interviewShow(ws);
    if (!r.ok) {
      console.error(r.message);
      return 1;
    }
    for (const e of [...r.entries, ...r.extras]) {
      const state = e.answered ? `"${e.value}"` : e.skipped ? '(skipped)' : e.default !== undefined ? `(default: "${e.default}")` : '(unanswered)';
      console.log(`${e.required ? '*' : ' '} ${e.key}: ${state}`);
    }
    if (r.hash) console.log(`\nread-back hash: ${r.hash}${r.confirmed ? ' (confirmed)' : ''}`);
    return 0;
  }
  const confirmIdx = rest.indexOf('--confirm');
  if (confirmIdx >= 0) {
    const hash = rest[confirmIdx + 1];
    if (!hash) {
      console.error('usage: gbrain bootstrap interview --confirm <hash from --status/--show>');
      return 2;
    }
    const r = interviewConfirm(ws, hash);
    if (!r.ok) {
      console.error(r.message);
      return 1;
    }
    console.log(`confirmed at ${r.at}.`);
    return 0;
  }
  console.error('usage: gbrain bootstrap interview --init | --set K V | --skip K | --status | --show | --confirm <hash>');
  return 2;
}

async function runRender(ws: string, rest: string[], home: string): Promise<number> {
  const force = rest.includes('--force');
  const minimal = rest.includes('--minimal');
  const only = flagValues(rest, '--only');

  // Public-origin gate [FIX6]: identity files (SOUL.md/USER.md/…) must NEVER
  // land in a public repo. `bootstrap status` enforces this for the template
  // door, but a direct `bootstrap render` could bypass it — so enforce here,
  // BEFORE anything is written. PUBLIC → hard refuse; unknown (no gh /
  // offline / non-GitHub) → warn and proceed (render writes locally; nothing
  // is pushed by render).
  const origin = gitOriginUrl(ws);
  if (origin) {
    const vis = probeOriginVisibility(origin);
    if (vis.verdict === 'public') {
      console.error(
        `render refused: this workspace's origin (${origin}) is PUBLIC. Identity files must never land in a ` +
          `public repository. Make it private first (gh repo edit --visibility private ` +
          `--accept-visibility-change-consequences, or the GitHub settings page), then re-run \`gbrain bootstrap render\`.`,
      );
      console.error(SUPPORT_HINT);
      return 1;
    }
    if (vis.verdict === 'unknown') {
      console.error(
        `WARNING: could not verify the origin's visibility (${vis.detail}). Proceeding with render — ` +
          'treat the repository as public until `gh` can verify it (install gh / `gh auth login` / network); ' +
          'render writes locally and nothing is pushed.',
      );
    }
  }

  // DISPATCHER-LEVEL render gate (the interview module doesn't gate — this
  // dispatcher does): a full non-minimal render requires complete + CONFIRMED
  // answers [A8]. --only re-renders (e.g. repo's GITHUB.md refresh) ride the
  // same gate; --minimal is the deterministic template path and skips it.
  if (!minimal) {
    const st = interviewStatus(ws);
    if (!st.ok) {
      console.error(st.message);
      return 1;
    }
    if (!st.complete || !st.confirmed) {
      console.error(
        'render refused: the interview is ' +
          (!st.complete ? `incomplete (missing: ${st.missingRequired.join(', ')})` : 'complete but NOT confirmed') +
          '. Read the answers back to the human, then `gbrain bootstrap interview --confirm <hash>`.',
      );
      return 1;
    }
  }

  return withLock(ws, async () => {
    const receipt = readReceipt(home) as RepoReceipt | null;
    const derived: Record<string, string> = {};
    if (receipt?.repo_url) derived.GITHUB_REPO_URL = receipt.repo_url;
    try {
      const cfg = loadConfigFileOnly();
      const synth = cfg?.dream?.synthesize as Record<string, unknown> | undefined;
      const days = synth?.corpus_retention_days;
      if (typeof days === 'number' && Number.isFinite(days) && days > 0) {
        derived.CORPUS_RETENTION_DAYS = String(days);
      }
    } catch {
      /* canonical fallback applies */
    }

    // source_id seam [source-id collision]: render is ENGINE-FREE (D5/ENG-2)
    // and the sources registry lives only in the DB, so render cannot detect a
    // 'workspace' id already claimed by another checkout. It therefore passes
    // NO sourceId: render.ts preserves an existing manifest source_id and
    // defaults new manifests to 'workspace'; verify (which holds the engine)
    // detects the collision and persists a derived 'workspace-<hash>' id that
    // every consumer reads back from the manifest.
    const res = renderWorkspace(ws, {
      force,
      ...(only.length > 0 ? { only } : {}),
      minimal,
      derived,
      createdBy: `gbrain@${VERSION}`,
    });

    if (only.length === 0 && !minimal) writeRenderReceipt(home, ws);
    abortIfInjected('render');

    console.log(`rendered: ${res.written.join(', ') || '(nothing new)'}`);
    if (res.skipped.length > 0) console.log(`kept (already present — use --force to overwrite): ${res.skipped.join(', ')}`);
    if (res.backups.length > 0) console.log(`backups: ${res.backups.join(', ')}`);
    return 0;
  });
}

async function runRepo(ws: string, rest: string[], home: string, runner: ExecRunner): Promise<number> {
  void rest;
  return withLock(ws, async () => {
    const result = await createPrivateRepo(ws, { runner, gbrainHomeDir: home });
    const line =
      result.disposition === 'created'
        ? `created private repo: ${result.url}`
        : result.disposition === 'adopted'
          ? `adopted your existing empty private repo: ${result.url}`
          : `verified existing private repo: ${result.url}`;
    console.log(line);

    // Derived-token refresh of GITHUB.md with the real URL (best-effort —
    // createPrivateRepo already replaced the placeholder in place).
    try {
      renderWorkspace(ws, { only: ['GITHUB.md'], force: true, derived: { GITHUB_REPO_URL: result.url } });
    } catch (e) {
      console.error(`note: GITHUB.md re-render skipped (${(e as Error).message}) — the placeholder replacement already applied`);
    }

    abortIfInjected('repo');

    // PERSIST_CRON consent [D3 resolved]: opt-in background persistence via
    // the existing sources-harden machinery — a git post-commit auto-push plus
    // a 30-minute scheduled pull that keeps multi-machine checkouts fresh
    // (honest copy [D9]: the event-driven pushes do the durability work; the
    // timer is the freshener). Best-effort: a harden failure never fails the
    // repo phase — the per-turn and session-end pushes are always on.
    const persist = (consentAnswer(ws, 'PERSIST_CRON') ?? 'no').toLowerCase();
    const envKind = detectExecutionEnvironment();
    if (persist === 'yes') {
      try {
        const { hardenBrainRepo } = await import('../core/brain-repo-durability.ts');
        const state = readManifest(ws);
        const sourceId = state.state === 'initialized' ? state.manifest.source_id : 'workspace';
        // Containers/cloud sandboxes have no reliable scheduler — install the
        // container-friendly half (post-commit hook + helper) and say so,
        // instead of failing a crontab write that could never survive anyway.
        const installCron = envKind === 'local';
        const report = await hardenBrainRepo({
          repoPath: ws,
          sourceId,
          installCron,
          verify: false,
          logger: (l: string) => process.stderr.write(`[harden] ${l}\n`),
        });
        const attention = report.steps.filter((s) => s.status === 'needs_attention');
        if (attention.length > 0) {
          console.log(
            `background persistence partially enabled — needs attention: ${attention.map((s) => `${s.step}: ${s.detail}`).join('; ')}`,
          );
        } else if (installCron) {
          console.log(
            'background persistence enabled (post-commit auto-push + 30-min scheduled pull installed).',
          );
        } else {
          console.log(
            `background persistence enabled for this ${envKind === 'cloud-sandbox' ? 'cloud sandbox' : 'container'}: ` +
              'post-commit auto-push installed; per-turn and session-end pushes are already on. ' +
              'No scheduler exists in this environment, so the 30-min pull is skipped — run ' +
              '`gbrain sources harden` on a persistent machine to add it.',
          );
        }
      } catch (e) {
        console.error(
          `note: background-persistence install failed (${(e as Error).message}). ` +
            'Per-turn and session-end pushes still persist your work; re-try later with `gbrain sources harden`.',
        );
      }
    } else {
      console.log(
        'background persistence declined — the per-turn and session-end pushes remain the persistence backstop.',
      );
    }
    return 0;
  });
}

async function runHooks(
  ws: string,
  rest: string[],
  home: string,
  runner: ExecRunner,
  probeSpawn?: OpencodeProbeSpawn,
): Promise<number> {
  const harnessFlag = flagValue(rest, '--harness');
  const harness = isHarness(harnessFlag) ? harnessFlag : harnessFlag ? null : detectHarness();
  if (!harness) {
    console.error(
      harnessFlag
        ? `unknown --harness '${harnessFlag}' — pass --harness claude-code, codex, or opencode`
        : 'cannot auto-detect the harness — pass --harness claude-code, codex, or opencode',
    );
    return 2;
  }
  // --repair is an idempotent-run alias: the same registration/write path as a
  // first run (marker-keyed dedupe makes re-runs safe); it only changes the log line.
  const repair = rest.includes('--repair');
  // Per-turn hooks are ON by default (installing gbrain-for-your-agent IS the
  // consent — declining defeats the product), so they are no longer prompted.
  // `--no-hooks` is the explicit install-time opt-out; `GBRAIN_HOOKS=0` and
  // `uninstall` are the runtime/after off-ramps.
  const noHooks = rest.includes('--no-hooks');
  // Plugin-lane override: detection reads the plugin-ENABLE config entry,
  // which is not a health signal — a plugin whose launcher can't find the
  // gbrain binary still matches. This flag forces the hand-wired MCP
  // registration through anyway.
  const mcpEvenIfPlugin = rest.includes('--mcp-even-if-plugin');

  const state = readManifest(ws);
  if (state.state !== 'initialized') {
    console.error(
      state.state === 'template'
        ? 'this is an uninitialized template — run `gbrain bootstrap render` first'
        : `not an agent workspace (agent.json ${state.state}) — run \`gbrain bootstrap render\` first`,
    );
    return 1;
  }
  const sourceId = state.manifest.source_id;

  const gbrainBin = flagValue(rest, '--gbrain-bin') ?? resolveGbrainBin();
  if (!gbrainBin) {
    console.error(
      'cannot resolve an absolute gbrain binary path (GUI hosts inherit no PATH) — ' +
        'install gbrain globally (`bun install -g github:garrytan/gbrain#latest-stable`) or pass --gbrain-bin <abs path>',
    );
    return 2;
  }

  // Raw (unbanked) MCP_SCOPE answer — several harness branches need to know
  // whether a human EXPLICITLY chose a scope vs the bank default filling in.
  // typeof guard: readInterviewState validates `answers` is an object but not
  // per-answer shapes — a hand-edited value of 3 must not throw.
  const rawScopeAnswer = (() => {
    const read = readInterviewState(ws);
    const raw = read.ok ? read.state.answers['MCP_SCOPE'] : undefined;
    // .trim(): a hand-edited or sloppily-recorded ' project' must not
    // silently resolve to the user-global default (scope answers are
    // security-relevant on opencode).
    return raw?.skipped !== true && typeof raw?.value === 'string' ? raw.value.trim().toLowerCase() : undefined;
  })();
  // Scope resolution is per-harness (exhaustive switch — see HARNESSES):
  // - claude-code: consent answer, bank default 'project' (the privacy-safe
  //   default: any other repo you open cannot read the brain).
  // - codex: no scope flag exists; the value is ignored (note below).
  // - opencode: default 'user' — OPPOSITE of claude-code, because opencode
  //   spawns project-config-defined servers with NO trust gate (verified,
  //   OPENCODE-CLI-PIN.md §Probes): a committed project entry would auto-spawn
  //   on every collaborator's machine. 'project' only via an EXPLICIT answer
  //   (the sharing warning prints at write time).
  const mcpScope = ((): 'project' | 'user' => {
    switch (harness) {
      case 'claude-code':
        return (consentAnswer(ws, 'MCP_SCOPE') ?? 'project').toLowerCase() === 'user' ? 'user' : 'project';
      case 'codex':
        return 'project'; // ignored — codex registrations are user-global (no scope flag)
      case 'opencode':
        return rawScopeAnswer === 'project' ? 'project' : 'user';
    }
  })();
  // A persisted 'project' answer is meaningless on Codex (`codex mcp add` has no
  // scope flag) — reachable via attach from a Claude Code machine or a pre-fix
  // install. Fires on each hooks/repair run while the stale answer persists.
  // Raw read, NOT consentAnswer: the bank default is 'project', so the resolved
  // value would fire this note on every Codex install where no one was asked.
  if (harness === 'codex') {
    if (rawScopeAnswer === 'project') {
      console.error(
        "note: the recorded MCP_SCOPE answer 'project' has no effect on Codex — " +
          '`codex mcp add` has no scope flag; the registration is user-global (any repo ' +
          'opened on this machine can reach the brain, read and write, through its MCP tools). ' +
          'To clear this note safely, drop the answer with `gbrain bootstrap interview --skip MCP_SCOPE`, ' +
          'then re-confirm the read-back (`--show`, then `--confirm <hash>` — any answer change ' +
          'invalidates the prior confirmation). Do NOT flip it to user: the answer syncs to paired ' +
          'Claude Code machines and would widen their scope. Registration off-ramps: ' +
          '`codex mcp remove gbrain`, or `gbrain bootstrap uninstall` (full teardown).',
      );
    }
  }
  // HOOKS_CONSENT is a silent default (bank: 'yes') — hooks install unless the
  // human explicitly opts out with --no-hooks (or a persisted 'no' answer).
  const hooksConsent = !noHooks && (consentAnswer(ws, 'HOOKS_CONSENT') ?? 'yes').toLowerCase() === 'yes';
  const gbrainHome = process.env.GBRAIN_HOME?.trim() || undefined;

  // One owner per codex server name: if the harness lane's managed TOML block
  // owns [mcp_servers.gbrain], this stdio registration must not fight it —
  // the FIX7 mismatch path would `codex mcp remove` the harness's server and
  // strand orphan marker comments (#4043 ownership rule).
  if (harness === 'codex' && codexBlockOwnsName(codexConfigPath(), 'gbrain')) {
    console.log(
      "the 'gbrain' codex MCP server is managed by `gbrain bootstrap harness` (marker block in the codex " +
        'config) — skipping the stdio registration. Run `gbrain bootstrap harness --remove` first if you ' +
        'want this workspace-lane stdio registration instead.',
    );
    return 0;
  }
  // Same ownership rule, opencode spelling: a REMOTE-type mcp.gbrain in the
  // user-global config is either the harness lane's (inline bearer) or
  // foreign — the stdio lane must not fight it in either case. BOTH global
  // filenames are checked: opencode merges opencode.json AND opencode.jsonc
  // when both exist, so a remote entry in EITHER file owns the name even
  // when the path resolver would pick the other for writing.
  if (
    harness === 'opencode' &&
    mcpScope === 'user' &&
    [join(opencodeConfigDir(), 'opencode.jsonc'), join(opencodeConfigDir(), 'opencode.json')].some((p) =>
      opencodeRemoteEntryExists(p, 'gbrain'),
    )
  ) {
    console.log(
      "the 'gbrain' opencode MCP entry in the user-global config is a remote server (managed by " +
        '`gbrain bootstrap harness`, or foreign) — skipping the stdio registration. Run ' +
        '`gbrain bootstrap harness --remove` first (or remove the entry) if you want this ' +
        'workspace-lane stdio registration instead.',
    );
    return 0;
  }

  return withLock(ws, async () => {
    // 0. source_id visibility seam: `hooks` is the last ENGINE-FREE phase
    // before `verify` (which alone can detect a source_id collision — the
    // sources registry lives only in the DB). Without this, a human who
    // hand-registers a source before verify has no way to know the exact id
    // the workspace expects, guesses an "intuitive" name instead, and only
    // discovers the mismatch via a `verify` roundtrip FK error — then, after
    // switching to the manifest's id, an `overlapping_path` error from the
    // earlier guess still claiming the same brain/ dir. Printing the current
    // id (and the collision-fallback id verify would derive, a pure path
    // hash that needs no engine) up front — plus creating brain/ so
    // registration can happen immediately — collapses that multi-round-trip
    // loop to one command.
    const brainDir = join(ws, 'brain');
    mkdirSync(brainDir, { recursive: true });
    // --force: brain/ was just created empty — `sources add` fail-fasts on a
    // --path that exists but isn't a git repo with committed, tracked
    // content (#2707), and gbrain deliberately never auto-git-inits a --path
    // source itself (a --path source is the user's own directory — the
    // consent boundary #2967 established for sync-time self-heal applies
    // here too). --force is the sanctioned opt-in for exactly this "register
    // before git-init exists" case (see sources-ops.ts's own not_a_git_repo
    // message), and it is safe here because brainDir is not an arbitrary
    // user path — it is the fixed `<workspace>/brain` subdir this phase just
    // created. Without --force, the printed command below would itself throw
    // not_a_git_repo the instant it's pasted.
    const quoted = shellQuoteForDisplay(brainDir);
    console.log(
      `brain source: register this workspace's brain/ now if you haven't — ` +
        `\`gbrain sources add ${sourceId} --path ${quoted} --force\` (brain/ is freshly created and empty; ` +
        `--force is the documented opt-in for registering before git-init exists). If '${sourceId}' is ` +
        `already claimed by a different checkout on this brain, \`gbrain bootstrap verify\` will detect the ` +
        `collision and switch this workspace to '${deriveWorkspaceSourceId(ws)}' — re-run the same command ` +
        `with that id instead.`,
    );

    // 1. MCP registration — argv built by the host-format module, executed
    // through the runner seam, recorded on the receipt.
    // A missing host binary (exit 127) skips MCP registration but NOT the
    // hooks below — hooks only write .claude/settings.local.json and need no
    // binary. The old early-return silently dropped hooks while the copy said
    // only "MCP registration skipped".
    let mcpSkipped = false;
    // Plugin-lane ownership: when the harness's gbrain PLUGIN provides the
    // MCP server, a hand-wired registration would double-register the name.
    // DISTINCT from mcpSkipped (host failure → exit 2, failure-owned
    // receipt): a plugin-owned skip is HEALTHY — exit 0, hooks still
    // install below, receipt records hooks-only ownership. The registration
    // smoke is also skipped (plugin MCP servers are invisible to
    // `codex mcp list` / `mcp get`). No plugin lane exists for opencode.
    // Hoisted above the opencode branch: the receipt step after the
    // exec-lane block needs it in scope.
    const mcpPluginOwned = mcpEvenIfPlugin || harness === 'opencode'
      ? null
      : harness === 'codex'
        ? codexPluginProvidesName(codexConfigPath(), 'gbrain')
        : claudePluginProvidesName(claudeUserSettingsPath(), 'gbrain');
    if (harness === 'opencode') {
      // Direct-writer lane (no exec): registrations land via the JSONC
      // writer whose 4-state fingerprint is the [FIX7] check. Scope resolves
      // to a FILE here — user → global config (absolute binary path),
      // project → committed-candidate opencode.json (PATH-resolved command;
      // no absolute machine paths in a file that travels, and no fail-open
      // analog exists — the sharing warning below is the mitigation).
      const configPath = mcpScope === 'project' ? opencodeProjectConfigPath(ws) : opencodeGlobalConfigPath();
      const command =
        mcpScope === 'project'
          ? ['gbrain', 'serve', '--surface', 'full']
          : [gbrainBin, 'serve', '--surface', 'full'];
      const entry = {
        kind: 'local' as const,
        name: 'gbrain',
        command,
        environment: { GBRAIN_SOURCE: sourceId, ...(gbrainHome ? { GBRAIN_HOME: gbrainHome } : {}) },
      };
      try {
        // [X11] config-dir lock parity with the harness lane: the user-global
        // config is shared across workspaces AND homes, so gbrain writers
        // serialize on ITS directory. The project-scope file lives in the
        // workspace root, which withLock(ws) already holds — the lock is
        // non-reentrant, so the same-dir case skips the nested acquire.
        const ocCfgDir = dirname(configPath);
        let ocLock: { release(): void } | null = null;
        if (resolve(ocCfgDir) !== resolve(ws)) {
          mkdirSync(ocCfgDir, { recursive: true }); // the lock needs the dir; the writer mkdirs later anyway
          ocLock = await acquireBootstrapLock(ocCfgDir);
        }
        let w: ReturnType<typeof writeOpencodeMcpEntry>;
        try {
          // [FIX7] parity: an existing entry pointing at a DIFFERENT workspace
          // is warned about and replaced (same behavior as the exec lanes'
          // mismatch path); a FOREIGN entry refuses inside the writer. The
          // pre-check parse carries the same paste-by-hand snippet the writer
          // uses so a corrupt config never strands the user.
          const existingText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
          const existingKind = opencodeEntryKind(
            parseOpencodeConfig(existingText, configPath, opencodeEntrySnippet(entry)),
            'gbrain',
            { sourceId },
          );
          if (existingKind === 'ours-other-source') {
            console.error(`existing 'gbrain' opencode entry targets a DIFFERENT workspace — replacing it.`);
          }
          // Two-filename merge blind spot: opencode merges BOTH user-global
          // filenames, so a same-name gbrain entry in the SIBLING file would
          // survive this write as a shadow registration. Reconcile it under
          // the same config-dir lock (ours → removed with a note; foreign →
          // refuse loudly naming both files). User scope only — the project
          // file has no observed sibling semantics.
          if (mcpScope === 'user') {
            const sib = reconcileOpencodeSiblingGlobal(configPath, 'gbrain', { sourceId });
            for (const note of sib.notes) console.error(note);
          }
          w = writeOpencodeMcpEntry(configPath, entry, {
            expect: { sourceId },
            allowReplaceOtherSource: true,
          });
        } finally {
          ocLock?.release();
        }
        console.log(
          `MCP registered with opencode (scope: ${mcpScope === 'project' ? 'project (explicit opt-in)' : 'user-global'}) — ` +
            `wrote ${w.configPath}${w.replacedPrior ? ' (replaced prior gbrain entry)' : ''}; ` +
            'restart opencode (config is read at session start).',
        );
        for (const note of w.notes) console.error(note);
        if (mcpScope === 'project') {
          console.error(
            'SHARING WARNING: opencode spawns project-config-defined MCP servers with NO trust prompt — ' +
              'if this opencode.json is committed, every collaborator machine will spawn gbrain (teammates ' +
              'without gbrain see a failing spawn each session; teammates WITH gbrain attach THEIR host ' +
              'brain to this repo). The command is PATH-resolved ("gbrain" — requires gbrain on PATH); ' +
              'the teammate opt-out is `"enabled": false` on the entry. The user-global default avoids all of this.' +
              (gbrainHome
                ? ` Also: the entry embeds this machine's GBRAIN_HOME path (${gbrainHome}) — it won't be portable to other machines.`
                : ''),
          );
        } else if (rawScopeAnswer === undefined) {
          console.log(
            "scope defaulted to user-global — opencode spawns project-defined servers with no trust gate, " +
              'so the committed-file scope is explicit-opt-in only (record MCP_SCOPE=project to choose it).',
          );
        }
      } catch (e) {
        console.error((e as Error).message);
        return 1;
      }
      // Registration smoke: the writer's post-render validation already
      // proved the config parses and carries exactly our entry (that is the
      // authoritative check). Best-effort live probe when the binary is on
      // PATH: `opencode mcp list` SPAWNS servers (the honest discriminator)
      // — run it with --pure (no external plugin autoload; `mcp list` is a
      // code-execution surface otherwise) and skip it entirely when a
      // plugin-bearing config is present (OPENCODE-CLI-PIN.md §Probes).
      try {
        const parsedCfg = parseOpencodeConfig(
          existsSync(configPath) ? readFileSync(configPath, 'utf8') : '',
          configPath,
        );
        if (mcpScope === 'project') {
          // SECURITY: opencode merges the project opencode.json from the
          // probe's cwd and spawns its local servers with NO trust prompt —
          // running `mcp list` inside this workspace would execute whatever
          // the (possibly just-cloned) repo's config names. Parse-back stays
          // the authoritative check; the human runs the live probe.
          console.log(
            'live `opencode mcp list` probe skipped for project scope — config parse-back is authoritative; ' +
              'run `opencode mcp list` yourself in this workspace to confirm.',
          );
        } else if (parsedCfg.plugin !== undefined) {
          console.log('live `opencode mcp list` probe skipped (plugin-bearing config) — config parse-back is the verification.');
        } else {
          // SECURITY: the probe spawns from a fresh EMPTY temp dir, never the
          // invoking cwd — no project opencode.json can load there (the same
          // no-trust-prompt spawn surface as the project-scope skip above).
          const probeCwd = mkdtempSync(join(tmpdir(), 'gbrain-opencode-probe-'));
          let probe: { code: number; stdout: string; stderr: string };
          try {
            probe = await runOpencodeProbe(['opencode', 'mcp', 'list', '--pure'], {
              cwd: probeCwd,
              ...(probeSpawn ? { spawn: probeSpawn } : {}),
            });
          } finally {
            rmSync(probeCwd, { recursive: true, force: true });
          }
          // `mcp list` colorizes when a TTY-ish env leaks through — strip ANSI
          // escapes before matching, and anchor the name on whitespace/EOL so
          // a `gbrain-remote` entry can never satisfy a bare \bgbrain\b (\b
          // matches before the hyphen).
          const plain = probe.stdout.replace(/\u001b\[[0-9;]*m/g, '');
          if (probe.code === 127) {
            console.log('`opencode` is not on PATH — registration written; the config activates when opencode next starts here.');
          } else if (probe.code === 0 && /✓\s+gbrain(\s|$)/.test(plain)) {
            console.log('`opencode mcp list` handshake: ✓ gbrain connected.');
          } else if (probe.code === 0 && /✗\s+gbrain(\s|$)/.test(plain)) {
            console.error(
              'WARNING: `opencode mcp list` reports ✗ gbrain failed — the spawn did not handshake ' +
                '(is the gbrain binary path valid on this machine?). The exit code of `mcp list` is 0 even ' +
                'on failure; this warning is from parsing its output.',
            );
          } else {
            console.log('MCP registration written; could not confirm via `opencode mcp list` (best-effort probe).');
          }
        }
      } catch {
        /* smoke is best-effort */
      }
    } else {
    if (mcpPluginOwned) {
      console.log(
        `the '${mcpPluginOwned}' plugin already provides the gbrain MCP server on ${harness} — ` +
          'skipping the hand-wired MCP registration (one owner per name). The plugin serve is ' +
          `user-global: route this workspace's writes with GBRAIN_SOURCE=${sourceId} (and ` +
          'GBRAIN_BRAIN_ID for mounted brains) in the environment that launches the harness. ' +
          'Note: the plugin being ENABLED is a config signal, not a health signal — if its MCP ' +
          'server is not actually working, either fix the plugin (is the gbrain binary installed?), ' +
          `remove it (\`codex plugin remove gbrain\` / disable it in Claude Code), or force this ` +
          'workspace-bound registration with `--mcp-even-if-plugin`.',
      );
    }
    const argvs = mcpPluginOwned
      ? []
      : harness === 'claude-code'
        ? registerClaudeMcp({ gbrainBin, scope: mcpScope, sourceId, ...(gbrainHome ? { gbrainHome } : {}) })
        : registerCodexMcp({ gbrainBin, sourceId, ...(gbrainHome ? { gbrainHome } : {}) });
    for (const argv of argvs) {
      const mcpName = argv[3] ?? 'gbrain'; // ['<host>','mcp','add',<name>,…]
      const res = await runner(argv);
      if (res.code === 127) {
        console.error(
          `\`${argv[0]}\` is not on PATH — is ${harness} installed? MCP registration skipped ` +
            `(per-turn hooks still install below); re-run ` +
            `\`gbrain bootstrap hooks --harness ${harness}\` once it is.`,
        );
        mcpSkipped = true;
        break;
      }
      if (res.code !== 0) {
        const already = /already exists|already registered/i.test(res.stderr + res.stdout);
        if (!already) {
          console.error(`MCP registration failed (${argv.join(' ')}): ${res.stderr.trim() || `exit ${res.code}`}`);
          return 1;
        }
        // [FIX7] "already registered" is NOT proof the registration is OURS.
        // Verify it targets this workspace's serve; if it points elsewhere,
        // remove + re-add rather than blessing a foreign/stale registration.
        const verdict = await verifyMcpTargetsWorkspace(runner, harness, mcpName, gbrainBin, sourceId);
        if (verdict === 'match') {
          console.log('MCP server already registered for this workspace — kept.');
        } else if (verdict === 'mismatch') {
          console.error(
            `existing '${mcpName}' MCP registration targets a DIFFERENT workspace/binary — replacing it.`,
          );
          // The add above failed "already exists" in the CURRENT scope, so the
          // blocker lives there — target the remove at that scope on Claude
          // Code (a scope-less remove can resolve to a different scope's
          // registration and leave the blocker in place). Codex has no scope
          // flag. Fail loud if the remove doesn't land: the silent no-op loop
          // used to re-fail the add and report nothing actionable.
          const rmArgv =
            harness === 'claude-code'
              ? [argv[0], 'mcp', 'remove', mcpName, '--scope', mcpScope]
              : [argv[0], 'mcp', 'remove', mcpName];
          const rm = await runner(rmArgv);
          if (rm.code !== 0) {
            console.error(
              `\`${rmArgv.join(' ')}\` failed (${rm.stderr.trim() || `exit ${rm.code}`}) — remove the stale ` +
                `registration by hand (\`${argv[0]} mcp get ${mcpName}\` shows where it lives), then re-run ` +
                `\`gbrain bootstrap hooks --harness ${harness} --repair\`.`,
            );
            return 1;
          }
          const re = await runner(argv);
          if (re.code !== 0 && !/already exists|already registered/i.test(re.stderr + re.stdout)) {
            console.error(`MCP re-registration failed (${argv.join(' ')}): ${re.stderr.trim() || `exit ${re.code}`}`);
            return 1;
          }
          // Re-add can itself return "already exists" if a racing writer
          // re-claimed the name between our remove and add — that registration
          // is NOT ours. Re-verify and abort rather than bless a foreign
          // endpoint that would intercept memory ops. (Only the recorded
          // warn-then-continue step-2 smoke did this before; here it's fatal.)
          const post = await verifyMcpTargetsWorkspace(runner, harness, mcpName, gbrainBin, sourceId);
          if (post === 'mismatch') {
            console.error(
              `after replacing '${mcpName}', it STILL targets a different workspace/binary — ` +
                `refusing to continue (a racing registration may have re-claimed the name). ` +
                `Inspect \`${argv[0]} mcp get ${mcpName}\`, remove it by hand, then re-run ` +
                `\`gbrain bootstrap hooks --harness ${harness} --repair\`.`,
            );
            return 1;
          }
        } else {
          console.log(
            `MCP server '${mcpName}' already registered — could not confirm it targets this workspace ` +
              `(\`${argv[0]} mcp get ${mcpName}\` to inspect); kept.`,
          );
        }
      }
    }

    // 2. Registration smoke [FIX7]: confirm the EXPECTED server (binary path +
    // GBRAIN_SOURCE), not merely a 'gbrain' substring in `mcp list`. Falls back
    // to the list probe only when the host has no `mcp get`. Plugin-owned
    // installs skip it: plugin MCP servers never appear in `mcp get`/`list`,
    // so the smoke would report a spurious mismatch.
    if (!mcpSkipped && !mcpPluginOwned) try {
      const listBin = harness === 'claude-code' ? 'claude' : 'codex';
      const scopeLabel = harness === 'claude-code' ? mcpScope : 'user-global';
      const verdict = await verifyMcpTargetsWorkspace(runner, harness, 'gbrain', gbrainBin, sourceId);
      if (verdict === 'match') {
        console.log(`MCP registered with ${harness} (scope: ${scopeLabel}) — verified targeting this workspace.`);
      } else if (verdict === 'mismatch') {
        console.error(
          `WARNING: \`${listBin} mcp get gbrain\` does not show this workspace's serve ` +
            `(binary/source mismatch) — re-run \`gbrain bootstrap hooks --harness ${harness} --repair\`.`,
        );
      } else {
        const probe = await runner([listBin, 'mcp', 'list']);
        if (probe.code === 0 && /\bgbrain\b/.test(probe.stdout)) {
          console.log(
            `MCP registration submitted (server 'gbrain' present; full target unverified — ` +
              `\`${listBin} mcp get gbrain\` to inspect).`,
          );
        } else {
          console.log(`MCP registration submitted; could not confirm via \`${listBin} mcp list\` (best-effort probe).`);
        }
      }
    } catch {
      /* smoke is best-effort */
    }
    } // end exec-lane registration (claude-code / codex)

    // 3. Hooks (Claude Code only, consent-gated).
    let hooksWritten = false;
    if (harness === 'claude-code') {
      if (hooksConsent) {
        // Carrier choice [D12]: cloud sandboxes clone fresh and snapshot hook
        // config at session start — only the repo-COMMITTED settings file
        // exists there, so cloud installs write the committed carrier
        // (PATH-resolved, fail-open commands; no machine paths). Local
        // installs keep the gitignored settings.local.json with the absolute
        // binary path. The writers enforce that one event never fires from
        // both files.
        const hookEnv = { GBRAIN_SOURCE: sourceId, ...(gbrainHome ? { GBRAIN_HOME: gbrainHome } : {}) };
        const cloudCarrier = detectExecutionEnvironment() === 'cloud-sandbox';
        let r: ReturnType<typeof writeClaudeHooks> | ReturnType<typeof writeCommittedClaudeHooks>;
        try {
          r = cloudCarrier
            ? writeCommittedClaudeHooks(ws, { env: hookEnv })
            : writeClaudeHooks(ws, { gbrainBin, env: hookEnv });
        } catch (e) {
          // Fail-closed on an unparseable settings file (either carrier): MCP
          // (step 1) still landed; record that, surface the fix, and exit
          // nonzero so the paste-in flow knows hooks are NOT installed.
          console.error((e as Error).message);
          if (!mcpSkipped) {
            appendReceiptRegistration(home, ws, { host: harness, scope: mcpScope, detail: 'mcp' });
          }
          return 1;
        }
        hooksWritten = true;
        console.log(
          `hooks installed (${r.installed.length} event(s)) in ${r.settingsPath}${repair ? ' [repair]' : ''} — your brain now loads every turn. Turn off any time with GBRAIN_HOOKS=0, or re-run with --no-hooks.`,
        );
        if (cloudCarrier) {
          console.log(
            'cloud sandbox: hooks written to the COMMITTED .claude/settings.json (fail-open, PATH-resolved) — ' +
              'commit + push it so the next session starts with hooks live; hooks written mid-session activate on the NEXT session (startup snapshot).',
          );
        }
        for (const note of r.notes) console.error(note);
      } else {
        console.log(
          noHooks
            ? 'hooks skipped (--no-hooks) — the AGENTS.md pull protocol covers per-turn context instead; re-enable with `gbrain bootstrap hooks --harness claude-code`.'
            : 'hooks declined (HOOKS_CONSENT set to no) — the AGENTS.md pull protocol covers per-turn context instead; re-enable with `gbrain bootstrap hooks --harness claude-code`.',
        );
      }
    } else if (harness === 'codex') {
      console.log('gbrain does not wire Codex hooks yet — per-turn context is the AGENTS.md pull protocol (stated plainly; the codex hook lane is a filed follow-up).');
    } else {
      console.log(
        'gbrain does not wire opencode\'s plugin/event system yet — per-turn context is the AGENTS.md ' +
          'pull protocol, which opencode loads natively (the opencode plugin lane is a filed follow-up).',
      );
    }

    // 4. Receipt registration record [CX2-12]. Detail records what actually
    // landed; nothing landed at all (127 + no hooks) → no receipt entry.
    // Plugin-owned installs record hooks-only ownership ('hooks+plugin-mcp')
    // or, when nothing was written by us at all (codex has no hooks), a bare
    // 'plugin-mcp' marker so status/uninstall know the MCP owner is the
    // plugin, not a missing registration.
    if (mcpPluginOwned) {
      appendReceiptRegistration(home, ws, {
        host: harness,
        scope: harness === 'claude-code' ? mcpScope : 'user',
        detail: hooksWritten ? 'hooks+plugin-mcp' : 'plugin-mcp',
      });
    } else if (!mcpSkipped || hooksWritten) {
      const receiptScope = ((): string => {
        switch (harness) {
          case 'claude-code':
            return mcpScope;
          case 'codex':
            return 'user'; // codex registrations are always user-global
          case 'opencode':
            return mcpScope; // user default; project only via explicit opt-in
        }
      })();
      appendReceiptRegistration(home, ws, {
        host: harness,
        scope: receiptScope,
        detail: hooksWritten ? (mcpSkipped ? 'hooks' : 'mcp+hooks') : 'mcp',
      });
    }

    abortIfInjected('wire');
    return mcpSkipped ? 2 : 0;
  });
}

async function runVerify(ws: string, rest: string[], home: string): Promise<number> {
  const jsonMode = rest.includes('--json');
  const cfg = loadConfig();
  if (!cfg) {
    console.error('no brain configured — run `gbrain init --pglite` first (the engine phase).');
    console.error(SUPPORT_HINT);
    return 1;
  }
  // verify manages its own engine (commands/cache.ts pattern) — it must be
  // importable while the rest of the bootstrap family stays engine-free.
  const engineConfig = toEngineConfig(cfg);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    // #4328 — initialized manifest wins; uninit resolves via the standard source chain (never the unregistered 'workspace' literal, whose probe writes died on the sources FK).
    const sourceId = await resolveVerifySourceId(engine, ws);
    const result = await verifyWorkspace(engine, ws, { sourceId, gbrainHomeDir: home });
    if (jsonMode) {
      console.log(JSON.stringify({ ok: result.ok, checks: result.checks, capability: result.capability, tour: result.tour, handoff: result.handoff }, null, 2));
    } else {
      console.log(result.report);
    }
    abortIfInjected('verify');
    return result.ok ? 0 : 1;
  } finally {
    try {
      await engine.disconnect();
    } catch {
      /* best effort */
    }
  }
}

async function runAttach(ws: string, rest: string[], home: string): Promise<number> {
  const harness = (flagValue(rest, '--harness') as Harness | undefined) ?? detectHarness() ?? 'claude-code';
  return withLock(ws, async () => {
    const res = attachWorkspace(ws, { harness, gbrainHomeDir: home, createdBy: `gbrain@${VERSION}` });
    abortIfInjected('attach');
    console.log(`attached workspace for agent "${res.manifest.agent_name}" (source '${res.manifest.source_id}'). Receipt written.`);
    console.log('\nRemaining steps (attach validates + records; run these next):');
    const brainDir = join(ws, 'brain');
    const commands: Record<string, string> = {
      register_source: `gbrain sources add ${res.manifest.source_id} --path ${brainDir}`,
      hooks_repair: `gbrain bootstrap hooks --harness ${harness} --repair`,
      mcp_add: `(covered by the hooks step — MCP registration rides it)`,
      verify: 'gbrain bootstrap verify',
    };
    res.steps.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.description}`);
      console.log(`     → ${commands[s.kind] ?? ''}`);
    });
    return 0;
  });
}

/** Engine-free brain stats for the --delete-brain confirm text: counts the
 * write-through .md files under `<ws>/brain` (the committed mirror of the DB —
 * a floor, since DB-only pages have no file) and names the workspace source
 * from the manifest. Never opens the engine (uninstall must work while a live
 * serve holds the PGLite lock refusal path). Exported for direct tests. */
export function workspaceBrainStats(ws: string): { sources: string[]; pages: number } | null {
  const brainDir = join(ws, 'brain');
  let pages = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.md')) pages++;
    }
  };
  try {
    walk(brainDir, 0);
  } catch {
    return null; // no brain/ dir readable — the module falls back to its receipt-only text
  }
  const manifest = readManifest(ws);
  const sources = manifest.state === 'initialized' ? [manifest.manifest.source_id] : ['workspace'];
  return { sources, pages };
}

/** `gbrain bootstrap harness` (#4043) — machine-level, no workspace, no
 * agent.json. Locks on the gbrain HOME (there is no workspace to lock). */
async function runHarness(rest: string[], home: string, runner: ExecRunner): Promise<number> {
  const flags = parseHarnessArgs(rest);
  if (flags.error) {
    console.error(flags.error);
    return 2;
  }
  const deps: HarnessDeps = {
    runner,
    gbrainHome: home,
    // Fallback only — the flag itself is parsed (and error-checked) once, by
    // parseHarnessArgs; flags.gbrainBin wins inside applyHarness.
    gbrainBin: resolveGbrainBin(),
    isTTY: process.stdout.isTTY === true,
    prompt: promptLine,
  };
  // [X12] --status is READ-ONLY: no home mkdir, no lock — it must work (and
  // stay side-effect-free) even while an apply/remove holds the mutex.
  if (flags.status) {
    return statusHarness(flags, deps);
  }
  ensureHarnessHome(home);
  return withLock(home, async () => {
    if (flags.remove) {
      const code = await removeHarness(flags, deps);
      abortIfInjected('harness');
      return code;
    }
    const code = await applyHarness(flags, deps);
    abortIfInjected('harness');
    return code;
  });
}

async function runUninstall(ws: string, rest: string[], home: string, runner: ExecRunner): Promise<number> {
  const deleteBrain = rest.includes('--delete-brain');
  const yes = rest.includes('--yes');
  const homeFlag = flagValue(rest, '--home');
  const effectiveHome = homeFlag ? resolve(homeFlag) : home;
  return withLock(ws, async () => {
    // The HOME lock (runHarness's mutex) is held across the ENTIRE uninstall
    // body — not just the harness-removal step — so a concurrent
    // `bootstrap harness` apply can never mint+wire in the window between
    // harness removal and the workspace teardown's rm of <home>/bootstrap
    // (which would strand a fresh receipt + live wiring). Consistent order
    // (ws → home), distinct dirs, so no deadlock; same-dir configs skip the
    // nested acquire (the lock is non-reentrant).
    const body = async (): Promise<number> => {
    // Harness wiring is removed FIRST (#4043 ordering, load-bearing twice
    // over: the token revoke needs the DB alive, and --delete-brain rmSyncs
    // <home>/bootstrap — which would destroy harness.json unconsumed).
    const harnessState = readHarnessReceiptState(effectiveHome);
    let harnessRemoved = false;
    if (harnessState.state !== 'absent') {
      console.log('harness wiring detected — removing it first (token revoke needs the brain alive).');
      const flags = parseHarnessArgs(['--remove', ...(yes ? ['--yes'] : [])]);
      const code = await removeHarness(flags, { runner, gbrainHome: effectiveHome });
      if (code !== 0) {
        console.error(
          'harness removal did not fully converge — stopping BEFORE workspace teardown so the harness ' +
            'receipt is never stranded. Fix the reported issue (or stop the live serve) and re-run.',
        );
        return 1;
      }
      harnessRemoved = true;
    }

    if (deleteBrain) {
      // Facts-export offer BEFORE any deletion can run — facts are user
      // knowledge, not derived state; after the rm there is nothing to export.
      console.log(
        'offered: export facts before deletion (`gbrain facts export`) — the brain DB is about to be removed and facts are not derived state',
      );
    }
    // Read the source id BEFORE uninstallWorkspace removes rendered files —
    // the durability teardown below needs it and the manifest may not survive.
    const preState = readManifest(ws);
    const durabilitySourceId = preState.state === 'initialized' ? preState.manifest.source_id : 'workspace';
    let result;
    try {
      result = await uninstallWorkspace(ws, {
        deleteBrain,
        ...(yes ? { confirm: async () => true } : {}),
        gbrainHomeDir: effectiveHome,
        homeExplicit: homeFlag !== undefined,
        brainStats: async () => workspaceBrainStats(ws),
      });
    } catch (e) {
      // A harness-only box has machine-level wiring but no workspace install:
      // the pre-teardown refusals that mean "this workspace isn't the
      // bootstrapped one" end the run as success once harness removal ran.
      // LIVE_SERVE and everything else stay hard refusals.
      if (
        harnessRemoved &&
        e instanceof BootstrapError &&
        (e.code === 'NO_RECEIPT' || e.code === 'HOME_GUARD' || e.code === 'RECEIPT_MISMATCH')
      ) {
        console.log(`no workspace install on this machine (naming the refusal: ${e.code}); harness wiring removed.`);
        abortIfInjected('uninstall');
        return 0;
      }
      throw e;
    }

    // Execute the structured host-registration removals the module returned.
    for (const reg of result.registration_removals) {
      // Plugin-owned registrations were NEVER created by us (the plugin
      // provides the MCP server; bootstrap only recorded a hooks-only
      // receipt). Running `mcp remove gbrain` here would delete whatever
      // registration DOES own the name — e.g. a hand-wired `codex mcp add`
      // or `gbrain connect --install` the user added later. Remove only the
      // hooks half for these; leave the MCP owner alone. (No opencode plugin
      // lane exists, so the guard is inert for that host.)
      const pluginOwned = typeof reg.detail === 'string' && reg.detail.endsWith('plugin-mcp');
      switch (reg.host) {
        case 'claude-code': {
          const r = removeClaudeHooks(ws);
          if (r.removed > 0) console.log(`removed ${r.removed} gbrain hook entr${r.removed === 1 ? 'y' : 'ies'} from ${r.settingsPath}`);
          for (const note of r.notes) console.error(note);
          if (pluginOwned) {
            console.log('MCP server was provided by the gbrain plugin (not registered by bootstrap) — leaving it; `claude plugin uninstall gbrain@gbrain` removes the plugin.');
            break;
          }
          const rm = await runner(['claude', 'mcp', 'remove', 'gbrain']);
          if (rm.code !== 0) console.error('note: `claude mcp remove gbrain` did not succeed — remove it by hand if it lingers.');
          break;
        }
        case 'codex': {
          if (pluginOwned) {
            console.log('MCP server was provided by the gbrain plugin (not registered by bootstrap) — leaving it; `codex plugin remove gbrain@gbrain` removes the plugin.');
            break;
          }
          const rm = await runner(['codex', 'mcp', 'remove', 'gbrain']);
          if (rm.code !== 0) console.error('note: `codex mcp remove gbrain` did not succeed — remove it by hand if it lingers.');
          break;
        }
        case 'opencode': {
          // Direct-writer removal (fingerprint-keyed; foreign entries refuse
          // inside the module). Every candidate file best-effort — the
          // receipt's scope names where the registration landed, but a stale
          // entry in another file costs nothing to sweep. BOTH global
          // filenames are swept: opencode merges opencode.json AND
          // opencode.jsonc when both exist, so sweeping only the resolver's
          // pick would strand a gbrain entry in the other file. The removal
          // is expectation-keyed on THIS workspace's source id — a gbrain
          // entry from a DIFFERENT workspace is skipped with a note, never
          // silently deleted (it is not this uninstall's to remove).
          const sweep = (p: string): void => {
            try {
              const r = removeOpencodeMcpEntry(p, 'gbrain', { sourceId: durabilitySourceId }, { skipOtherSource: true });
              if (r.removed) console.log(`removed the gbrain opencode MCP entry from ${p}`);
              for (const note of r.notes) console.error(note);
            } catch (e) {
              console.error(`note: could not remove the gbrain opencode entry from ${p}: ${(e as Error).message}`);
            }
          };
          // Global files run under the config-dir bootstrap lock (the writer
          // contract; harness.ts [X11] parity). Only when the dir exists — no
          // dir means no config, and uninstall must not create one just to
          // lock it.
          const ocDir = opencodeConfigDir();
          const globals = [join(ocDir, 'opencode.jsonc'), join(ocDir, 'opencode.json')].filter((p) => existsSync(p));
          if (globals.length > 0) {
            try {
              const ocLock = await acquireBootstrapLock(ocDir);
              try {
                for (const p of globals) sweep(p);
              } finally {
                ocLock.release();
              }
            } catch (e) {
              console.error(`note: could not lock the opencode config dir (${(e as Error).message}) — entries left for a re-run.`);
            }
          }
          // The project file's dir IS the workspace, which withLock(ws)
          // already holds — the lock is non-reentrant, so no nested acquire.
          sweep(opencodeProjectConfigPath(ws));
          break;
        }
      }
    }

    // Per-root hook-lane state [D13]: remove this workspace's push-status,
    // debounce, and announce files — a dead root's failing record would
    // otherwise re-fire the failure banner forever (it can never be cleared
    // by a re-push once the workspace is gone).
    try {
      const { pushStatusPathForRoot, workspaceRootHash } = await import('../core/workspace-push.ts');
      const { execFileSync } = await import('node:child_process');
      let root = ws;
      try {
        root = execFileSync('git', ['-C', ws, 'rev-parse', '--show-toplevel'], {
          stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, env: process.env,
        }).toString().trim() || ws;
      } catch { /* not a repo — use ws as-is */ }
      const { rmSync } = await import('node:fs');
      const statusFile = pushStatusPathForRoot(root);
      for (const f of [statusFile, `${statusFile}.announced`, join(resolveGbrainHome(), 'bootstrap', `stop-push-${workspaceRootHash(root)}.json`)]) {
        rmSync(f, { force: true });
      }
    } catch { /* best-effort */ }

    // Durability teardown [B6]: uninstall previously left the launchd/cron
    // job, the untracked post-commit hook, and the credential wiring behind.
    // Best-effort — a teardown hiccup never fails the uninstall. The COMMITTED
    // helper script and AGENTS.md rules stay (repo content is the user's).
    try {
      const { unhardenBrainRepo } = await import('../core/brain-repo-durability.ts');
      const steps = await unhardenBrainRepo({ repoPath: ws, sourceId: durabilitySourceId });
      const acted = steps.filter((s) => s.status === 'fixed');
      if (acted.length > 0) {
        console.log(`durability wiring removed: ${acted.map((s) => s.step).join(', ')} (committed helper + AGENTS rules stay — repo content is yours)`);
      }
    } catch (e) {
      console.error(`note: durability teardown incomplete (${(e as Error).message}) — run \`gbrain sources unharden ${durabilitySourceId}\` by hand if a scheduled job lingers.`);
    }

    // The facts-export offer already printed BEFORE deletion (above); don't
    // repeat it after the brain is gone.
    for (const step of result.steps) {
      if (step.kind === 'facts_export_offer') continue;
      console.log(`offered: ${step.description}`);
    }
    console.log(`removed paths: ${result.removed_paths.join(', ') || '(none)'}`);
    for (const s of result.skipped_paths) console.log(`kept ${s.path} (${s.reason})`);
    console.log(`brain ${result.brain_deleted ? 'DELETED' : 'kept'}; receipt ${result.receipt_removed ? 'consumed' : 'kept'}.`);
    console.log('The workspace repo and its files remain yours — the body is portable by design.');
    abortIfInjected('uninstall');
    return 0;
    };
    return resolve(effectiveHome) === resolve(ws) ? body() : withLock(effectiveHome, body);
  });
}

// ── Entry point ─────────────────────────────────────────────────────────────

export interface RunBootstrapOpts {
  /** Exec seam for gh/claude/codex subprocesses (tests inject a recorder). */
  runner?: ExecRunner;
  /** Spawn seam for the opencode `mcp list` probe (tests capture argv, cwd,
   * and env; the default holds a real Bun.spawn handle so timeouts kill). */
  probeSpawn?: OpencodeProbeSpawn;
}

/** Dispatch. Returns the process exit code (cli.ts passes it to setCliExitVerdict). */
export async function runBootstrap(args: string[], opts: RunBootstrapOpts = {}): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(BOOTSTRAP_HELP);
    return 0;
  }
  const rest = args.slice(1);

  const KNOWN = new Set(['status', 'interview', 'render', 'repo', 'hooks', 'verify', 'attach', 'uninstall', 'harness', 'cloud-setup-script']);
  if (!KNOWN.has(sub)) {
    console.error(`unknown subcommand: ${sub}`);
    console.error(BOOTSTRAP_HELP);
    return 2;
  }

  // Subcommand-level help: BEFORE any subcommand body runs, so a help token
  // after a mutating subcommand (repo/hooks/verify/attach/uninstall/render/
  // interview) never falls through into the real operation, regardless of
  // what other flags/values precede it in `rest`. No install-log entry
  // either — this isn't a phase run.
  if (Object.hasOwn(SUBCOMMAND_HELP, sub) && hasHelpToken(rest, sub !== 'interview')) {
    // Object.hasOwn: a plain-object lookup resolves inherited keys, so
    // `bootstrap constructor --help` would print Object.prototype.constructor.
    console.log(SUBCOMMAND_HELP[sub]);
    return 0;
  }

  if (sub === 'cloud-setup-script') {
    // Pure print [D16]: the paste-ready cloud environment setup script.
    // Resolved BEFORE workspace resolution (below) — it reads/writes no
    // workspace, so it must keep working from any cwd, including $HOME; the
    // HOME_WORKSPACE guard only applies to subcommands that actually touch
    // one. Read surface like status — no install log entry. Own try/catch
    // (this used to run inside the main dispatcher try/catch below) so an
    // asset-load failure still returns exit 1 with the usual message +
    // support hint instead of throwing out of runBootstrap() and breaking
    // its "always returns an exit code" contract.
    try {
      const { loadCloudSetupScript } = await import('../core/bootstrap/assets.ts');
      console.log(loadCloudSetupScript().trimEnd());
      return 0;
    } catch (e) {
      console.error(`bootstrap ${sub} failed: ${e instanceof Error ? e.message : String(e)}`);
      console.error(SUPPORT_HINT);
      return 1;
    }
  }

  const home = resolveGbrainHome();
  const t0 = Date.now();
  // The install log records the PHASE name, and the hooks subcommand is the
  // 'wire' phase (status.ts phase list) — one mapping, used at every log site.
  // 'harness' is its own log phase (NOT a status.ts phase — that list is
  // CI-pinned; install.jsonl phase names are free-form telemetry).
  const logPhaseName = sub === 'hooks' ? 'wire' : sub;

  let ws: string;
  try {
    ws = resolveWorkspace(rest, sub);
  } catch (e) {
    if (e instanceof BootstrapError) {
      console.error(e.message);
      console.error(SUPPORT_HINT);
      // Still attribute the refusal to this machine's install log, keyed by
      // the CANDIDATE path the guard rejected (there is no confirmed
      // workspace to log against otherwise) — same audit trail every other
      // BootstrapError gets from the catch below.
      const candidate = typeof e.details.candidate === 'string' ? e.details.candidate : rest.join(' ');
      logPhase({ home, ws: candidate }, logPhaseName, 'error', t0);
      return e.exitCode;
    }
    throw e;
  }
  const runner = opts.runner ?? defaultRunner;
  const harnessForLog = flagValue(rest, '--harness') ?? detectHarness() ?? undefined;
  const logCtx: LogCtx = { home, ws, ...(harnessForLog ? { harness: harnessForLog } : {}) };

  try {
    let code: number;
    switch (sub) {
      case 'status':
        // status is the read surface — it does not log itself into install.jsonl.
        return await runStatus(ws, rest, home);
      case 'interview':
        code = await runInterview(ws, rest);
        break;
      case 'render':
        code = await runRender(ws, rest, home);
        break;
      case 'repo':
        code = await runRepo(ws, rest, home, runner);
        break;
      case 'hooks':
        code = await runHooks(ws, rest, home, runner, opts.probeSpawn);
        break;
      case 'verify':
        code = await runVerify(ws, rest, home);
        break;
      case 'attach':
        code = await runAttach(ws, rest, home);
        break;
      case 'uninstall':
        code = await runUninstall(ws, rest, home, runner);
        break;
      case 'harness':
        code = await runHarness(rest, home, runner);
        break;
      default:
        return 2; // unreachable
    }
    logPhase(logCtx, logPhaseName, code === 0 ? 'ok' : 'error', t0);
    return code;
  } catch (e) {
    if (e instanceof BootstrapAbortInjected) {
      // [A7] Simulated kill: artifacts from the phase exist, the finalize
      // (install log 'ok' line) never ran — exactly the crash shape status
      // must resume from. The log records the abort for the post-mortem.
      logPhase(logCtx, logPhaseName, 'aborted', t0);
      console.error(e.message);
      return 130;
    }
    if (e instanceof BootstrapError) {
      console.error(e.message);
      console.error(SUPPORT_HINT);
      logPhase(logCtx, logPhaseName, 'error', t0);
      return e.exitCode;
    }
    if (e instanceof BootstrapRenderError) {
      console.error(e.message);
      console.error(SUPPORT_HINT);
      logPhase(logCtx, logPhaseName, 'error', t0);
      return 1;
    }
    console.error(`bootstrap ${sub} failed: ${e instanceof Error ? e.message : String(e)}`);
    console.error(SUPPORT_HINT);
    logPhase(logCtx, logPhaseName, 'error', t0);
    return 1;
  }
}
