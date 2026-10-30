import { assertManagedFilesystemWrite, hasFilesystemPublication, managedFilesystemRootFor } from './persistence/filesystem-guard.ts';
/**
 * brain-repo-durability.ts — auto-harden a brain's git working tree (v0.42.44).
 *
 * Problem: fresh headless agents (OpenClaw/Hermes) fall out of sync with their
 * knowledge-wiki git repos — writes sit local-only and never push, long-lived
 * sessions edit a stale tree. The moment gbrain is given a PAT + a GitHub URL
 * for a brain repo, `hardenBrainRepo` makes durability work, idempotently:
 *
 *   1. pull current state (fast-forward or in-memory merge; skip-on-dirty)
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
 *    code next to the PAT. Since #6530 both hook and helper delegate to
 *    `gbrain git commit-push` (src/core/git/commit-push.ts); the hook runs the
 *    absolute CLI path captured at harden time, never the committed helper.
 *  - Credential is repo-scoped (local git config), token redacted everywhere
 *    via shell-redact's exact-value scrubber, store file 0600.
 *
 * CLI-only by design (writes executables + an OS cron + a credential helper on
 * the host): never exposed over MCP.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, statSync, renameSync, appendFileSync, realpathSync, readdirSync,
} from 'fs';
import { join, dirname, relative, isAbsolute, sep } from 'path';
import { execFileSync, execSync } from './spawn.ts';
import { execFileBounded } from './bounded-child-exec.ts';
import {
  GIT_ENV, divergenceSafePull, detectDefaultBranch, pushProbe,
  type PullOutcome, type PullStrategy, type PushProbeResult,
} from './git-remote.ts';
import { findResolverFile, RESOLVER_FILENAMES } from './resolver-filenames.ts';
import { redactSecretsInText } from './minions/handlers/shell-redact.ts';
import { ensureGbrainHome, resolveGbrainHome } from './gbrain-home.ts';
import { binaryOnPath } from './execution-env.ts';
import { loadFilingRules, type FilingRulesDoc } from './filing-audit.ts';
import { classifyGitCheckout } from './git-checkout.ts';
import { OperationError, opError } from './ops/contract.ts';
import { readFix } from './ops/op-fix.ts';
// Bundled into the --compile binary as the fallback taxonomy for repos that
// don't ship their own — see resolveFilingRules().
import filingRulesDoc from '../../skills/_brain-filing-rules.json';
import { gitChildEnv } from './git-env.ts';
import { commitAndPush, commitPathsLocked, readIntegrateConflict, SOURCE_ROOT_CONFIG } from './git/commit-push.ts';

export { execFileBounded, type BoundedExecOptions } from './bounded-child-exec.ts';

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
  pullStrategy?: PullStrategy; // sources.config.pull_strategy (#5429); default rebase
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

/** CX2-8: resolves through the single gbrain-home choke point (config.ts
 *  semantics — GBRAIN_HOME is a PARENT dir, `.gbrain` is appended). The
 *  bash templates below use the matching `${GBRAIN_HOME:-$HOME}/.gbrain`
 *  spelling so the shell and TS sides agree on where brain-push.log lives. */
function gbrainHome(): string {
  return resolveGbrainHome();
}

/** Resolve the gbrain CLI path for the cron wrapper (inlined to avoid a
 *  core→commands import). which gbrain → process.execPath → argv[1] → "gbrain". */
