/**
 * brain-repo-durability.ts — auto-harden a brain's git working tree (v0.42.44).
 *
 * Problem: fresh headless agents (OpenClaw/Hermes) fall out of sync with their
 * knowledge-wiki git repos — writes sit local-only and never push, long-lived
 * sessions edit a stale tree. The moment gbrain is given a PAT + a GitHub URL
 * for a brain repo, `hardenBrainRepo` makes durability work, idempotently:
 *
 *   1. pull current state (divergence-safe rebase; skip-on-dirty)
 *   2. repo-scoped credential wiring (reuse an existing helper if present)
 *   3. LOCAL untracked post-commit hook (best-effort background auto-push)
 *   4. committed `scripts/brain-commit-push.sh` (the DURABILITY GUARANTEE —
 *      synchronous add→commit→push that refuses to exit 0 without a push)
 *   5. durability rules in the ACTIVE resolver file (RESOLVER.md > AGENTS.md)
 *   6. a DB-free pull cron (every 30 min)
 *   7. verify by authenticated push-probe (proves push auth; no heartbeat)
 *
 * Trust boundary (this is gbrain's FIRST push path + FIRST secret storage):
 *  - The hook is LOCAL + untracked so a pulled commit can't rewrite executed
 *    code next to the PAT. Both hook and helper render from ONE bash template
 *    (PUSH_RETRY) — DRY at the TS source level, NOT by the hook sourcing a
 *    repo-controlled script.
 *  - Credential is repo-scoped (local git config), token redacted everywhere
 *    via shell-redact's exact-value scrubber, store file 0600.
 *
 * CLI-only by design (writes executables + an OS cron + a credential helper on
 * the host): never exposed over MCP.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, statSync, appendFileSync,
} from 'fs';
import { join, dirname, relative, isAbsolute } from 'path';
import { execFileSync, execSync } from 'child_process';
import {
  GIT_ENV, GIT_ENV_AUTH, divergenceSafePull, detectDefaultBranch, pushProbe,
  type PullOutcome, type PushProbeResult,
} from './git-remote.ts';
import { findResolverFile, RESOLVER_FILENAMES } from './resolver-filenames.ts';
import { redactSecretsInText } from './minions/handlers/shell-redact.ts';
// Static import → bundled into the --compile binary so the taxonomy never drifts
// and needs no runtime skills/ directory.
import filingRulesDoc from '../../skills/_brain-filing-rules.json';

// ── Types ───────────────────────────────────────────────────────────────────

export type StepName =
  | 'pull' | 'credential' | 'hook' | 'helper' | 'agents' | 'cron' | 'verify' | 'commit';
export type StepStatus = 'ok' | 'fixed' | 'skipped' | 'needs_attention';

export interface DurabilityStep {
  step: StepName;
  status: StepStatus;
  detail: string; // ALWAYS redacted — never contains the PAT
}

export interface DurabilityReport {
  source_id: string;
  repo_path: string;
  branch: string;
  steps: DurabilityStep[];
  missing: string[];        // what was missing on entry
  fixed: string[];          // what this run changed
  needs_attention: string[];
  clean_against_origin: boolean;
}

export interface HardenOpts {
  repoPath: string;
  sourceId: string;
  branch?: string;          // default: detectDefaultBranch
  pat?: string;             // already-loaded token; never logged
  installCron?: boolean;    // default true
  verify?: boolean;         // default true
  dryRun?: boolean;
  intervalSec?: number;     // cron cadence; default 1800
  logger?: (line: string) => void;
}

export interface UnhardenOpts {
  repoPath: string;
  sourceId: string;
  logger?: (line: string) => void;
}

// ── Banners / markers (idempotency keys) ────────────────────────────────────

const HOOK_BANNER = '# gbrain brain-durability post-commit hook (v0.42.44+)';
const HELPER_BANNER = '# gbrain brain-commit-push helper (v0.42.44+)';
const AGENTS_BEGIN = '<!-- BEGIN gbrain-brain-durability (managed; do not edit between markers) -->';
const AGENTS_END = '<!-- END gbrain-brain-durability -->';
const HELPER_REL = 'scripts/brain-commit-push.sh';
const CRED_MANAGED_KEY = 'gbrain.durability.managedcredential';

function gbrainHome(): string {
  return process.env.GBRAIN_HOME || join(process.env.HOME || '', '.gbrain');
}

/** Resolve the gbrain CLI path for the cron wrapper (inlined to avoid a
 *  core→commands import). which gbrain → process.execPath → argv[1] → "gbrain". */
