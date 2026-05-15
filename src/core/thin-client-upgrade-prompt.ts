/**
 * v0.31.11 (Issue: thin-client auto-upgrade): when a thin-client install detects
 * that the remote `gbrain serve --http` host is running a newer version (minor
 * or major drift), prompt the user interactively to run `gbrain upgrade`.
 *
 * Hook seam: called from `printIdentityBannerBestEffort` in `src/cli.ts` after
 * the banner prints. The function short-circuits in every non-applicable case
 * so the banner code stays a thin caller.
 *
 * Eng-review-locked invariants (D1-D8 in plan):
 * - D1 — On successful upgrade, exit 0 with a re-run message. Do NOT continue
 *   the original command on the stale in-memory binary.
 * - D2 — Exclusive non-blocking advisory lock around the prompt; loser no-ops.
 * - D5 — Re-read `gbrain --version` post-upgrade to verify the binary actually
 *   advanced. `gbrain upgrade` returns 0 even on bun/clawhub catch-and-print
 *   paths and on the `binary` install ("not yet implemented").
 * - D6 — Gate on both stdin AND stdout TTY; prompt writes to stderr.
 * - D7 — When `bannerSuppressed()` is true, emit nothing about upgrades.
 * - D8 — Only prompt on minor/major drift; patch drift silent.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { execSync, execFileSync } from 'child_process';
import { compareVersions } from '../commands/migrations/index.ts';
import { gbrainPath } from './config.ts';
import type { GBrainConfig } from './config.ts';
import { promptLineStderr } from './cli-util.ts';
import type { CliOptions } from './cli-options.ts';

// Structural shape of the banner identity payload. Defined here (not imported
// from src/cli.ts) to avoid a circular import; cli.ts's BrainIdentity is
// structurally compatible.
export interface BrainIdentityShape {
  version: string;
}

// ============================================================================
// Pure helpers (compile-time tested)
// ============================================================================

/**
 * Validate a version string before handing it to `compareVersions`. Accepts
 * 3-segment or 4-segment dotted-numeric forms (digits only, no suffix). Anything
 * else fails closed.
 */
function isValidSemverLike(v: string): boolean {
  if (typeof v !== 'string' || v.length === 0) return false;
  const parts = v.split('.');
  if (parts.length < 3 || parts.length > 4) return false;
  for (const p of parts) {
    if (p.length === 0) return false;
    if (!/^\d+$/.test(p)) return false;
  }
  return true;
}

/**
 * Null-safe wrapper over the existing `compareVersions` from
 * `src/commands/migrations/index.ts`. Returns null if either input is malformed
 * so callers can fail closed (no prompt) rather than firing on garbage.
 */
export function safeCompare(a: string, b: string): -1 | 0 | 1 | null {
  if (!isValidSemverLike(a) || !isValidSemverLike(b)) return null;
  return compareVersions(a, b);
}

/**
 * Returns the highest-segment difference between two versions. `'patch'` is
 * the lowest-significance bump; `'major'` is the highest. `'none'` means the
 * versions are equal (or local is ahead). Used by D8 to gate the prompt on
 * minor/major drift only.
 */
export function driftLevel(local: string, remote: string): 'major' | 'minor' | 'patch' | 'none' {
  if (!isValidSemverLike(local) || !isValidSemverLike(remote)) return 'none';
  const cmp = compareVersions(local, remote);
  if (cmp >= 0) return 'none';
  const la = local.split('.').map(n => parseInt(n, 10) || 0);
  const ra = remote.split('.').map(n => parseInt(n, 10) || 0);
  if ((la[0] ?? 0) !== (ra[0] ?? 0)) return 'major';
  if ((la[1] ?? 0) !== (ra[1] ?? 0)) return 'minor';
  return 'patch';
}

// ============================================================================
// State file
// ============================================================================

export type LastResponse = 'yes' | 'no' | 'failed';

export interface PromptStateEntry {
  last_prompted_remote_version: string;
  last_response: LastResponse;
  last_prompted_at_iso: string;
}

export interface PromptState {
  schema_version: 1;
  entries: Record<string, PromptStateEntry>;
}

function statePath(): string {
  return gbrainPath('upgrade-prompt-state.json');
}