function resolveGbrainCliPath(): string {
  try {
    // #2747: `env: process.env` required under Bun — see the sibling copy
    // of this function in commands/autopilot.ts for the full explanation
    // (Bun snapshots process.env at its own startup; execSync without an
    // explicit env is blind to any PATH mutation since then).
    const which = execSync('which gbrain', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    }).trim();
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

/** Rotate the push log at 1MB (keep one predecessor as `.1`). */
const PUSH_LOG_MAX_BYTES = 1024 * 1024;

/**
 * S3#10: keep `brain-push.log` 0600 and bounded. The bash hook/helper append
 * to it forever; without maintenance it grows unbounded and (pre-fix) was
 * created with the umask default. Called by every harden run (never in
 * dry-run — a preview must not mutate, #3736). Best-effort: log maintenance
 * can never fail a harden. Exported for tests.
 */
export function maintainPushLog(): void {
  try {
    const p = pushLogPath();
    if (!existsSync(p)) return;
    try { chmodSync(p, 0o600); } catch { /* */ }
    if (statSync(p).size > PUSH_LOG_MAX_BYTES) {
      renameSync(p, `${p}.1`); // overwrite any previous rotation
      writeFileSync(p, '', { mode: 0o600 });
    }
  } catch { /* best-effort */ }
}

// ── Helper + hook templates (#6530) ─────────────────────────────────────────
// Both delegate to `gbrain git commit-push` (src/core/git/commit-push.ts):
// a short commit lock plus a separate push lock per checkout, path-scoped commits, remote commits merged in
// memory, the checkout advanced fast-forward only. Neither ever runs
// `pull --rebase`, `stash` or `reset` in the shared tree. The banners above
// stay byte-identical: they are the ownership markers isDurabilityHardened,
// installLocalHook and unharden match (changing one would silently turn off
// write-through commits on every hardened repo). The protocol revision lives
// on its own `# gbrain-protocol:` line.

export const DURABILITY_PROTOCOL = 2;
const PROTOCOL_LINE = `# gbrain-protocol: ${DURABILITY_PROTOCOL}`;

/** The protocol revision a rendered hook/helper declares; 1 for pre-#6530 files (no line). */
export function durabilityProtocolOf(text: string): number {
  const m = /^# gbrain-protocol: (\d+)$/m.exec(text);
  return m ? Number(m[1]) : 1;
}

function shq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function renderPostCommitHook(cli: string): string {
  return `#!/usr/bin/env bash
${HOOK_BANNER}
${PROTOCOL_LINE}
# LOCAL + untracked — NEVER commit this file. Best-effort background push so
# commits don't sit local-only. Runs the gbrain CLI captured at harden time
# (never the committed helper), which takes the checkout's commit lock,
# merges remote commits in memory and never moves files under local edits.
# The fail-loud guarantee is ${HELPER_REL}. Bypass: git commit --no-verify.
set -uo pipefail
unset $(git rev-parse --local-env-vars) 2>/dev/null || true

# The committing process (gbrain git commit-push / ${HELPER_REL}) publishes itself.
[ -n "\${BRAIN_COMMIT_LOCK_HELD:-}" ] && exit 0

_log="\${GBRAIN_HOME:-$HOME}/.gbrain/brain-push.log"
mkdir -p "$(dirname "$_log")" 2>/dev/null || true
[ -e "$_log" ] || { : >"$_log" 2>/dev/null && chmod 600 "$_log" 2>/dev/null; } || true
_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo HEAD)"
if [ "$_branch" = "HEAD" ]; then
  echo "$(date -u +%FT%TZ) [push] detached HEAD; skip" >>"$_log" 2>/dev/null || true
  exit 0
fi
_cli=${shq(cli)}
if [ ! -x "$_cli" ]; then
  echo "$(date -u +%FT%TZ) [push] LOCAL-ONLY, NEEDS ATTENTION: $_branch @ $(git rev-parse --short HEAD 2>/dev/null) gbrain CLI missing at $_cli. Run: gbrain sources harden <id>" >>"$_log" 2>/dev/null || true
  exit 0
fi
# Detach so the commit returns instantly; the CLI logs its own outcome.
( "$_cli" git commit-push --push-only --require-clean ) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
`;
}

export function renderCommitPushHelper(): string {
  return `#!/usr/bin/env bash
${HELPER_BANNER}
${PROTOCOL_LINE}
# THE DURABILITY GUARANTEE: commit the named paths and push, safely, in a
# checkout other agents share. Refuses to exit 0 without a confirmed push.
#   scripts/brain-commit-push.sh "message" <path> [path ...]
#   scripts/brain-commit-push.sh --push-only
#   scripts/brain-commit-push.sh --pull
# Delegates to \`gbrain git commit-push\` (lock, path-scoped commit, in-memory
# merge, fast-forward-only checkout). Without a capable gbrain it only commits
# the paths under the lock and pushes; a rejected push fails loudly. It never
# runs pull --rebase, stash or reset. Guide: docs/guides/shared-checkout-git.md
set -euo pipefail
unset $(git rev-parse --local-env-vars) 2>/dev/null || true

_managed_git="$(git rev-parse --git-dir 2>/dev/null || echo .git)"
if [ -e "$_managed_git/gbrain-managed.json" ] || [ -e .gbrain-managed ]; then
  echo "writer_coordinator_required: submit managed changes through persistence" >&2; exit 1
fi

_gbrain_cli() {
  local c
  for c in "$(command -v gbrain 2>/dev/null || true)" "$(git config --local --get gbrain.cliPath 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && "$c" git commit-push --help >/dev/null 2>&1 && { printf '%s' "$c"; return 0; }
  done
  return 1
}

_branch="$(git symbolic-ref --quiet --short HEAD)" || { echo "detached HEAD: check out a branch first" >&2; exit 1; }
_run() {
  local rc=0
  "$_cli" git commit-push "$@" || rc=$?
  if [ "$rc" -eq 4 ]; then
    echo "PUSH FAILED — commit is local-only, NEEDS ATTENTION (see \${GBRAIN_HOME:-$HOME}/.gbrain/brain-push.log)" >&2
  fi
  exit "$rc"
}
if _cli="$(_gbrain_cli)"; then
  case "\${1:-}" in
    --push-only) if [ -n "\${2:-}" ]; then _run --push-only --branch "$2"; else _run --push-only; fi ;;
    --pull) _run --pull ;;
  esac
  _msg="\${1:?usage: brain-commit-push.sh <message> <path> [paths...]}"; shift
  [ "$#" -gt 0 ] || { echo "refusing a repo-wide commit: pass explicit path(s)" >&2; exit 2; }
  _run -m "$_msg" -- "$@"
fi

# ── Fallback: no gbrain that knows \`git commit-push\` on this machine ──────────
_branch="$(git symbolic-ref --quiet --short HEAD)" || { echo "detached HEAD: check out a branch first" >&2; exit 1; }
echo "[brain-commit-push] gbrain git commit-push unavailable; using the minimal locked commit + push" >&2
_log="\${GBRAIN_HOME:-$HOME}/.gbrain/brain-push.log"
mkdir -p "$(dirname "$_log")" 2>/dev/null || true
# The absolute lock path, as gbrain spells it: the marker below must name this exact lock.
_gp="$(git rev-parse --git-path brain-commit.lock)"
_gd="$(cd "$(dirname "$_gp")" && pwd -P)"
_lock="$_gd/brain-commit.lock"
if command -v flock >/dev/null 2>&1; then
  exec 8>"$_lock"
  flock -w "\${GBRAIN_COMMIT_LOCK_WAIT_SECONDS:-\${GBRAIN_PUSH_LOCK_WAIT_SECONDS:-60}}" 8 || { echo "commit_lock_busy: another writer holds the commit lock" >&2; exit 1; }
  exec 9>"$_gd/gbrain-push.lock"
  flock -w "\${GBRAIN_COMMIT_LOCK_WAIT_SECONDS:-\${GBRAIN_PUSH_LOCK_WAIT_SECONDS:-60}}" 9 || { echo "commit_lock_busy: another writer holds the push lock" >&2; exit 1; }
  export BRAIN_COMMIT_LOCK_HELD="$_lock" GBRAIN_COMMIT_VIA="$_lock"
else
  echo "[brain-commit-push] flock not found: committing without the writer lock (install gbrain or flock)" >&2
fi
case "\${1:-}" in
  --pull)
    git fetch --no-tags origin "$_branch"
    exec git -c core.hooksPath=/dev/null merge --ff-only --no-autostash "origin/$_branch" ;;
  --push-only) ;;
  *)
    _msg="\${1:?usage: brain-commit-push.sh <message> <path> [paths...]}"; shift
    [ "$#" -gt 0 ] || { echo "refusing a repo-wide commit: pass explicit path(s)" >&2; exit 2; }
    git add -A -- "$@"
    if git diff --cached --quiet -- "$@"; then echo "nothing to commit"; else git commit --only -m "$_msg" -- "$@"; fi ;;
esac
_head="$(git rev-parse HEAD)"
# Never hold the commit lock across the network: release it and push under the publish lock, like gbrain.
exec 9>&- 8>&-
unset BRAIN_COMMIT_LOCK_HELD GBRAIN_COMMIT_VIA
if command -v flock >/dev/null 2>&1; then
  exec 7>"$_gd/brain-publish.lock"
  flock -w "\${GBRAIN_PUBLISH_LOCK_WAIT_SECONDS:-300}" 7 || { echo "PUSH FAILED: another push held this checkout's publish lock; the commit is local-only. Run: gbrain git commit-push --push-only" >&2; exit 4; }
fi
if git push origin "$_head:refs/heads/$_branch" >>"$_log" 2>&1; then
  echo "$(date -u +%FT%TZ) [push] ok $_branch $(git rev-parse --short "$_head")" >>"$_log"; exit 0
fi
echo "$(date -u +%FT%TZ) [push] LOCAL-ONLY, NEEDS ATTENTION: $_branch @ $(git rev-parse --short "$_head") push rejected; run gbrain git commit-push --push-only" >>"$_log"
echo "PUSH FAILED — the commit is local-only. Install gbrain, then run: gbrain git commit-push --push-only (it merges remote commits safely). Never git pull --rebase here." >&2
exit 4
`;
}

// ── Managed AGENTS/RESOLVER block (taxonomy from filing rules; no drift) ─────

/** Top-level folders that hold gbrain plumbing rather than filed content. */
const NON_CONTENT_DIRS = new Set(['skills', 'scripts', 'node_modules']);

/** Folder names rendered into the durability block: no dot-folders, markup, newlines or code-span breakers. */
const SAFE_FOLDER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_ .-]*$/;
const MAX_DERIVED_FOLDERS = 50;