function resolveGbrainCliPath(): string {
  try {
    const which = execSync('which gbrain', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (which) return which;
  } catch { /* not on PATH */ }
  const exec = process.execPath ?? '';
  if (exec.endsWith('/gbrain') || exec.endsWith('\\gbrain.exe')) return exec;
  const arg1 = process.argv[1] ?? '';
  if (arg1.endsWith('/gbrain') || arg1.endsWith('\\gbrain.exe')) return arg1;
  return 'gbrain';
}
function credStoreFile(): string {
  return join(gbrainHome(), 'git-credentials');
}
function pushLogPath(): string {
  return join(gbrainHome(), 'brain-push.log');
}

// ── Shared bash push-retry template (DRY at the TS source — D7) ──────────────
// Rendered into BOTH the (committed) helper and the (local, untracked) hook so
// there is one source of truth without the hook executing repo-controlled code.
const PUSH_RETRY = `# --- gbrain durability push-retry (generated; one source of truth) ---
brain_push() {
  _branch="$1"
  _log="\${GBRAIN_HOME:-$HOME/.gbrain}/brain-push.log"
  mkdir -p "$(dirname "$_log")" 2>/dev/null || true
  _gd="$(git rev-parse --git-dir 2>/dev/null || echo .git)"
  # Serialize concurrent pushes (commit bursts) so they coalesce instead of a
  # rebase-retry herd. No-op if flock is unavailable.
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$_gd/gbrain-push.lock"
    flock -w 30 9 || { echo "$(date -u +%FT%TZ) [push] lock-timeout $_branch" >>"$_log"; return 0; }
  fi
  if git push origin "HEAD:$_branch" >>"$_log" 2>&1; then
    echo "$(date -u +%FT%TZ) [push] ok $_branch $(git rev-parse --short HEAD 2>/dev/null)" >>"$_log"; return 0
  fi
  echo "$(date -u +%FT%TZ) [push] rejected; rebase-pull $_branch" >>"$_log"
  if git pull --rebase origin "$_branch" >>"$_log" 2>&1 && git push origin "HEAD:$_branch" >>"$_log" 2>&1; then
    echo "$(date -u +%FT%TZ) [push] ok-after-rebase $_branch $(git rev-parse --short HEAD 2>/dev/null)" >>"$_log"; return 0
  fi
  git rebase --abort >/dev/null 2>&1 || true
  echo "$(date -u +%FT%TZ) [push] LOCAL-ONLY, NEEDS ATTENTION: $_branch @ $(git rev-parse --short HEAD 2>/dev/null) could not reach origin. Run: gbrain sources pull <id> && git push" >>"$_log"
  return 1
}`;

function renderPostCommitHook(): string {
  return `#!/usr/bin/env bash
${HOOK_BANNER}
# LOCAL + untracked — NEVER commit this file. Best-effort background auto-push so
# agent writes don't sit local-only. The real guarantee is ${HELPER_REL}.
# Bypass: git commit --no-verify.
set -euo pipefail

_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
if [ "$_branch" = "HEAD" ]; then
  echo "$(date -u +%FT%TZ) [push] detached HEAD; skip" >> "\${GBRAIN_HOME:-$HOME/.gbrain}/brain-push.log" 2>/dev/null || true
  exit 0
fi

${PUSH_RETRY}

# Detach so the commit returns instantly; all output goes to the log.
( brain_push "$_branch" ) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
`;
}

function renderCommitPushHelper(): string {
  return `#!/usr/bin/env bash
${HELPER_BANNER}
# THE DURABILITY GUARANTEE: add -> commit -> push, atomically. Refuses to exit 0
# without a confirmed push. Usage:
#   scripts/brain-commit-push.sh "message" <path> [path ...]
#   scripts/brain-commit-push.sh --push-only [branch]
set -euo pipefail

${PUSH_RETRY}

_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "\${1:-}" = "--push-only" ]; then
  brain_push "\${2:-$_branch}"; exit $?
fi

_msg="\${1:?usage: brain-commit-push.sh <message> <path> [paths...]}"; shift || true
# Pull first so the local tree is current before we stage.
git fetch origin >/dev/null 2>&1 || true
git pull --rebase origin "$_branch" || { git rebase --abort >/dev/null 2>&1 || true; echo "rebase conflict: manual attention needed" >&2; exit 3; }

# EXPLICIT paths only — never a blind 'git add -A' (would risk committing
# secrets, temp files, or unrelated edits).
if [ "$#" -eq 0 ]; then
  echo "refusing blind 'git add -A' — pass explicit path(s) to commit" >&2; exit 2
fi
git add -- "$@"
if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi
git commit -m "$_msg"

if brain_push "$_branch"; then exit 0; fi
echo "PUSH FAILED — commit is local-only, NEEDS ATTENTION (see ${'$'}{GBRAIN_HOME:-$HOME/.gbrain}/brain-push.log)" >&2
exit 4
`;
}

// ── Managed AGENTS/RESOLVER block (taxonomy from filing rules; no drift) ─────

function renderTaxonomyLines(): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of (filingRulesDoc as any).rules ?? []) {
    const dir = String(r.directory || '').trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    lines.push(`   - \`${dir}\` — ${r.kind}`);
  }
  return lines.join('\n');
}