/**
 * Per-entry shape validator. Drops entries that don't have the expected fields
 * with the expected types instead of trusting `parsed as PromptState`. Defense
 * in depth against hand-edited files, schema migrations from a future version,
 * or partial truncation that left valid-JSON but malformed entries. Today every
 * comparison in `decideAction` and `runUpgradeDriftCheck` is strict-equality so
 * a malformed entry would fall through correctly, but this guards against a
 * future caller that destructures fields (which would crash on undefined).
 */
function isValidPromptStateEntry(value: unknown): value is PromptStateEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  if (typeof e.last_prompted_remote_version !== 'string') return false;
  if (typeof e.last_prompted_at_iso !== 'string') return false;
  if (e.last_response !== 'yes' && e.last_response !== 'no' && e.last_response !== 'failed') return false;
  return true;
}

export function loadPromptState(): PromptState {
  const path = statePath();
  if (!existsSync(path)) return { schema_version: 1, entries: {} };
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.schema_version !== 1 ||
      typeof parsed.entries !== 'object' ||
      parsed.entries === null
    ) {
      return { schema_version: 1, entries: {} };
    }
    // Filter malformed entries — keep valid ones, drop bad ones silently. A
    // bad neighbor in the same file MUST NOT poison the good entries.
    const validatedEntries: Record<string, PromptStateEntry> = {};
    for (const [key, entry] of Object.entries(parsed.entries as Record<string, unknown>)) {
      if (typeof key !== 'string' || key.length === 0) continue;
      if (isValidPromptStateEntry(entry)) validatedEntries[key] = entry;
    }
    return { schema_version: 1, entries: validatedEntries };
  } catch {
    // Corrupt JSON or truncated mid-write file → fall through to empty state.
    // Production write goes through atomic rename; this branch is defense in depth.
    return { schema_version: 1, entries: {} };
  }
}

/**
 * Atomic write: tmp file + rename. SIGKILL mid-write must not leave truncated
 * JSON the next invocation can't parse.
 */
export function savePromptState(state: PromptState): void {
  const path = statePath();
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

function ensureDir(path: string): void {
  try { mkdirSync(path, { recursive: true }); } catch { /* race: another process created it; fine */ }
}

// ============================================================================
// Lockfile (D2)
// ============================================================================

const LOCK_FILENAME = 'upgrade-prompt.lock';
const STALE_LOCK_MS = 60_000;

export interface PromptLock {
  release(): void;
}

function lockPath(): string {
  return gbrainPath(LOCK_FILENAME);
}

/**
 * Acquire an exclusive non-blocking advisory lock. Returns null on EEXIST
 * (sibling process owns the prompt; caller no-ops). Stale-lock reclaim: if
 * the existing lockfile's mtime is >60s old, unlink and retry once.
 */
export function acquirePromptLock(): PromptLock | null {
  const path = lockPath();
  ensureDir(dirname(path));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx+');
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          try { closeSync(fd); } catch { /* ignore */ }
          try { unlinkSync(path); } catch { /* ignore */ }
        },
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return null;
      // EEXIST — check staleness
      try {
        const st = statSync(path);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try { unlinkSync(path); } catch { /* ignore */ }
          continue; // retry openSync
        }
      } catch { /* stat failed, give up */ }
      return null;
    }
  }
  return null;
}

// ============================================================================
// Decision matrix (pure)
// ============================================================================

export interface DecisionInput {
  localVersion: string;
  remoteVersion: string;
  mcpUrl: string;
  state: PromptState;
  cliOpts: CliOptions;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  bannerIsSuppressed: boolean;
}

export type Decision = { kind: 'prompt'; level: 'major' | 'minor' } | { kind: 'noop' };

export function decideAction(input: DecisionInput): Decision {
  const cmp = safeCompare(input.localVersion, input.remoteVersion);
  if (cmp === null || cmp >= 0) return { kind: 'noop' };

  const level = driftLevel(input.localVersion, input.remoteVersion);
  // D8 — patch drift silent.
  if (level === 'patch' || level === 'none') return { kind: 'noop' };

  // D7 — banner suppressed = upgrade affordance silent.
  if (input.bannerIsSuppressed) return { kind: 'noop' };

  // D6 — both TTY gates.
  if (!input.stdinIsTty || !input.stdoutIsTty) return { kind: 'noop' };

  const entry = input.state.entries[input.mcpUrl];
  if (entry && entry.last_prompted_remote_version === input.remoteVersion) {
    if (entry.last_response === 'no') return { kind: 'noop' };
    if (entry.last_response === 'yes') return { kind: 'noop' };
    // 'failed' → fall through and re-prompt.
  }

  return { kind: 'prompt', level };
}