/**
 * Resolve the filing-rules taxonomy for `repoPath`: prefer the repo's own
 * `skills/_brain-filing-rules.json`, then `_brain-filing-rules.json` at the
 * repo root. Without one (#7629), a repo that already keeps content in
 * top-level folders gets those folders, each bundled rule that lives under one
 * keeping its kind; a repo with no content folder yet gets the bundled default,
 * the convention a new brain starts from. Fails open — a missing or malformed
 * repo file must never break `sources harden`. Only plain folder names are
 * listed (at most 50), so repo content cannot add text to the block.
 */
function resolveFilingRules(repoPath: string): { rules: FilingRulesDoc; from: string } {
  for (const dir of [join(repoPath, 'skills'), repoPath]) {
    try {
      const rules = loadFilingRules(dir);
      if (rules) return { rules, from: dir === repoPath ? '`_brain-filing-rules.json`' : '`skills/_brain-filing-rules.json`' };
    } catch { /* malformed — fall through */ }
  }
  const bundled = filingRulesDoc as FilingRulesDoc;
  let folders: string[] = [];
  try {
    folders = readdirSync(repoPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && SAFE_FOLDER_NAME.test(d.name) && !NON_CONTENT_DIRS.has(d.name))
      .map((d) => d.name)
      .sort()
      .slice(0, MAX_DERIVED_FOLDERS);
  } catch { /* unreadable — use the bundled default */ }
  if (folders.length === 0) return { rules: bundled, from: "gbrain's default taxonomy" };
  const rules = folders.flatMap((folder) => {
    const known = (bundled.rules ?? []).filter((r) => String(r.directory || '').split('/')[0] === folder);
    return known.length > 0 ? known : [{ kind: 'existing folder', directory: `${folder}/` }];
  });
  return { rules: { ...bundled, rules }, from: "this repository's top-level folders" };
}

function renderTaxonomyLines(rules: FilingRulesDoc): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of rules.rules ?? []) {
    const dir = String(r.directory || '').trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    lines.push(`   - \`${dir}\` — ${r.kind}`);
  }
  return lines.join('\n');
}

/**
 * The classic rules tell agents to run the push helper after every write and
 * its `--pull` mode before writing (#6530: never `git pull --rebase`). On a managed canonical worktree
 * (#5808) both route agents around the persistence owner, so the block has a
 * managed variant: page writes through gbrain, non-page files with plain git,
 * never pull or rebase the checkout. `gbrain sources writer git-durability
 * <source> --enable` (and `--pat-file`) regenerates it there.
 */