function renderManagedBlock(): string {
  return `${AGENTS_BEGIN}
<!-- gbrain durability rules. This block is regenerated by \`gbrain sources harden\`.
     Do not index as user knowledge; do not edit between the markers. -->
## Brain durability rules (always on)

1. **Deterministic filing — never use /tmp as storage.** Every persistent output
   goes to its taxonomy path (canonical, from \`skills/_brain-filing-rules.json\`):
${renderTaxonomyLines()}
   Writing to /tmp, scratch dirs, or outside the repo is forbidden for anything
   meant to persist.

2. **Every write is committed AND pushed — push is never deferred.** After any
   persistent write, run \`scripts/brain-commit-push.sh "<msg>" <path>\` (it commits,
   pushes, and FAILS LOUDLY if the push doesn't land), then confirm links resolve
   with \`gbrain check-resolvable\`. Do not move on until the push succeeded. The
   post-commit hook is only a best-effort fallback — the helper is the guarantee.

3. **Pull before you touch anything.** Run \`git fetch && git pull --rebase\` at
   session start and again before each batch of writes, so a long-lived session
   never edits a stale tree (a cron also pulls every ~30 min).
${AGENTS_END}`;
}

/** Patch the active resolver file with the managed block (idempotent). */
function patchResolverFile(repoPath: string, dryRun: boolean): { status: StepStatus; detail: string } {
  const existing = findResolverFile(repoPath);
  const target = existing ?? join(repoPath, RESOLVER_FILENAMES[1]); // default AGENTS.md
  const block = renderManagedBlock();
  const name = relative(repoPath, target) || target;

  let current = '';
  if (existsSync(target)) current = readFileSync(target, 'utf-8');

  let next: string;
  const b = current.indexOf(AGENTS_BEGIN);
  const e = current.indexOf(AGENTS_END);
  if (b !== -1 && e !== -1 && e > b) {
    const before = current.slice(0, b);
    const after = current.slice(e + AGENTS_END.length);
    next = before + block + after;
    if (next === current) return { status: 'ok', detail: `${name}: durability rules already current` };
  } else if (current.trim().length === 0) {
    next = block + '\n';
  } else {
    next = current.replace(/\s*$/, '') + '\n\n' + block + '\n';
  }

  if (dryRun) return { status: 'fixed', detail: `${name}: would write durability rules (dry-run)` };
  writeFileSync(target, next);
  return { status: 'fixed', detail: `${name}: durability rules written` };
}

// ── Local untracked post-commit hook (D9) ───────────────────────────────────

/** Resolve the active hooks dir (honors a pre-existing core.hooksPath). */
function resolveHooksDir(repoPath: string): { dir: string; tracked: boolean } {
  let hooksPath = '';
  try {
    hooksPath = execFileSync('git', ['-C', repoPath, 'config', '--get', 'core.hooksPath'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
    }).toString().trim();
  } catch { /* unset — normal */ }
  if (hooksPath) {
    const dir = isAbsolute(hooksPath) ? hooksPath : join(repoPath, hooksPath);
    // A hooksPath outside .git/ (e.g. .githooks) is a TRACKED location.
    const tracked = !dir.includes(`${join('.git', '')}`) && !dir.endsWith('.git/hooks');
    return { dir, tracked };
  }
  return { dir: join(repoPath, '.git', 'hooks'), tracked: false };
}