// ============================================================================
// Upgrade-success verification (D5)
// ============================================================================

export type Verifier = (remoteVersion: string) => { advanced: boolean; newVersion: string | null };

let _verifier: Verifier = defaultVerifyUpgradeAdvanced;

export function _setVerifierForTest(fn: Verifier | null): void {
  _verifier = fn ?? defaultVerifyUpgradeAdvanced;
}

function defaultVerifyUpgradeAdvanced(remoteVersion: string): { advanced: boolean; newVersion: string | null } {
  try {
    // Spawn `gbrain --version` as a fresh subprocess so we read the NEW binary
    // the upgrade just installed (not the old VERSION constant baked into the
    // currently-running process). Output shape: "gbrain X.Y.Z" or just "X.Y.Z".
    const out = execFileSync('gbrain', ['--version'], { encoding: 'utf-8', timeout: 10_000 });
    const match = out.trim().match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
    if (!match) return { advanced: false, newVersion: null };
    const newVersion = match[1];
    const cmp = safeCompare(newVersion, remoteVersion);
    return { advanced: cmp !== null && cmp >= 0, newVersion };
  } catch {
    return { advanced: false, newVersion: null };
  }
}

// ============================================================================
// Prompt reader injection (for unit tests)
// ============================================================================

/**
 * Prompt reader contract: returns the trimmed user input, OR `null` if stdin
 * EOFed or the read timed out. The orchestrator interprets null as "user is
 * not available to answer" — silent decline, no state write — so a transient
 * stdin closure doesn't poison the per-version sticky-decline gate.
 */
export type PromptReader = (prompt: string) => Promise<string | null>;

let _promptReader: PromptReader = promptLineStderr;

export function _setPromptReaderForTest(fn: PromptReader | null): void {
  _promptReader = fn ?? promptLineStderr;
}

// ============================================================================
// Upgrade runner injection (for unit tests)
// ============================================================================

export type UpgradeRunner = () => void;

function defaultRunUpgrade(): void {
  execSync('gbrain upgrade', { stdio: 'inherit' });
}

let _upgradeRunner: UpgradeRunner = defaultRunUpgrade;

export function _setUpgradeRunnerForTest(fn: UpgradeRunner | null): void {
  _upgradeRunner = fn ?? defaultRunUpgrade;
}

// ============================================================================
// Test escape: clear in-process state file path memo (none today, but matches
// the _clearIdentityCacheForTest pattern for future-proofing).
// ============================================================================

export function _clearPromptStateForTest(): void {
  // No in-process state to clear today; the file lives on disk and tests use
  // GBRAIN_HOME tempdirs for isolation. This stub exists for symmetry with
  // _clearIdentityCacheForTest in src/cli.ts so future caching can hook here.
}

// ============================================================================
// Orchestrator
// ============================================================================

export interface PromptDeps {
  localVersion?: string;
  exit?: (code: number) => never;
  log?: (msg: string) => void;
  /** Test-only override; production reads `process.stdin.isTTY`. */
  stdinIsTty?: boolean;
  /** Test-only override; production reads `process.stdout.isTTY`. */
  stdoutIsTty?: boolean;
}

/**
 * Main entrypoint called from `printIdentityBannerBestEffort`. Short-circuits
 * (returns) in every no-op case. On the prompt path:
 *
 *   yes + upgrade advanced  → persist 'yes',    print re-run msg, exit 0
 *   yes + upgrade NOT advanced → persist 'failed', print didn't-advance msg, exit 1
 *   yes + upgrade threw     → persist 'failed', print error msg,   exit 1
 *   no                      → persist 'no',    return (caller continues)
 *
 * NEVER throws. Best-effort: any unexpected error in state IO swallows and
 * falls through to no-op, matching the banner's "observability not load-bearing"
 * posture.
 */