function renderManagedBlock(repoPath: string, managed?: { sourceId: string }): string {
  const { rules, from } = resolveFilingRules(repoPath);
  const regeneratedBy = managed ? `gbrain sources writer git-durability ${managed.sourceId} --enable` : 'gbrain sources harden';
  const writeRules = managed ? `2. **Page writes go through gbrain, never through git.** This checkout is the
   managed canonical worktree of gbrain source \`${managed.sourceId}\`: the persistence
   owner writes each page file, commits only the page paths it wrote and pushes
   HEAD after every page write. Save pages with the gbrain tools (\`put_page\`,
   \`edit_page\`, \`remember\`, \`capture\`); do not run the classic commit-and-push
   helper, \`git add -A\` or \`git commit\` for pages. Confirm a write landed with
   \`gbrain sources writer status ${managed.sourceId} --json\` (its receipts and parked
   effects), and that links resolve with \`gbrain check-resolvable\`.

3. **Never pull, rebase or reset this checkout.** The owner publishes from local
   HEAD and never pulls, so a pull, rebase, reset or checkout of page paths moves
   files under it. To bring in remote commits run
   \`gbrain sources refresh ${managed.sourceId}\`. Files that are not pages (this file,
   \`MEMORY.md\`, daily notes) are yours: commit them with
   \`gbrain git commit-push -m "<msg>" -- <paths>\`, which commits only those paths
   under this checkout's commit lock and never fetches, pushes or moves the
   checkout. They reach the remote on the owner's next push, or publish them with
   \`gbrain git commit-push --push-only --keep-checkout\` (never \`git push --force\`).` : `2. **Every write is committed AND pushed — push is never deferred.** After any
   persistent write, run \`scripts/brain-commit-push.sh "<msg>" <path>\` (or
   \`gbrain git commit-push -m "<msg>" -- <path>\`). It commits only the paths you
   name, takes this checkout's writer lock, merges remote commits without
   touching other agents' files, and FAILS LOUDLY if the push doesn't land. Then
   confirm links resolve with \`gbrain check-resolvable\`. On \`integrate_conflict\`
   stop and ask the user; on \`commit_lock_busy\` retry once. The post-commit hook
   is only a best-effort fallback — the helper is the guarantee.

3. **Bring in remote commits safely; never rebase this checkout.** Other agents
   share it. Run \`scripts/brain-commit-push.sh --pull\` (or
   \`gbrain git commit-push --pull\`) at session start and before each batch of
   writes (a cron also pulls every ~30 min). Never run \`git pull --rebase\`,
   \`git stash\`, \`--autostash\`, \`git reset --hard\` or \`git push --force\` here, and
   never delete \`.git/rebase-merge\` without first saving its autostash with
   \`git stash store\` (docs/guides/shared-checkout-git.md#stuck-rebase).`;
  return `${AGENTS_BEGIN}
<!-- gbrain durability rules. This block is regenerated by \`${regeneratedBy}\`.
     Do not index as user knowledge; do not edit between the markers. -->
## Brain durability rules (always on)

1. **Deterministic filing — never use /tmp as storage.** Every persistent output
   goes to its taxonomy path (from ${from}):
${renderTaxonomyLines(rules)}
   Writing to /tmp, scratch dirs, or outside the repo is forbidden for anything
   meant to persist.

${writeRules}
${AGENTS_END}`;
}

/** #5808: the managed variant of the block, rewritten in place by the Git-durability admin verb; the operator commits it. */
export function patchManagedDurabilityBlock(repoPath: string, sourceId: string, dryRun: boolean): { status: StepStatus; detail: string } {
  return patchResolverFile(repoPath, dryRun, { sourceId });
}

/** Patch the active resolver file with the managed block (idempotent). */
function patchResolverFile(repoPath: string, dryRun: boolean, managed?: { sourceId: string }): { status: StepStatus; detail: string } {
  const existing = findResolverFile(repoPath);
  const target = existing ?? join(repoPath, RESOLVER_FILENAMES[1]); // default AGENTS.md
  const block = renderManagedBlock(repoPath, managed);
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
/** Worktree-safe path inside the git dir [D6]: `.git` is a FILE in worktrees
 * and submodules, so any path under it must come from git itself (rev-parse
 * with the git-path query), never string-joined onto `<repo>/.git/`. */
function gitDirPath(repoPath: string, rel: string): string {
  try {
    const p = execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-path', rel], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
    }).toString().trim();
    if (p) return isAbsolute(p) ? p : join(repoPath, p);
  } catch { /* fall through to the classic layout */ }
  return join(repoPath, '.git', rel);
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveHooksDir(repoPath: string): { dir: string; tracked: boolean } {
  let hooksPath = '';
  try {
    hooksPath = execFileSync('git', ['-C', repoPath, 'config', '--get', 'core.hooksPath'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
    }).toString().trim();
  } catch { /* unset — normal */ }
  if (hooksPath) {
    const dir = isAbsolute(hooksPath) ? hooksPath : join(repoPath, hooksPath);
    // A hooksPath in the working tree but outside the git dir (e.g. .githooks)
    // is a TRACKED location. Classify by path containment, never by a '.git'
    // substring, which matches '.githooks' and checkouts like 'site.github.io'.
    const tracked = pathContains(repoPath, dir) && !pathContains(gitDirPath(repoPath, ''), dir);
    return { dir, tracked };
  }
  return { dir: gitDirPath(repoPath, 'hooks'), tracked: false };
}