/** Ensure a repo-relative path is in .git/info/exclude so our hook stays untracked. */
function ensureExcluded(repoPath: string, relPath: string): void {
  const exclude = join(repoPath, '.git', 'info', 'exclude');
  try {
    mkdirSync(dirname(exclude), { recursive: true });
    let body = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : '';
    if (!body.split('\n').some(l => l.trim() === relPath)) {
      if (body.length && !body.endsWith('\n')) body += '\n';
      body += `${relPath}\n`;
      writeFileSync(exclude, body);
    }
  } catch { /* best-effort */ }
}

function installLocalHook(repoPath: string, dryRun: boolean): { status: StepStatus; detail: string } {
  const { dir, tracked } = resolveHooksDir(repoPath);
  const hookPath = join(dir, 'post-commit');
  const script = renderPostCommitHook();

  if (existsSync(hookPath)) {
    const cur = readFileSync(hookPath, 'utf-8');
    if (cur.includes(HOOK_BANNER)) {
      if (cur === script) return { status: 'ok', detail: `${relative(repoPath, hookPath)} already current` };
      if (dryRun) return { status: 'fixed', detail: `would refresh ${relative(repoPath, hookPath)} (dry-run)` };
      writeFileSync(hookPath, script); chmodSync(hookPath, 0o755);
      return { status: 'fixed', detail: `refreshed ${relative(repoPath, hookPath)}` };
    }
    // Foreign post-commit hook present — back it up, then install ours.
    if (!dryRun) writeFileSync(hookPath + '.bak', cur);
  }
  if (dryRun) return { status: 'fixed', detail: `would install ${relative(repoPath, hookPath)} (dry-run)` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(hookPath, script); chmodSync(hookPath, 0o755);
  // If the hooks dir is a tracked location (.githooks via frontmatter), keep OUR
  // hook untracked so it never becomes repo-controlled code (D9).
  if (tracked) ensureExcluded(repoPath, relative(repoPath, hookPath));
  return { status: 'fixed', detail: `installed local untracked ${relative(repoPath, hookPath)}` };
}

function uninstallLocalHook(repoPath: string): boolean {
  const { dir } = resolveHooksDir(repoPath);
  const hookPath = join(dir, 'post-commit');
  if (!existsSync(hookPath)) return false;
  if (!readFileSync(hookPath, 'utf-8').includes(HOOK_BANNER)) return false;
  rmSync(hookPath);
  if (existsSync(hookPath + '.bak')) { writeFileSync(hookPath, readFileSync(hookPath + '.bak')); rmSync(hookPath + '.bak'); }
  return true;
}

// ── Committed helper ────────────────────────────────────────────────────────

function installHelper(repoPath: string, dryRun: boolean): { status: StepStatus; detail: string } {
  const helperPath = join(repoPath, HELPER_REL);
  const script = renderCommitPushHelper();
  if (existsSync(helperPath) && readFileSync(helperPath, 'utf-8') === script) {
    // Ensure exec bit even when content is current.
    try { chmodSync(helperPath, 0o755); } catch { /* */ }
    return { status: 'ok', detail: `${HELPER_REL} already current` };
  }
  if (dryRun) return { status: 'fixed', detail: `would write ${HELPER_REL} (dry-run)` };
  mkdirSync(dirname(helperPath), { recursive: true });
  writeFileSync(helperPath, script); chmodSync(helperPath, 0o755);
  return { status: 'fixed', detail: `wrote ${HELPER_REL}` };
}

// ── Repo-scoped credential wiring (D11) ─────────────────────────────────────

function gitConfigGet(repoPath: string, key: string, localOnly = false): string {
  try {
    const scope = localOnly ? ['--local'] : [];
    return execFileSync('git', ['-C', repoPath, 'config', ...scope, '--get', key], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
    }).toString().trim();
  } catch { return ''; }
}
function gitConfigSet(repoPath: string, key: string, value: string): void {
  execFileSync('git', ['-C', repoPath, 'config', key, value], {
    stdio: 'ignore', timeout: 10_000, env: { ...process.env, ...GIT_ENV },
  });
}
function gitConfigUnset(repoPath: string, key: string): void {
  try {
    execFileSync('git', ['-C', repoPath, 'config', '--unset-all', key], {
      stdio: 'ignore', timeout: 10_000, env: { ...process.env, ...GIT_ENV },
    });
  } catch { /* not set */ }
}