export async function maybePromptForUpgrade(
  cfg: GBrainConfig,
  identity: BrainIdentityShape,
  cliOpts: CliOptions,
  bannerIsSuppressed: boolean,
  deps: PromptDeps = {},
): Promise<void> {
  const localVersion = deps.localVersion ?? (await import('../version.ts')).VERSION;
  const exitFn = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((msg: string) => process.stderr.write(msg + '\n'));

  const mcpUrl = cfg.remote_mcp?.mcp_url;
  if (!mcpUrl) return;

  let state: PromptState;
  try {
    state = loadPromptState();
  } catch {
    state = { schema_version: 1, entries: {} };
  }

  const decision = decideAction({
    localVersion,
    remoteVersion: identity.version,
    mcpUrl,
    state,
    cliOpts,
    stdinIsTty: deps.stdinIsTty ?? Boolean(process.stdin.isTTY),
    stdoutIsTty: deps.stdoutIsTty ?? Boolean(process.stdout.isTTY),
    bannerIsSuppressed,
  });

  if (decision.kind === 'noop') return;

  // Acquire lock. EEXIST → sibling owns the prompt, no-op silently.
  const lock = acquirePromptLock();
  if (!lock) return;

  try {
    const levelWord = decision.level === 'major' ? 'major' : 'minor';
    const promptText =
      `Remote brain is on v${identity.version} (you're on v${localVersion}). This is a ${levelWord} upgrade.\n` +
      `Upgrade local CLI now? [Y/n] `;
    // Prompt-scoped SIGINT handler. Without this, the SIGINT handler installed
    // by `runThinClientRouted` (which only aborts an AbortController the prompt
    // doesn't observe) leaves the prompt unable to be cancelled with Ctrl-C —
    // default-terminate is suppressed once any listener exists. Add ours, run
    // the prompt, remove it. Exit 130 matches the existing `network/aborted`
    // exit code in the dispatcher's catch block.
    const onPromptSigint = () => exitFn(130);
    process.on('SIGINT', onPromptSigint);
    let rawAnswer: string | null;
    try {
      rawAnswer = await _promptReader(promptText);
    } finally {
      process.off('SIGINT', onPromptSigint);
    }
    // Null = stdin EOF or timeout. Silent decline, no state write — a transient
    // closure (terminal hangup, /dev/null pipe past TTY check) must not lock
    // out future prompts for this version. The caller's command continues.
    if (rawAnswer === null) return;
    const answer = rawAnswer.toLowerCase();
    const accepted = answer === '' || answer === 'y' || answer === 'yes';

    const nowIso = new Date().toISOString();

    if (!accepted) {
      writeStateBestEffort(state, mcpUrl, identity.version, 'no', nowIso);
      return; // caller continues with the original command
    }

    // Run upgrade subprocess. May throw on real failure; D5 verification
    // catches the catch-and-print-advice paths.
    let upgradeThrew = false;
    let upgradeError: string | null = null;
    try {
      _upgradeRunner();
    } catch (e) {
      upgradeThrew = true;
      upgradeError = e instanceof Error ? e.message : String(e);
    }

    if (upgradeThrew) {
      writeStateBestEffort(state, mcpUrl, identity.version, 'failed', nowIso);
      log(`[upgrade failed: ${upgradeError}]`);
      exitFn(1);
      return;
    }

    // D5 — verify the binary actually advanced.
    const result = _verifier(identity.version);
    if (!result.advanced) {
      writeStateBestEffort(state, mcpUrl, identity.version, 'failed', nowIso);
      log(
        `gbrain upgrade did not actually advance the binary` +
        (result.newVersion ? ` (still on v${result.newVersion})` : '') +
        `. See the output above for manual steps.`,
      );
      exitFn(1);
      return;
    }

    writeStateBestEffort(state, mcpUrl, identity.version, 'yes', nowIso);
    log(`Upgrade complete. Re-run your command to use v${result.newVersion ?? identity.version}.`);
    exitFn(0);
  } finally {
    lock.release();
  }
}

function writeStateBestEffort(
  state: PromptState,
  mcpUrl: string,
  remoteVersion: string,
  response: LastResponse,
  iso: string,
): void {
  try {
    const next: PromptState = {
      schema_version: 1,
      entries: {
        ...state.entries,
        [mcpUrl]: {
          last_prompted_remote_version: remoteVersion,
          last_response: response,
          last_prompted_at_iso: iso,
        },
      },
    };
    savePromptState(next);
  } catch {
    // State write is best-effort; failing to persist shouldn't crash the user's
    // command (or block their upgrade). Worst case: prompt fires again next time.
  }
}