/** Ensure a repo-relative path is in the git exclude file so our hook stays untracked. */
export function ensureExcluded(repoPath: string, relPath: string): void {
  const exclude = gitDirPath(repoPath, 'info/exclude');
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
  const script = renderPostCommitHook(resolveGbrainCliPath());

  if (existsSync(hookPath)) {
    const cur = readFileSync(hookPath, 'utf-8');
    if (cur.includes(HOOK_BANNER)) {
      if (durabilityProtocolOf(cur) > DURABILITY_PROTOCOL) {
        return { status: 'needs_attention', detail: `${relative(repoPath, hookPath)} was written by a newer gbrain (protocol ${durabilityProtocolOf(cur)}); upgrade gbrain instead of downgrading it` };
      }
      if (tracked && !dryRun) ensureExcluded(repoPath, relative(repoPath, hookPath));
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

/**
 * True when the gbrain durability post-commit hook is installed — i.e. the
 * user opted this repo into push-durability via `gbrain sources harden`.
 * Cheap (one git-config read + one file read); used as the gate for
 * write-through auto-commit (#2426).
 */
export function isDurabilityHardened(repoPath: string): boolean {
  try {
    const { dir } = resolveHooksDir(repoPath);
    const hookPath = join(dir, 'post-commit');
    return existsSync(hookPath) && readFileSync(hookPath, 'utf-8').includes(HOOK_BANNER);
  } catch {
    return false;
  }
}

/**
 * #6210: the durability probe never reads a failure as "not hardened". A
 * failed probe is `git_unavailable` and the caller keeps its Git effect
 * unfinished; only a directory that is positively not a Git checkout
 * (`classifyGitCheckout`) or a hook file that is absent reads as false.
 */
function durabilityProbeFailure(detail: string): OperationError {
  return opError('git_unavailable', 'Cannot determine whether native Git durability is enabled.',
    `${detail} This does not show that durability is off, so the Git effect stays unfinished and retries; nothing was committed or pushed for it yet. Check that the checkout is readable and that git works there (git status in the checkout), then read the owner's effect status.`,
    { fix: readFix('Shows the canonical owner and its pending Git effects, read-only.', { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] }) });
}

/** A git probe that does not block the event loop. Exit 1 is an unset key for `config --get`; every other failure throws. */
async function gitProbe(repoPath: string, args: string[]): Promise<string> {
  const { error, stdout } = await execFileBounded('git', ['-C', repoPath, ...args],
    { timeout: 10_000, env: gitChildEnv({ ...GIT_ENV, LC_ALL: 'C', LANGUAGE: 'C' }) });
  if (!error) return stdout.trim();
  if (error.code === 1 && args[0] === 'config' && args[1] === '--get') return '';
  const status = typeof error.code === 'number' ? `exit ${error.code}` : typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'no exit status';
  throw durabilityProbeFailure(`git ${args.slice(0, 2).join(' ')} failed (${status}).`);
}

/**
 * {@link isDurabilityHardened} for long-running owners: the same two git
 * probes, run concurrently as child processes the event loop does not wait on.
 * Rejects with `git_unavailable` when it cannot tell (#6210).
 */
export async function isDurabilityHardenedAsync(repoPath: string): Promise<boolean> {
  const checkout = classifyGitCheckout(repoPath);
  if (checkout === 'not_git') return false;
  if (checkout === 'unknown') throw durabilityProbeFailure('The checkout directory, or a parent directory, could not be read.');
  const [hooksPath, gitHooks] = await Promise.all([gitProbe(repoPath, ['config', '--get', 'core.hooksPath']),
    gitProbe(repoPath, ['rev-parse', '--git-path', 'hooks'])]);
  const reported = hooksPath || gitHooks;
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- repoPath is a registered local worktree root and the hooks path comes from git itself, resolved exactly as resolveHooksDir/gitDirPath do
  const dir = !reported ? join(repoPath, '.git', 'hooks') : isAbsolute(reported) ? reported : join(repoPath, reported);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- fixed hook filename inside the git-reported hooks directory, as in isDurabilityHardened
  const hookPath = join(dir, 'post-commit');
  let hook: string;
  try {
    hook = readFileSync(hookPath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw durabilityProbeFailure(`The post-commit hook could not be read (${typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : 'read error'}).`);
  }
  return hook.includes(HOOK_BANNER);
}

/**
 * #2426: best-effort commit of a single write-through artifact so DB writes
 * reach git (the post-commit hook then background-pushes). Pre-fix,
 * write-through `.md` accumulated uncommitted forever: it never reached the
 * remote, froze `last_sync_at` (HEAD never moved), and a later `sync --full`
 * delete-reconcile treated the never-committed pages as disposable.
 *
 * #6530: commits only `<path>` (`commit --only`), always under the checkout's
 * commit lock. GBRA-180: a writer that holds the lock past the short budget
 * no longer gets a lockless commit racing it on the shared index; the page
 * write stands, the file goes into the pending ledger, and the next locked
 * write-through (or `gbrain git commit-push --pending`) commits it. A commit
 * git refuses unstages the path again, so nothing is left staged for another
 * writer's commit to sweep up. Never throws; returns false when nothing was
 * committed — the DB row and the on-disk file remain the durable sinks.
 *
 * `git add -- <path>` stages a removal as readily as an edit, so
 * `deletePageThrough` reuses this helper with `action: 'delete write-through'`
 * — same hardening gate, same explicit-path discipline, distinct subject line.
 */
export function commitWriteThroughFile(
  repoPath: string,
  absPath: string,
  slug: string,
  action: 'write-through' | 'delete write-through' = 'write-through',
): boolean {
  try {
    const rel = relative(repoPath, absPath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
    return commitPathsLocked(repoPath, [absPath], `gbrain: ${action} ${slug}`, { lockWaitMs: WRITE_THROUGH_LOCK_WAIT_MS }) !== null;
  } catch {
    return false;
  }
}

const WRITE_THROUGH_LOCK_WAIT_MS = 2_000;

// ── Push-state query (D14) ───────────────────────────────────────────────────

export type PushLogStatus = 'ok' | 'needs_attention' | 'unknown';

export interface PushLogOutcome {
  status: PushLogStatus;
  detail: string;
  /** UTC timestamp parsed from the log line, when found. */
  at?: string;
}

const PUSH_LOG_OK = /^(\S+) \[push\] (?:ok|ok-after-rebase|ok-after-merge|ok-already-on-remote) (\S+)\b/;
const PUSH_LOG_LOCAL_ONLY = /^(\S+) \[push\] (?:LOCAL-ONLY|CONFLICT), NEEDS ATTENTION: (\S+) /;

export type PushLogKind = 'ok' | 'ok-after-merge' | 'nothing' | 'local-only' | 'conflict' | 'lock-timeout' | 'checkout-lagging';

/**
 * #6530: one `brain-push.log` line per `gbrain git commit-push` outcome, in the
 * grammar {@link getLastPushOutcome} parses (put_page's `lastPushStatus`).
 * `checkout-lagging` is informational: the push landed. Best-effort.
 */
export function appendPushLog(kind: PushLogKind, branch: string, sha: string, detail?: string): void {
  try {
    const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const short = sha ? sha.slice(0, 7) : '-';
    const clean = (detail ?? '').replace(/\s+/g, ' ').slice(0, 200);
    const line = kind === 'ok' ? `[push] ok ${branch} ${short}`
      : kind === 'ok-after-merge' ? `[push] ok-after-merge ${branch} ${short}`
      : kind === 'nothing' ? `[push] ok-already-on-remote ${branch} ${short}`
      : kind === 'lock-timeout' ? `[push] lock-timeout ${branch}`
      : kind === 'checkout-lagging' ? `[push] checkout-lagging ${branch} ${short} ${clean}`
      : kind === 'conflict' ? `[push] CONFLICT, NEEDS ATTENTION: ${branch} local and remote changed the same file. Run: gbrain git commit-push --push-only --resolve <path>=ours|theirs`
      : `[push] LOCAL-ONLY, NEEDS ATTENTION: ${branch} @ ${short} could not reach the remote. Run: gbrain git commit-push --push-only`;
    const p = pushLogPath();
    mkdirSync(dirname(p), { recursive: true });
    if (!existsSync(p)) writeFileSync(p, '', { mode: 0o600 });
    appendFileSync(p, `${at} ${line}\n`);
  } catch { /* best-effort */ }
}
const PUSH_LOG_LOCK_TIMEOUT = /^(\S+) \[push\] lock-timeout (\S+)\b/;

/**
 * Best-effort read of the most recently logged push outcome for `branch`,
 * from the shared hook log ($GBRAIN_HOME/brain-push.log). The push itself
 * runs detached in the background (see `renderPostCommitHook`), so nothing
 * synchronous ever learns whether a given commit's own push landed — this is
 * the queryable substitute: "as of the last thing the hook logged for this
 * branch, were pushes landing?"
 *
 * The log is host-wide and keyed only by branch name, not repo path, so two
 * different hardened repos sharing a branch name (e.g. both on `main`) share
 * this signal. That's an acceptable approximation for a liveness check, not
 * a per-repo guarantee. With `repo`, an unresolved integrate_conflict recorded
 * in that checkout (#6530) wins over the log.
 */
export function getLastPushOutcome(branch: string, repo?: string): PushLogOutcome {
  const conflict = repo ? readIntegrateConflict(repo) : null;
  if (conflict && conflict.branch === branch) {
    return { status: 'needs_attention', at: conflict.at,
      detail: `unresolved integrate_conflict on ${branch} (${conflict.paths.join(', ')}): run gbrain git commit-push --push-only --expect-remote ${String(conflict.remote).slice(0, 12)} --resolve <path>=ours|theirs` };
  }
  const log = pushLogPath();
  if (!existsSync(log)) return { status: 'unknown', detail: 'no push attempts logged yet' };

  let lines: string[];
  try {
    lines = readFileSync(log, 'utf-8').split('\n');
  } catch (e) {
    return { status: 'unknown', detail: `push log unreadable: ${(e as Error).message}` };
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let m = line.match(PUSH_LOG_OK);
    if (m && m[2] === branch) return { status: 'ok', detail: line.trim(), at: m[1] };
    m = line.match(PUSH_LOG_LOCAL_ONLY);
    if (m && m[2] === branch) return { status: 'needs_attention', detail: line.trim(), at: m[1] };
    m = line.match(PUSH_LOG_LOCK_TIMEOUT);
    if (m && m[2] === branch) return { status: 'needs_attention', detail: line.trim(), at: m[1] };
  }
  return { status: 'unknown', detail: `no push attempt logged yet for branch '${branch}'` };
}

// ── Committed helper ────────────────────────────────────────────────────────

function installHelper(repoPath: string, dryRun: boolean): { status: StepStatus; detail: string } {
  const helperPath = join(repoPath, HELPER_REL);
  const script = renderCommitPushHelper();
  if (existsSync(helperPath) && durabilityProtocolOf(readFileSync(helperPath, 'utf-8')) > DURABILITY_PROTOCOL) {
    return { status: 'needs_attention', detail: `${HELPER_REL} was written by a newer gbrain (protocol ${durabilityProtocolOf(readFileSync(helperPath, 'utf-8'))}); upgrade gbrain instead of downgrading it` };
  }
  if (existsSync(helperPath) && readFileSync(helperPath, 'utf-8') === script) {
    // Ensure exec bit even when content is current — but not in dry-run: a
    // preview must not mutate permissions (#3736).
    if (!dryRun) { try { chmodSync(helperPath, 0o755); } catch { /* */ } }
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
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
    }).toString().trim();
  } catch { return ''; }
}
function gitConfigSet(repoPath: string, key: string, value: string): void {
  execFileSync('git', ['-C', repoPath, 'config', key, value], {
    stdio: 'ignore', timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
  });
}
function gitConfigUnset(repoPath: string, key: string): void {
  try {
    execFileSync('git', ['-C', repoPath, 'config', '--unset-all', key], {
      stdio: 'ignore', timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
    });
  } catch { /* not set */ }
}

function remoteHost(repoPath: string): string {
  try {
    const url = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
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

  ensureGbrainHome(); // S3#10/CX2-8: single choke point — creates + chmods 0700
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

/** Default scheduled-pull interval — ONE definition (harden + doctor probe). */
export const DEFAULT_PULL_INTERVAL_SEC = 1800;

export interface DurabilityJobStatus {
  kind: 'launchd' | 'crontab' | 'none';
  wrapperPresent: boolean;
  /** Liveness rung [D7]: darwin = launchctl reports the label loaded; linux =
   * the crontab line exists. undefined = probe unavailable on this host. */
  live?: boolean;
  /** Pull log fresher than 2× the interval. undefined = no log yet (fresh
   * install / never fired) — absence is not evidence of death. */
  logFresh?: boolean;
}

/**
 * Presence + LIVENESS of the scheduled-pull job [D7]. Presence-only checks
 * (existsSync on the plist) certify dead jobs as healthy — the documented
 * autopilot-status failure mode — so this probes whether the job is actually
 * loaded/registered and whether its log shows recent life.
 */
export function durabilityJobStatus(
  sourceId: string,
  intervalSec = DEFAULT_PULL_INTERVAL_SEC,
  platform: NodeJS.Platform = process.platform,
): DurabilityJobStatus {
  const wrapperPresent = existsSync(cronWrapperPath(sourceId));
  let kind: DurabilityJobStatus['kind'] = 'none';
  let live: boolean | undefined;
  if (platform === 'darwin') {
    if (existsSync(launchdPlistPath(sourceId))) {
      kind = 'launchd';
      try {
        execFileSync('launchctl', ['list', cronLabel(sourceId)], {
          stdio: 'ignore', timeout: 5_000, env: process.env,
        });
        live = true;
      } catch {
        live = false; // plist on disk but not loaded — the dead-job shape
      }
    }
  } else if (binaryOnPath('crontab')) {
    try {
      const tab = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8', env: process.env });
      if (tab.includes(cronLabel(sourceId))) {
        kind = 'crontab';
        live = true; // the line exists; cron itself is the OS's liveness domain
      }
    } catch { /* no crontab for this user */ }
  }
  let logFresh: boolean | undefined;
  try {
    const log = join(gbrainHome(), 'brain-pull.log');
    if (existsSync(log)) {
      logFresh = Date.now() - statSync(log).mtimeMs <= 2 * intervalSec * 1000;
    }
  } catch { /* leave undefined */ }
  return { kind, wrapperPresent, ...(live !== undefined ? { live } : {}), ...(logFresh !== undefined ? { logFresh } : {}) };
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
# Self-disable when the captured checkout is no longer a git working tree:
# gone, OR its path reused by a non-git directory. git rev-parse recognizes
# both the classic .git-dir layout AND worktrees/submodules (where the git
# marker is a FILE), so a bare dir test would wrongly disable a live worktree.
if ! git -C '${q(repoPath)}' rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) [cron] not a git work tree, skipping: ${q(repoPath)}" >> "${q(logPath)}" 2>/dev/null || true
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

export function generateBrainPullPlist(label: string, wrapperPath: string, gbrainDir: string, intervalSec: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key><array><string>${esc(wrapperPath)}</string></array>
  <key>StartInterval</key><integer>${intervalSec}</integer>
  <key>StandardOutPath</key><string>${esc(gbrainDir)}/brain-pull.log</string>
  <key>StandardErrorPath</key><string>${esc(gbrainDir)}/brain-pull.err</string>
</dict>
</plist>`;
}

export function installDurabilityCron(
  sourceId: string,
  repoPath: string,
  branch: string,
  intervalSec: number,
  dryRun: boolean,
  platform: NodeJS.Platform = process.platform,
): { status: StepStatus; detail: string } {
  // Probe FIRST [D-cloud/B2]: containers and cloud sandboxes ship without
  // crontab, and that is EXPECTED there — the honest answer is a skip that
  // names what still covers persistence, not a needs_attention that reads
  // like a bug (and no wrapper file is written for a job that can't exist).
  if (platform !== 'darwin' && !binaryOnPath('crontab')) {
    return {
      status: 'skipped',
      detail:
        'no crontab on this host (container/cloud sandbox) — scheduled pull skipped; ' +
        'the post-commit auto-push and per-turn/session-end pushes cover persistence here. ' +
        'Run `gbrain sources harden <id>` on a persistent machine to add the scheduled pull.',
    };
  }
  const wrapper = dryRun ? cronWrapperPath(sourceId) : writeCronWrapper(sourceId, repoPath, branch);
  if (platform === 'darwin') {
    const plistPath = launchdPlistPath(sourceId);
    if (dryRun) return { status: 'fixed', detail: `would install launchd ${cronLabel(sourceId)} every ${intervalSec}s (dry-run)` };
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, generateBrainPullPlist(cronLabel(sourceId), wrapper, gbrainHome(), intervalSec));
    try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* */ }
    try { execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' }); } catch { /* loaded best-effort */ }
    return { status: 'fixed', detail: `launchd ${cronLabel(sourceId)} every ${intervalSec}s` };
  }
  // Linux: crontab line, deduped on the label marker.
  const minutes = Math.max(1, Math.round(intervalSec / 60));
  const marker = `# ${cronLabel(sourceId)}`;
  const cronLine = `*/${minutes} * * * * ${wrapper} ${marker}`;
  if (dryRun) return { status: 'fixed', detail: `would install crontab (every ${minutes}m) (dry-run)` };
  // env: process.env on both calls — Bun otherwise resolves `crontab` against
  // the STARTUP env snapshot, making runtime PATH changes (and PATH-shimmed
  // test fakes) invisible (the workspace-push.ts / status.ts precedent).
  let existingCron = '';
  try { existingCron = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8', env: process.env }); } catch { /* none */ }
  const kept = existingCron.split('\n').filter(l => l && !l.includes(marker));
  const next = [...kept, cronLine, ''].join('\n');
  try {
    execSync('crontab -', { input: next, stdio: ['pipe', 'ignore', 'ignore'], env: process.env });
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

/**
 * CX2-3: resolve the repo ROOT for any directory inside it (the sync.ts
 * `discoverGitRoot` precedent). A workspace layout registers `repo/brain` as
 * the source dir while the enclosing repo owns `.git` — hardening must
 * assert/operate on the PARENT repo, not fail on the subdir's missing `.git`.
 */
/**
 * GBRA-180: a source whose root sits below the checkout toplevel (a brain folder inside a larger repository)
 * records that root in `gbrain.sourceRoot`, so `gbrain git commit-push` refuses commits and publishes that
 * change files outside it. A source at the toplevel records nothing unless another source already narrowed
 * the checkout. Best-effort.
 */
function recordSourceRoot(top: string, sourcePath: string): void {
  const run = (args: string[]) => execFileSync('git', ['-C', top, 'config', '--local', ...args], {
    stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }) }).toString();
  try {
    const rel = relative(realpathSync(top), realpathSync(sourcePath)).split(sep).join('/');
    if (rel.startsWith('..') || isAbsolute(rel)) return;
    let current: string[] = [];
    try { current = run(['--get-all', SOURCE_ROOT_CONFIG]).split('\n').map(v => v.trim()).filter(Boolean); } catch { /* unset */ }
    const value = rel || '.';
    if (current.includes(value) || (!rel && !current.length)) return;
    run(['--add', SOURCE_ROOT_CONFIG, value]);
  } catch { /* best-effort: without it commit-push treats the whole checkout as the root */ }
}

function resolveRepoRoot(path: string): string {
  try {
    return execFileSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
    }).toString().trim();
  } catch {
    throw new Error(`not a git repo: ${path}`);
  }
}

export function currentBranch(repoPath: string): string {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
    }).toString().trim();
  } catch { return 'HEAD'; }
}