function remoteHost(repoPath: string): string {
  try {
    const url = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
    }).toString().trim();
    return new URL(url).hostname || 'github.com';
  } catch { return 'github.com'; }
}

/**
 * Wire a repo-scoped credential. If a working helper is already configured,
 * reuse it (no plaintext write). Otherwise fall back to a 0600 store file wired
 * via the repo's LOCAL config only (least-privilege — not every github.com
 * remote under the account). The token is never returned or logged.
 */
function wireRepoCredential(repoPath: string, pat: string, dryRun: boolean): { status: StepStatus; detail: string } {
  // Only a REPO-LOCAL helper triggers reuse. A global helper (e.g. the macOS
  // osxkeychain default) must NOT block wiring the explicitly-provided PAT —
  // the user gave us a token expressly to use for this repo (D11).
  const existing = gitConfigGet(repoPath, 'credential.helper', /*localOnly*/ true);
  const ours = gitConfigGet(repoPath, CRED_MANAGED_KEY, true) === 'true';
  if (existing && !ours) {
    return { status: 'ok', detail: `reusing repo-local credential.helper (no plaintext store written)` };
  }

  const host = remoteHost(repoPath);
  const store = credStoreFile();
  const line = `https://x-access-token:${pat}@${host}`;
  // Already fully wired by us with this credential present → idempotent no-op.
  if (ours && existing && existsSync(store) && readFileSync(store, 'utf-8').split('\n').includes(line)) {
    return { status: 'ok', detail: `repo-scoped credential already wired for ${host}` };
  }
  if (dryRun) return { status: 'fixed', detail: 'would wire repo-scoped credential (dry-run)' };

  mkdirSync(dirname(store), { recursive: true, mode: 0o700 });
  try { chmodSync(gbrainHome(), 0o700); } catch { /* */ }
  let body = existsSync(store) ? readFileSync(store, 'utf-8') : '';
  if (!body.split('\n').some(l => l === line)) {
    if (body.length && !body.endsWith('\n')) body += '\n';
    body += `${line}\n`;
    writeFileSync(store, body, { mode: 0o600 });
  }
  try { chmodSync(store, 0o600); } catch { /* */ }
  // Repo-LOCAL wiring → only this repo uses the store (D11).
  gitConfigSet(repoPath, 'credential.helper', `store --file ${store}`);
  gitConfigSet(repoPath, CRED_MANAGED_KEY, 'true');
  return { status: 'fixed', detail: `wired repo-scoped credential for ${host} (store 0600)` };
}

function removeCredentialWiring(repoPath: string): boolean {
  if (gitConfigGet(repoPath, CRED_MANAGED_KEY, true) !== 'true') return false; // only what we created
  gitConfigUnset(repoPath, 'credential.helper');
  gitConfigUnset(repoPath, CRED_MANAGED_KEY);
  return true;
}

// ── Minimal DB-free pull cron (D2 + D12) ────────────────────────────────────

function cronLabel(sourceId: string): string {
  return `com.gbrain.brain-pull.${sourceId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}
function cronWrapperPath(sourceId: string): string {
  return join(gbrainHome(), `brain-pull-${sourceId.replace(/[^A-Za-z0-9._-]/g, '_')}.sh`);
}
function launchdPlistPath(sourceId: string): string {
  return join(process.env.HOME || '', 'Library', 'LaunchAgents', `${cronLabel(sourceId)}.plist`);
}

/** Pure cron-wrapper renderer (DB-free pull; secret-free — sources the shell
 *  profile rather than baking keys in). Exported for tests. */
export function renderCronWrapper(sourceId: string, repoPath: string, branch: string, cli: string, logPath: string): string {
  const q = (s: string) => s.replace(/'/g, "'\\''");
  return `#!/bin/bash
# Auto-generated by gbrain sources harden — DB-free durability pull (${sourceId}).
# Sources the shell profile for secrets, then runs the hardened, DB-free pull.
[ -f ~/.zshenv ] && source ~/.zshenv 2>/dev/null
source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null || true
# Self-disable if the captured checkout is gone (rename/relocation).
if [ ! -d '${q(repoPath)}/.git' ]; then
  echo "$(date -u +%FT%TZ) [cron] path gone, skipping: ${q(repoPath)}" >> "${q(logPath)}" 2>/dev/null || true
  exit 0
fi
exec '${q(cli)}' sources pull --path '${q(repoPath)}' --branch '${q(branch)}'
`;
}

function writeCronWrapper(sourceId: string, repoPath: string, branch: string): string {
  const wrapper = cronWrapperPath(sourceId);
  const body = renderCronWrapper(sourceId, repoPath, branch, resolveGbrainCliPath(), pushLogPath());
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, body, { mode: 0o755 });
  return wrapper;
}

export function generateBrainPullPlist(label: string, wrapperPath: string, home: string, intervalSec: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key><array><string>${esc(wrapperPath)}</string></array>
  <key>StartInterval</key><integer>${intervalSec}</integer>
  <key>StandardOutPath</key><string>${esc(home)}/.gbrain/brain-pull.log</string>
  <key>StandardErrorPath</key><string>${esc(home)}/.gbrain/brain-pull.err</string>
</dict>
</plist>`;
}

function installDurabilityCron(sourceId: string, repoPath: string, branch: string, intervalSec: number, dryRun: boolean): { status: StepStatus; detail: string } {
  const wrapper = dryRun ? cronWrapperPath(sourceId) : writeCronWrapper(sourceId, repoPath, branch);
  const home = process.env.HOME || '';
  if (process.platform === 'darwin') {
    const plistPath = launchdPlistPath(sourceId);
    if (dryRun) return { status: 'fixed', detail: `would install launchd ${cronLabel(sourceId)} every ${intervalSec}s (dry-run)` };
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, generateBrainPullPlist(cronLabel(sourceId), wrapper, home, intervalSec));
    try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* */ }
    try { execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' }); } catch { /* loaded best-effort */ }
    return { status: 'fixed', detail: `launchd ${cronLabel(sourceId)} every ${intervalSec}s` };
  }
  // Linux: crontab line, deduped on the label marker.
  const minutes = Math.max(1, Math.round(intervalSec / 60));
  const marker = `# ${cronLabel(sourceId)}`;
  const cronLine = `*/${minutes} * * * * ${wrapper} ${marker}`;
  if (dryRun) return { status: 'fixed', detail: `would install crontab (every ${minutes}m) (dry-run)` };
  let existingCron = '';
  try { existingCron = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' }); } catch { /* none */ }
  const kept = existingCron.split('\n').filter(l => l && !l.includes(marker));
  const next = [...kept, cronLine, ''].join('\n');
  try {
    execSync('crontab -', { input: next, stdio: ['pipe', 'ignore', 'ignore'] });
    return { status: 'fixed', detail: `crontab every ${minutes}m` };
  } catch (e) {
    return { status: 'needs_attention', detail: `crontab install failed: ${(e as Error).message.slice(0, 120)}` };
  }
}

function removeDurabilityCron(sourceId: string): boolean {
  let removed = false;
  if (process.platform === 'darwin') {
    const plistPath = launchdPlistPath(sourceId);
    if (existsSync(plistPath)) {
      try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* */ }
      rmSync(plistPath); removed = true;
    }
  } else {
    const marker = `# ${cronLabel(sourceId)}`;
    try {
      const cur = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
      if (cur.includes(marker)) {
        const next = cur.split('\n').filter(l => l && !l.includes(marker)).join('\n') + '\n';
        execSync('crontab -', { input: next, stdio: ['pipe', 'ignore', 'ignore'] });
        removed = true;
      }
    } catch { /* none */ }
  }
  const wrapper = cronWrapperPath(sourceId);
  if (existsSync(wrapper)) { rmSync(wrapper); removed = true; }
  return removed;
}

// ── PAT acceptance (D8) ─────────────────────────────────────────────────────

export interface AcceptPatResult { token: string; source: string; warnings: string[]; }

/**
 * Resolve a PAT: --pat-file (preferred) > GBRAIN_GITHUB_PAT env. Never a bare CLI
 * arg (process-listing leak). Validates non-empty; WARNs loudly on loose perms
 * but continues (mirrors GBRAIN_ALLOW_PRIVATE_REMOTES). Returns null if none.
 */