function headSha(repoPath: string): string {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
    }).toString().trim();
  } catch { return ''; }
}

function pullDetail(o: PullOutcome): { status: StepStatus; detail: string } {
  switch (o.status) {
    case 'up_to_date': return { status: 'ok', detail: 'already up to date with origin' };
    case 'advanced': return { status: 'fixed', detail: `advanced ${o.from.slice(0, 7)}→${o.to.slice(0, 7)}` };
    case 'skipped_dirty': return { status: 'skipped', detail: 'working tree dirty — pull skipped (in-progress edits preserved)' };
    case 'skipped_busy': return { status: 'skipped', detail: 'another writer holds the commit lock — pull skipped; the next run catches up' };
    case 'conflict_aborted': return { status: 'needs_attention', detail: o.detail };
  }
}

/**
 * Harden a brain repo for durability. Idempotent: a second run on an
 * already-hardened repo produces all ok/skipped and NO new commit.
 */
export async function hardenBrainRepo(opts: HardenOpts): Promise<DurabilityReport> {
  // #5182: a managed canonical worktree gets no hook, cron or helper here — the
  // owner's recorded git_durability setting decides, and its verb installs
  // the credential. Name that verb instead of the bare coordinator refusal.
  const managed = managedFilesystemRootFor(opts.repoPath);
  if (managed && !hasFilesystemPublication(opts.repoPath)) {
    const sourceId = managed.sourceId ?? opts.sourceId;
    throw opError('writer_coordinator_required',
      `${opts.repoPath} is the managed canonical worktree of source ${sourceId}; its Git durability is an owner setting, not a hook.`,
      `Run gbrain sources writer git-durability ${sourceId} --enable${opts.pat ? ' --pat-file <path>' : ''} (add --dry-run to preview). The owner commits and pushes page writes itself; no pull cron or post-commit hook is installed on a managed root.`,
      { fix: readFix('Shows the owner and whether it commits and pushes page writes, read-only.', { argv: ['gbrain', 'sources', 'writer', 'status', sourceId, '--json'] }) });
  }
  if (!opts.dryRun) assertManagedFilesystemWrite(opts.repoPath);
  const { sourceId } = opts;
  const dryRun = !!opts.dryRun;
  const installCron = opts.installCron !== false;
  const verify = opts.verify !== false;
  const intervalSec = opts.intervalSec ?? DEFAULT_PULL_INTERVAL_SEC;
  const redact = opts.pat ? (s: string) => redactSecretsInText(s, new Map([['github_pat', opts.pat!]])) : (s: string) => s;
  const log = (l: string) => opts.logger?.(redact(l));

  // CX2-3: throws `not a git repo: <path>` when the dir isn't inside one;
  // otherwise every subsequent step operates on the enclosing repo's root.
  const repoPath = resolveRepoRoot(opts.repoPath);
  if (!dryRun) maintainPushLog(); // S3#10 — 0600 + 1MB rotation

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
  } else if (dryRun) {
    push('pull', { status: 'skipped', detail: `dry-run — would fetch origin/${branch} and fast-forward (or merge in memory)` });
  } else {
    // 1. pull current state
    try { push('pull', pullDetail(divergenceSafePull(repoPath, branch, { strategy: opts.pullStrategy }))); }
    catch (e) { push('pull', { status: 'needs_attention', detail: `fetch/pull failed: ${(e as Error).message.slice(0, 140)}` }); }
  }

  // 2. credential
  if (opts.pat) push('credential', wireRepoCredential(repoPath, opts.pat, dryRun));
  else push('credential', { status: 'skipped', detail: 'no PAT provided — relying on existing git auth' });

  // 3. local untracked hook (+ #6530 local git config: the CLI path the
  // helper falls back to, and autostash off / pull.ff=only so a stray
  // `git pull` in the shared checkout refuses instead of stashing others' work)
  push('hook', installLocalHook(repoPath, dryRun));
  if (!dryRun) {
    try {
      gitConfigSet(repoPath, 'gbrain.cliPath', resolveGbrainCliPath());
      gitConfigSet(repoPath, 'rebase.autoStash', 'false');
      gitConfigSet(repoPath, 'merge.autoStash', 'false');
      gitConfigSet(repoPath, 'pull.ff', 'only');
    } catch { /* best-effort: the helper still resolves gbrain from PATH */ }
    recordSourceRoot(repoPath, opts.repoPath);
  }
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
  // Only the durability artifacts we manage, through the shared-checkout
  // protocol (#6530): commit --only those paths under the commit lock, push,
  // merge remote commits in memory if the push is rejected. The commit carries
  // the lock marker, so the freshly installed post-commit hook stands down and
  // this push is the only one (#3925).
  const paths: string[] = [HELPER_REL];
  const resolver = findResolverFile(repoPath);
  if (resolver) paths.push(relative(repoPath, resolver));
  try {
    const r = commitAndPush({ repo: repoPath, paths, cwd: repoPath, message: 'chore(gbrain): install brain durability scaffolding', allowOutsideSourceRoot: true });
    if (r.branch !== branch) return { status: 'needs_attention', detail: `checkout is on ${r.branch}, not ${branch}` };
    if (r.outcome === 'nothing_to_commit') return { status: 'ok', detail: 'scaffolding already committed' };
    return { status: 'fixed', detail: `committed + pushed durability scaffolding${r.checkout === 'lagging' ? ` (checkout lagging: ${r.lagging_reason})` : ''}` };
  } catch (e) {
    return { status: 'needs_attention', detail: redact(`scaffolding commit/push failed: ${(e as Error).message.slice(0, 140)}`) };
  }
}

function headMatchesOrigin(repoPath: string, branch: string): boolean {
  try {
    const local = headSha(repoPath);
    const remote = execFileSync('git', ['-C', repoPath, 'rev-parse', `origin/${branch}`], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
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