export function acceptPat(opts: { patFile?: string }): AcceptPatResult | null {
  const warnings: string[] = [];
  if (opts.patFile) {
    if (!existsSync(opts.patFile)) throw new Error(`--pat-file not found: ${opts.patFile}`);
    try {
      const mode = statSync(opts.patFile).mode;
      if (mode & 0o077) warnings.push(`WARN: PAT file ${opts.patFile} is group/other-readable (mode ${(mode & 0o777).toString(8)}); chmod 600 it`);
    } catch { /* */ }
    const token = readFileSync(opts.patFile, 'utf-8').trim();
    if (!token) throw new Error(`--pat-file is empty: ${opts.patFile}`);
    return { token, source: 'pat-file', warnings };
  }
  const env = (process.env.GBRAIN_GITHUB_PAT || '').trim();
  if (env) return { token: env, source: 'env:GBRAIN_GITHUB_PAT', warnings };
  return null;
}

// ── Orchestration ───────────────────────────────────────────────────────────

function isGitRepo(repoPath: string): boolean {
  return existsSync(join(repoPath, '.git'));
}

function currentBranch(repoPath: string): string {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
    }).toString().trim();
  } catch { return 'HEAD'; }
}

function headSha(repoPath: string): string {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
    }).toString().trim();
  } catch { return ''; }
}

function pullDetail(o: PullOutcome): { status: StepStatus; detail: string } {
  switch (o.status) {
    case 'up_to_date': return { status: 'ok', detail: 'already up to date with origin' };
    case 'advanced': return { status: 'fixed', detail: `advanced ${o.from.slice(0, 7)}→${o.to.slice(0, 7)}` };
    case 'skipped_dirty': return { status: 'skipped', detail: 'working tree dirty — pull skipped (in-progress edits preserved)' };
    case 'conflict_aborted': return { status: 'needs_attention', detail: o.detail };
  }
}

/**
 * Harden a brain repo for durability. Idempotent: a second run on an
 * already-hardened repo produces all ok/skipped and NO new commit.
 */
export async function hardenBrainRepo(opts: HardenOpts): Promise<DurabilityReport> {
  const { repoPath, sourceId } = opts;
  const dryRun = !!opts.dryRun;
  const installCron = opts.installCron !== false;
  const verify = opts.verify !== false;
  const intervalSec = opts.intervalSec ?? 1800;
  const redact = opts.pat ? (s: string) => redactSecretsInText(s, new Map([['github_pat', opts.pat!]])) : (s: string) => s;
  const log = (l: string) => opts.logger?.(redact(l));

  if (!isGitRepo(repoPath)) throw new Error(`not a git repo: ${repoPath}`);

  const branch = opts.branch || detectDefaultBranch(repoPath);
  const steps: DurabilityStep[] = [];
  const push = (step: StepName, r: { status: StepStatus; detail: string }) => {
    const s: DurabilityStep = { step, status: r.status, detail: redact(r.detail) };
    steps.push(s); log(`[${step}] ${s.status}: ${s.detail}`);
    return s;
  };

  // Refuse on detached HEAD — pushing to a wrong ref is worse than not pushing.
  if (currentBranch(repoPath) === 'HEAD') {
    push('pull', { status: 'needs_attention', detail: 'detached HEAD — checkout a branch before hardening' });
  } else {
    // 1. pull current state
    try { push('pull', pullDetail(divergenceSafePull(repoPath, branch))); }
    catch (e) { push('pull', { status: 'needs_attention', detail: `fetch/pull failed: ${(e as Error).message.slice(0, 140)}` }); }
  }

  // 2. credential
  if (opts.pat) push('credential', wireRepoCredential(repoPath, opts.pat, dryRun));
  else push('credential', { status: 'skipped', detail: 'no PAT provided — relying on existing git auth' });

  // 3. local untracked hook
  push('hook', installLocalHook(repoPath, dryRun));
  // 4. committed helper
  push('helper', installHelper(repoPath, dryRun));
  // 5. resolver/AGENTS rules
  push('agents', patchResolverFile(repoPath, dryRun));
  // 6. cron
  if (installCron) push('cron', installDurabilityCron(sourceId, repoPath, branch, intervalSec, dryRun));
  else push('cron', { status: 'skipped', detail: '--no-cron' });

  // 7. verify (push-probe) + commit scaffolding if push works
  let clean = false;
  if (verify && !dryRun) {
    const probe: PushProbeResult = pushProbe(repoPath, branch, { redactDetail: redact });
    if (!probe.ok) {
      push('verify', { status: 'needs_attention', detail: `push-probe failed (${probe.reason}): ${probe.detail}` });
    } else {
      push('verify', { status: 'ok', detail: 'push-probe ok — push auth confirmed' });
      // Commit the durability scaffolding (helper + rules) — real content, the
      // genuine end-to-end proof (no synthetic heartbeat). No-op when unchanged.
      const committed = commitScaffolding(repoPath, branch, redact);
      if (committed) push('commit', committed);
      clean = headMatchesOrigin(repoPath, branch);
    }
  } else if (dryRun) {
    push('verify', { status: 'skipped', detail: 'dry-run' });
  } else {
    push('verify', { status: 'skipped', detail: '--no-verify' });
  }

  const missing = steps.filter(s => s.status === 'fixed').map(s => s.step);
  const fixed = missing;
  const needs_attention = steps.filter(s => s.status === 'needs_attention').map(s => `${s.step}: ${s.detail}`);
  return { source_id: sourceId, repo_path: repoPath, branch, steps, missing, fixed, needs_attention, clean_against_origin: clean };
}

function commitScaffolding(repoPath: string, branch: string, redact: (s: string) => string): { status: StepStatus; detail: string } | null {
  // Stage only the durability artifacts we manage — never a blind add.
  const paths: string[] = [HELPER_REL];
  const resolver = findResolverFile(repoPath);
  if (resolver) paths.push(relative(repoPath, resolver));
  try {
    execFileSync('git', ['-C', repoPath, 'add', '--', ...paths], { stdio: 'ignore', timeout: 30_000, env: { ...process.env, ...GIT_ENV } });
    const staged = execFileSync('git', ['-C', repoPath, 'diff', '--cached', '--name-only'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
    }).toString().trim();
    if (!staged) return { status: 'ok', detail: 'scaffolding already committed' };
    execFileSync('git', ['-C', repoPath, 'commit', '-m', 'chore(gbrain): install brain durability scaffolding'], {
      stdio: 'ignore', timeout: 30_000, env: { ...process.env, ...GIT_ENV },
    });
    execFileSync('git', ['-C', repoPath, ...['-c', 'http.followRedirects=false'], 'push', 'origin', `HEAD:${branch}`], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, env: { ...process.env, ...GIT_ENV_AUTH },
    });
    return { status: 'fixed', detail: 'committed + pushed durability scaffolding' };
  } catch (e) {
    return { status: 'needs_attention', detail: redact(`scaffolding commit/push failed: ${(e as Error).message.slice(0, 140)}`) };
  }
}

function headMatchesOrigin(repoPath: string, branch: string): boolean {
  try {
    const local = headSha(repoPath);
    const remote = execFileSync('git', ['-C', repoPath, 'rev-parse', `origin/${branch}`], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
    }).toString().trim();
    return !!local && local === remote;
  } catch { return false; }
}

/** Remove durability scaffolding: cron, local hook, credential wiring. Leaves
 *  committed content (helper, resolver block) intact. Idempotent. */
export async function unhardenBrainRepo(opts: UnhardenOpts): Promise<DurabilityStep[]> {
  const { repoPath, sourceId } = opts;
  const steps: DurabilityStep[] = [];
  const cronRemoved = removeDurabilityCron(sourceId);
  steps.push({ step: 'cron', status: cronRemoved ? 'fixed' : 'skipped', detail: cronRemoved ? 'cron removed' : 'no cron' });
  const hookRemoved = isGitRepo(repoPath) ? uninstallLocalHook(repoPath) : false;
  steps.push({ step: 'hook', status: hookRemoved ? 'fixed' : 'skipped', detail: hookRemoved ? 'hook removed' : 'no gbrain hook' });
  const credRemoved = isGitRepo(repoPath) ? removeCredentialWiring(repoPath) : false;
  steps.push({ step: 'credential', status: credRemoved ? 'fixed' : 'skipped', detail: credRemoved ? 'credential wiring removed' : 'no gbrain credential wiring' });
  opts.logger?.(steps.map(s => `[${s.step}] ${s.status}: ${s.detail}`).join('\n'));
  return steps;
}
