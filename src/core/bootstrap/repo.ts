/**
 * `gbrain bootstrap repo` — private-repo creation with a hard privacy gate
 * [G8, CX2-1, plan D6]. Library module: the CLI dispatcher wires it later.
 *
 * Invariants (G8):
 *  - A pre-existing `origin` is accepted in exactly two shapes, else refused
 *    (pointed at `attach`): (a) the receipt already recorded this exact
 *    `repo_url` (idempotent re-run -> disposition 'reused'); or (b) the origin
 *    is owned by the authed gh user with NO recorded `repo_url` AND is SAFE to
 *    adopt -> disposition 'adopted'. SAFE means EMPTY (`assertAdoptableOrigin`),
 *    or a non-empty remote that matches this workspace's `pending_repo_url`
 *    proof (our own interrupted push, resumable). A non-empty remote with no
 *    matching pending marker is refused (`ORIGIN_NOT_EMPTY`) — we never adopt a
 *    user's existing project from a git-ancestry guess. Org-owned origins
 *    (owner != login) are out of scope.
 *  - Repo-local git identity (from the authed gh user) is set in BOTH the
 *    create and adopt paths before any commit; `repo_url` is recorded only
 *    AFTER a successful push (a push failure must never look "done" to status).
 *  - Repo privacy is verified via the GitHub API; the answer
 *    must be the literal `true`. "Couldn't verify" (rate limit / 5xx) is a
 *    typed refuse-and-re-run, NEVER treated as private or public. The first
 *    push happens only AFTER the verify passes (create runs without --push).
 *  - Idempotent re-runs key off the REMOTE URL, not the name probe — a name
 *    probe can be fooled by an unrelated repo taking the slug. A receipt
 *    missing repo_url (crash window) adopts an origin only when the authed
 *    gh user owns it; undefined is never a wildcard.
 *
 * All gh/git interaction goes through an injectable `ExecRunner` so tests use
 * a recording fake; the default spawns via Bun. Commands are argv arrays
 * (never shell strings); git commands carry `-C <workspace>` and
 * `gh repo create` uses `--source <workspace>` so the runner needs no cwd.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../config.ts';
import { realpathOrResolve } from '../path-confine.ts';
import { defaultRunner, isProxyBlocked403, parseGithubOwnerRepo, type ExecRunner } from '../repo-visibility.ts';
import { detectExecutionEnvironment } from '../execution-env.ts';
import { loadWorkspaceAllowlist, scanFiles, SCAN_ALLOW_FILENAME } from '../secret-scan.ts';
import { GITHUB_URL_PLACEHOLDER } from './assets.ts';
import {
  guardReceiptOverwrite,
  readManifest,
  readReceipt,
  writeReceipt,
  type AgentManifest,
  type InstallReceipt,
  type ManifestState,
} from './format.ts';
import { BootstrapError } from './lock.ts';

// ---------------------------------------------------------------------------
// Exec seam (shared by uninstall.ts; the dispatcher passes the real runner)
// ---------------------------------------------------------------------------

// Canonical definitions moved to repo-visibility.ts (the visibility ladder
// needs the same seam and must stay a leaf module); re-exported here so every
// existing consumer (uninstall.ts, bootstrap.ts, tests) keeps its import path.
export { defaultRunner, type ExecResult, type ExecRunner } from '../repo-visibility.ts';

// ---------------------------------------------------------------------------
// Receipt extension: the created repo URL [CX2-12 idempotency key]
// ---------------------------------------------------------------------------

/** The receipt gains the created repo URL; format.ts consumers tolerate
 * unknown fields, so this is a structural extension, not a format bump. */
export interface RepoReceipt extends InstallReceipt {
  repo_url?: string;
  /** Proof-of-intent written BEFORE the first push and cleared once `repo_url`
   * is recorded. If a push lands but the run crashes before recording `repo_url`,
   * a re-run sees a non-empty origin that matches `pending_repo_url` and knows
   * the content is OURS (safe to resume) rather than a user's existing project
   * (which would carry no pending marker). See createPrivateRepo Gate 4. */
  pending_repo_url?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The one copy of the cloud repo-adoption instruction (two error sites). */
export const CLOUD_ATTACH_FLOW_HINT =
  'Create the private repo from a normal machine (or github.com), open a cloud session ON that repo, ' +
  'then run `gbrain bootstrap attach`.';

/** GitHub repo-name slug: lowercase, alnum runs joined by '-'. */
export function slugifyRepoName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'agent';
}

/** Parse owner/name out of an https or ssh GitHub remote URL. Thin adapter
 * over the canonical repo-visibility parser (one grammar, three consumers). */
export function parseGithubRemote(url: string): { owner: string; name: string } | null {
  const p = parseGithubOwnerRepo(url);
  return p ? { owner: p.owner, name: p.repo } : null;
}

/** Re-exported for existing consumers; the single definition lives in
 * assets.ts (shared with render.ts's DERIVED_DEFAULTS). */
export { GITHUB_URL_PLACEHOLDER };

function requireInitializedManifest(workspaceDir: string): { state: ManifestState; manifest: AgentManifest } {
  const state = readManifest(workspaceDir);
  switch (state.state) {
    case 'initialized':
      return { state, manifest: state.manifest };
    case 'template':
      throw new BootstrapError(
        'TEMPLATE_UNINITIALIZED',
        'this is an uninitialized template — run `gbrain bootstrap render` first',
      );
    case 'absent':
      throw new BootstrapError(
        'NOT_A_WORKSPACE',
        `not an agent workspace (no agent.json in ${workspaceDir}) — run \`gbrain bootstrap render\` first`,
      );
    case 'invalid':
      throw new BootstrapError('MANIFEST_INVALID', `agent.json is invalid: ${state.reason}`);
    case 'newer_format':
      throw new BootstrapError(
        'NEWER_FORMAT',
        `agent.json format_version ${state.manifest.format_version} is newer than this gbrain understands — upgrade gbrain first`,
      );
  }
}

function isRateLimitOr5xx(stderr: string): boolean {
  return /HTTP 5\d\d|HTTP 429|rate limit/i.test(stderr);
}

/** `gh auth status`'s `--active` flag (added in cli/cli v2.57.0, 2024-09-11)
 * scopes the check to only the active account instead of aggregating every
 * registered account. On an older `gh`, passing an unrecognized flag makes
 * the WHOLE command fail — so Gate 2 must detect support before using it. */
const GH_ACTIVE_FLAG_MIN_VERSION = [2, 57, 0] as const;

/** Parses the `X.Y.Z` out of `gh --version`'s first line (`gh version X.Y.Z (DATE)`).
 * Returns null on any unrecognized format — callers treat that as "unknown,
 * don't assume support". */
function parseGhVersion(versionOutput: string): readonly [number, number, number] | null {
  const m = /\bgh version (\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function ghVersionAtLeast(v: readonly [number, number, number], min: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i]! > min[i]!;
  }
  return true;
}

/** The authenticated gh login, or null when it cannot be read/parsed. */
async function fetchAuthedLogin(runner: ExecRunner): Promise<string | null> {
  const res = await runner(['gh', 'api', 'user']);
  if (res.code !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { login?: unknown };
    return typeof parsed.login === 'string' && parsed.login.length > 0 ? parsed.login : null;
  } catch {
    return null;
  }
}

/** The authed gh user's login + id. Throws GH_AUTH (exit 2) on failure. */
async function resolveGhIdentity(runner: ExecRunner): Promise<{ login: string; userId: number | string }> {
  const userRes = await runner(['gh', 'api', 'user']);
  if (userRes.code !== 0) {
    throw new BootstrapError(
      'GH_AUTH',
      `could not read the authenticated GitHub user (gh api user failed: ${userRes.stderr.trim() || `exit ${userRes.code}`}) — check \`gh auth status\``,
      { exitCode: 2 },
    );
  }
  try {
    const parsed = JSON.parse(userRes.stdout) as { login?: unknown; id?: unknown };
    if (typeof parsed.login !== 'string' || parsed.login.length === 0) throw new Error('missing login');
    const userId = typeof parsed.id === 'number' || typeof parsed.id === 'string' ? parsed.id : 0;
    return { login: parsed.login, userId };
  } catch (e) {
    throw new BootstrapError('GH_AUTH', `unexpected \`gh api user\` output (${(e as Error).message})`, { exitCode: 2 });
  }
}

/**
 * Set the repo-local git author identity from the authed gh user (never touches
 * global git config). Required before ANY commit — a freshly cloned repo on a
 * machine with no global `user.name`/`user.email` would otherwise fail at commit.
 * Runs in both the create AND adoption paths (the adoption path is why this is a
 * shared helper — a clone-then-adopt on a fresh machine hit exactly this).
 */
async function setRepoLocalIdentity(
  runner: ExecRunner,
  workspaceDir: string,
  ident: { login: string; userId: number | string },
): Promise<void> {
  // Fail loudly if the config writes fail — otherwise a later commit falls back
  // to (possibly absent) global identity and dies with a misleading error.
  const nameRes = await runner(['git', '-C', workspaceDir, 'config', 'user.name', ident.login]);
  const emailRes = await runner([
    'git', '-C', workspaceDir, 'config', 'user.email',
    `${ident.userId}+${ident.login}@users.noreply.github.com`,
  ]);
  const failed = nameRes.code !== 0 ? nameRes : emailRes.code !== 0 ? emailRes : null;
  if (failed) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `could not set the repo-local git identity (git config failed: ${failed.stderr.trim() || `exit ${failed.code}`}) — commits would fail; fix the git state and re-run \`gbrain bootstrap repo\``,
    );
  }
}

/**
 * Guard for the create-repo-first / pre-record adoption path (an origin the human
 * created, with no recorded `repo_url` yet). The origin must be EMPTY to adopt.
 *
 * Empty-only is deliberate. A non-empty remote cannot be proven to be OURS from
 * git alone — "remote HEAD equals/precedes local HEAD" is ALSO true of a user's
 * own existing project that `render` happened to run inside, so an ancestor/SHA
 * heuristic would silently adopt (and later push identity/personal data into)
 * that project. We refuse instead. The happy path stays empty because the
 * no-daemon push is gated until the repo phase records `repo_url` (see
 * `repoPhaseComplete` in hook.ts), so nothing lands on the remote before this
 * runs. Genuinely-ours interrupted pushes are matched separately by
 * `pending_repo_url` at the call site — this function is the fallback for
 * everything else. Throws on refusal; never adopts on uncertainty.
 */
async function assertAdoptableOrigin(
  runner: ExecRunner,
  workspaceDir: string,
  owner: string,
  name: string,
): Promise<void> {
  const ls = await runner(['git', '-C', workspaceDir, 'ls-remote', 'origin']);
  if (ls.code !== 0) {
    throw new BootstrapError(
      'REMOTE_CHECK_FAILED',
      `could not list ${owner}/${name} to confirm it is safe to adopt (git ls-remote failed: ${ls.stderr.trim() || `exit ${ls.code}`}) — nothing was pushed; re-run \`gbrain bootstrap repo\``,
      { details: { owner, name } },
    );
  }
  // All refs (not just --heads): a repo with only tags is not "empty".
  if (ls.stdout.trim().length === 0) return; // genuinely empty → safe to adopt

  throw new BootstrapError(
    'ORIGIN_NOT_EMPTY',
    `${owner}/${name} already has content that bootstrap did not put there. ` +
      '`gbrain bootstrap repo` adopts only an EMPTY repo you just created. ' +
      'Create a new EMPTY private repo (no README/.gitignore/license) under your own account and point this workspace at it, ' +
      'or run `gbrain bootstrap attach` if this is an existing agent workspace.',
    { details: { owner, name } },
  );
}

/**
 * Privacy verify [G8]: `gh api repos/{owner}/{name} --jq .private` must print
 * the literal `true`. Any failure to VERIFY is VERIFY_UNAVAILABLE (refuse +
 * re-run) — never interpreted as an answer. An affirmative non-`true` answer
 * is the hard REPO_NOT_PRIVATE stop. Defense in depth: the repo owner must be
 * the authenticated gh user — a private repo someone ELSE owns is still not
 * ours to bless.
 */
async function verifyRepoPrivate(runner: ExecRunner, owner: string, name: string): Promise<void> {
  const login = await fetchAuthedLogin(runner);
  if (login === null) {
    throw new BootstrapError(
      'VERIFY_UNAVAILABLE',
      `could not read the authenticated GitHub user to verify ownership of ${owner}/${name} — check \`gh auth status\` and re-run \`gbrain bootstrap repo\`.`,
      { details: { owner, name } },
    );
  }
  if (login !== owner) {
    throw new BootstrapError(
      'ORIGIN_EXISTS',
      `${owner}/${name} is owned by ${owner}, not the authenticated GitHub user (${login}) — ` +
        'bootstrap only blesses repos it created under your own account. ' +
        'If this is a clone of an existing agent workspace, run `gbrain bootstrap attach` instead.',
      { details: { owner, name, login } },
    );
  }
  const res = await runner(['gh', 'api', `repos/${owner}/${name}`, '--jq', '.private']);
  if (res.code !== 0) {
    // Classify the failure so the operator gets the REAL fix: a sandbox
    // egress proxy blocking REST for a repo not attached to the session is a
    // different problem from a token/rate-limit failure [D14 messaging].
    const proxyBlocked = isProxyBlocked403(res.stderr);
    const reason = proxyBlocked
      ? "this sandbox's egress proxy blocks GitHub REST for repos not attached to the session"
      : isRateLimitOr5xx(res.stderr)
        ? 'GitHub API rate limit / server error'
        : `gh api failed: ${res.stderr.trim() || `exit ${res.code}`}`;
    const nextStep = proxyBlocked ? CLOUD_ATTACH_FLOW_HINT : 'The repo may be fine — re-run `gbrain bootstrap repo` to verify.';
    throw new BootstrapError(
      'VERIFY_UNAVAILABLE',
      `could not verify that ${owner}/${name} is private (${reason}). ` +
        `${nextStep} Nothing is pushed to a repo whose privacy is unverified.`,
      { details: { owner, name, stderr: res.stderr } },
    );
  }
  if (res.stdout.trim() !== 'true') {
    throw new BootstrapError(
      'REPO_NOT_PRIVATE',
      `${owner}/${name} is NOT private (API said: ${res.stdout.trim() || 'empty'}). ` +
        'Make it private in the GitHub settings (or delete it) before re-running `gbrain bootstrap repo`.',
      { details: { owner, name, answer: res.stdout.trim() } },
    );
  }
}

/** Replace the GITHUB.md placeholder line with the real URL (simple string
 * replace; also fills a still-raw {{GITHUB_REPO_URL}} token defensively so a
 * later verify token-sweep can't trip on it). */
function updateGithubMd(workspaceDir: string, url: string): void {
  const path = join(workspaceDir, 'GITHUB.md');
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  const next = raw.split(GITHUB_URL_PLACEHOLDER).join(url).split('{{GITHUB_REPO_URL}}').join(url);
  if (next !== raw) writeFileSync(path, next, 'utf8');
}

/** Load-or-synthesize the machine-local receipt (minimal one when render's is
 * missing — crash between render and receipt write), with the bootstrap/ subdir
 * ensured and the overwrite guard run. Shared by the record helpers. */
function loadReceiptForWrite(gbrainHomeDir: string, workspaceDir: string, manifest: AgentManifest): RepoReceipt {
  const existing = readReceipt(gbrainHomeDir) as RepoReceipt | null;
  const receipt: RepoReceipt = existing ?? {
    receipt_version: 1,
    workspace_dir: realpathOrResolve(workspaceDir),
    source_id: manifest.source_id,
    agent_name: manifest.agent_name,
    created_at: new Date().toISOString(),
    created_by: manifest.created_by,
    brain_created_by_bootstrap: false,
    created_paths: [],
    registrations: [],
  };
  // writeReceipt assumes the bootstrap/ subdir exists (render creates it);
  // repo may run first after a crash, so create it defensively.
  mkdirSync(join(gbrainHomeDir, 'bootstrap'), { recursive: true });
  const guard = guardReceiptOverwrite(gbrainHomeDir); // throws on newer-format receipts
  if (guard.brokenBackupPath) {
    console.error(`WARNING: the install receipt was unreadable; backed it up to ${guard.brokenBackupPath} and wrote a fresh one.`);
  }
  return receipt;
}

/** Proof-of-intent: record `pending_repo_url` BEFORE the first push, so a
 * post-push/pre-record crash is recognized as OURS on re-run (see Gate 4). */
function recordPendingRepo(gbrainHomeDir: string, workspaceDir: string, manifest: AgentManifest, url: string): void {
  const receipt = loadReceiptForWrite(gbrainHomeDir, workspaceDir, manifest);
  receipt.pending_repo_url = url;
  writeReceipt(gbrainHomeDir, receipt);
}

/** Record the created/adopted repo URL AFTER a successful push, clearing the
 * pending marker (the durable idempotency key). */
function recordRepoInReceipt(gbrainHomeDir: string, workspaceDir: string, manifest: AgentManifest, url: string): void {
  const receipt = loadReceiptForWrite(gbrainHomeDir, workspaceDir, manifest);
  receipt.repo_url = url;
  delete receipt.pending_repo_url;
  writeReceipt(gbrainHomeDir, receipt);
}

// ---------------------------------------------------------------------------
// First-push content + push-target binding [FIX3, FIX4]
// ---------------------------------------------------------------------------

/** Files git would include in a commit right now (staged + untracked, minus
 * ignored), relative to the workspace — the input to the pre-commit scan.
 * Fail-closed: a `git ls-files` failure is a hard refuse, NEVER a vacuous empty
 * set (an empty set would let the secret scan pass without seeing anything). */
async function stagedAndUntrackedFiles(runner: ExecRunner, workspaceDir: string): Promise<string[]> {
  const res = await runner([
    'git', '-C', workspaceDir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ]);
  if (res.code !== 0) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `could not enumerate files for the pre-push secret scan (git ls-files failed: ${res.stderr.trim() || `exit ${res.code}`}) — nothing was committed or pushed; fix the git state and re-run \`gbrain bootstrap repo\``,
    );
  }
  return res.stdout.split('\0').filter((s) => s.length > 0);
}

/** Tracked files in the current HEAD tree — the set that would be pushed when a
 * clean commit already exists. Fail-closed like stagedAndUntrackedFiles. */
async function trackedFiles(runner: ExecRunner, workspaceDir: string): Promise<string[]> {
  const res = await runner(['git', '-C', workspaceDir, 'ls-files', '-z']);
  if (res.code !== 0) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `could not enumerate tracked files for the pre-push secret scan (git ls-files failed: ${res.stderr.trim() || `exit ${res.code}`}) — nothing was pushed; fix the git state and re-run \`gbrain bootstrap repo\``,
    );
  }
  return res.stdout.split('\0').filter((s) => s.length > 0);
}

/** Secret scan the given workspace-relative files; throw on any finding. This
 * is the SAME scanner bootstrap verify uses (src/core/secret-scan.ts) — the
 * first push is NEVER made without it. */
function secretScanOrThrow(workspaceDir: string, relFiles: string[]): void {
  const allowlist = loadWorkspaceAllowlist(workspaceDir);
  const findings = scanFiles(relFiles.map((f) => join(workspaceDir, f)), {
    allowlist,
    workspaceRoot: workspaceDir,
  });
  if (findings.length > 0) {
    const sample = findings.slice(0, 5).map((f) => `${f.file}:${f.line} [${f.pattern}]`).join('; ');
    throw new BootstrapError(
      'SECRET_SCAN_BLOCKED',
      `secret scan found ${findings.length} finding(s) before the first push: ${sample}` +
        `${findings.length > 5 ? '; …' : ''} — nothing was committed or pushed. ` +
        `Remove the secret(s), or allowlist a false positive in ${SCAN_ALLOW_FILENAME}, then re-run \`gbrain bootstrap repo\`.`,
      { details: { findings: findings.length } },
    );
  }
}

/**
 * Guarantee at least one commit exists so the first push has content — the
 * freshly-rendered workspace is uncommitted, so a bare `git push` would fail
 * ("src refspec ... does not match") and (on retry) the adoption path would
 * false-succeed against an empty remote. Stages everything, runs the secret
 * scan (NEVER bypassed), commits. No-op when a commit already exists and the
 * tree is clean.
 */
async function ensureWorkspaceCommit(runner: ExecRunner, workspaceDir: string): Promise<void> {
  const head = await runner(['git', '-C', workspaceDir, 'rev-parse', '--verify', 'HEAD']);
  const hasCommit = head.code === 0;
  const statusRes = await runner(['git', '-C', workspaceDir, 'status', '--porcelain']);
  const dirty = statusRes.code === 0 && statusRes.stdout.trim().length > 0;
  if (hasCommit && !dirty) {
    // A clean commit already exists (e.g. a re-run, or an adopted repo whose
    // tree was committed earlier). Do NOT return before scanning: the committed
    // tree is exactly what a `git push` will publish, so secret-scan it too —
    // the early return used to skip the scan entirely (a pre-existing commit
    // could push secrets unscanned).
    const tracked = await trackedFiles(runner, workspaceDir);
    secretScanOrThrow(workspaceDir, tracked);
    return; // there is already something to push
  }

  const add = await runner(['git', '-C', workspaceDir, 'add', '-A']);
  if (add.code !== 0) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `git add failed before the first commit: ${add.stderr.trim() || `exit ${add.code}`}`,
    );
  }

  // Secret scan the staged+untracked set — do NOT bypass it [G8/D6].
  const files = await stagedAndUntrackedFiles(runner, workspaceDir);
  secretScanOrThrow(workspaceDir, files);

  const staged = await runner(['git', '-C', workspaceDir, 'diff', '--cached', '--name-only']);
  const nothingStaged = staged.code === 0 && staged.stdout.trim().length === 0;
  if (nothingStaged) {
    if (hasCommit) return; // clean commit already exists; nothing new to add
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      'the workspace has no files to commit — render identity files first (`gbrain bootstrap render`), then re-run `gbrain bootstrap repo`',
    );
  }

  const commit = await runner(['git', '-C', workspaceDir, 'commit', '-m', 'gbrain: bootstrap workspace']);
  if (commit.code !== 0 && !hasCommit) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `git commit failed before the first push: ${commit.stderr.trim() || `exit ${commit.code}`}`,
    );
  }
}

/** The current branch, defaulting to 'main' (a pre-first-commit HEAD reports
 * 'HEAD' / errors). */
async function currentBranch(runner: ExecRunner, workspaceDir: string): Promise<string> {
  const res = await runner(['git', '-C', workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const b = res.code === 0 ? res.stdout.trim() : '';
  return b && b !== 'HEAD' ? b : 'main';
}

/**
 * [FIX4/G8] Bind the just-verified privacy result to the ACTUAL push target.
 * A concurrent `git remote set-url origin …` between verify and push could
 * redirect content elsewhere; re-read origin and refuse unless it still parses
 * to the owner/name we verified private. Checks BOTH the fetch URL and the push
 * URL (`remote.origin.pushurl`) — `git push` uses the push URL when set, so a
 * verified-private fetch URL paired with a foreign/public push URL would
 * otherwise leak the workspace.
 */
async function assertOriginMatches(
  runner: ExecRunner,
  workspaceDir: string,
  owner: string,
  name: string,
): Promise<void> {
  // Fetch URL: must resolve to the verified-private owner/name (the primary bind).
  const fetchRes = await runner(['git', '-C', workspaceDir, 'remote', 'get-url', 'origin']);
  const fetchUrl = fetchRes.code === 0 ? fetchRes.stdout.trim() : '';
  const fetchParsed = fetchUrl ? parseGithubRemote(fetchUrl) : null;
  if (!fetchParsed || fetchParsed.owner !== owner || fetchParsed.name !== name) {
    throw new BootstrapError(
      'ORIGIN_EXISTS',
      `origin now resolves to ${fetchUrl || '(unset)'}, not the verified-private ${owner}/${name} — refusing to push. ` +
        'The remote changed after the privacy verification; restore it (git remote set-url origin <the created repo>) ' +
        'and re-run `gbrain bootstrap repo`.',
      { details: { which: 'fetch', expected: `${owner}/${name}`, actual: fetchUrl } },
    );
  }
  // Push URL: `git push` uses `remote.origin.pushurl` when set, so a verified
  // fetch URL + a foreign push URL would leak. Read the config key directly (no
  // dash-flag): unset → exit != 0 → `git push` falls back to the fetch URL
  // (already validated). Only a DISTINCT, configured push URL is a refusal.
  const pushRes = await runner(['git', '-C', workspaceDir, 'config', 'remote.origin.pushurl']);
  const pushUrl = pushRes.code === 0 ? pushRes.stdout.trim() : '';
  if (pushUrl) {
    const pushParsed = parseGithubRemote(pushUrl);
    if (!pushParsed || pushParsed.owner !== owner || pushParsed.name !== name) {
      throw new BootstrapError(
        'ORIGIN_EXISTS',
        `origin push URL resolves to ${pushUrl}, not the verified-private ${owner}/${name} — refusing to push. ` +
          'A separate push URL (remote.origin.pushurl) points elsewhere; clear that config key ' +
          'and re-run `gbrain bootstrap repo`.',
        { details: { which: 'push', expected: `${owner}/${name}`, actual: pushUrl } },
      );
    }
  }
}

/**
 * [FIX3] The adoption/idempotent path must not report reused-success against an
 * empty remote (a prior run that created the repo + set origin but whose push
 * failed). Lightweight `ls-remote` check: if the branch is already on the
 * remote, the workspace is genuinely pushed; otherwise complete the push
 * (scan-gated, bound to the verified origin [FIX4]).
 */
async function ensureRemoteHasWorkspace(
  runner: ExecRunner,
  workspaceDir: string,
  owner: string,
  name: string,
): Promise<void> {
  const branch = await currentBranch(runner, workspaceDir);
  const ls = await runner(['git', '-C', workspaceDir, 'ls-remote', '--heads', 'origin', branch]);
  const remoteHasBranch = ls.code === 0 && ls.stdout.trim().length > 0;
  if (remoteHasBranch) return; // genuinely pushed — reused success is honest

  await ensureWorkspaceCommit(runner, workspaceDir);
  const pushBranch = await currentBranch(runner, workspaceDir);
  await assertOriginMatches(runner, workspaceDir, owner, name);
  const push = await runner(['git', '-C', workspaceDir, 'push', '-u', 'origin', pushBranch]);
  if (push.code !== 0) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `completing the deferred first push to ${owner}/${name} failed: ${push.stderr.trim() || `exit ${push.code}`} — ` +
        'the repo exists and is private; commit your work and re-run `gbrain bootstrap repo`',
      { details: { branch: pushBranch, stderr: push.stderr } },
    );
  }
}

// ---------------------------------------------------------------------------
// createPrivateRepo
// ---------------------------------------------------------------------------

export interface CreatePrivateRepoOptions {
  runner?: ExecRunner;
  /** The gbrain home holding the install receipt (default: configDir()). */
  gbrainHomeDir?: string;
}

export interface CreatePrivateRepoResult {
  url: string;
  name: string;
  /**
   * How the repo came to be:
   *  - `created`  — bootstrap ran `gh repo create` this run (brand-new repo).
   *  - `adopted`  — a pre-existing origin the human created (create-repo-first),
   *    or one bootstrap created but crashed before recording, was verified and
   *    pushed to for the first time this run.
   *  - `reused`   — a repo a prior run already recorded (`repo_url` match); this
   *    run only re-verified privacy and completed any deferred push.
   * A single enum instead of overlapping booleans so invalid combinations
   * ('created'+'adopted') are unrepresentable.
   */
  disposition: 'created' | 'adopted' | 'reused';
  /** Back-compat: true whenever an existing origin was used (adopted OR reused)
   * rather than freshly created. Derived from `disposition`. */
  reused: boolean;
}

/**
 * Create (or idempotently re-verify) the dedicated private GitHub repo for an
 * initialized agent workspace. See module header for the G8 invariants.
 */
export async function createPrivateRepo(
  workspaceDir: string,
  opts: CreatePrivateRepoOptions = {},
): Promise<CreatePrivateRepoResult> {
  const runner = opts.runner ?? defaultRunner;
  const gbrainHomeDir = opts.gbrainHomeDir ?? configDir();

  // Gate 1: gh on PATH. Exit-code-2 semantics — the human installs gh.
  const ghVersion = await runner(['gh', '--version']);
  if (ghVersion.code !== 0) {
    throw new BootstrapError(
      'GH_MISSING',
      '`gh` (GitHub CLI) is not available on PATH — install it (https://cli.github.com), then re-run `gbrain bootstrap repo`',
      { exitCode: 2 },
    );
  }

  // Gate 2: authenticated. Exit-code-2 — the human runs `gh auth login`.
  // `--hostname github.com` scopes the check to the host this flow actually
  // targets (every downstream call — parseGithubOwnerRepo, the repo-create
  // URL fallback, etc. — is github.com-only), so an unrelated broken account
  // on some other configured host (e.g. a GitHub Enterprise instance) can't
  // false-block it either. `--active` (only when the installed `gh` supports
  // it) further restricts that host's check to the active account. Bare
  // `gh auth status` aggregates EVERY registered account on EVERY host and
  // exits 1 if any one of them is invalid — even an unused, long-expired
  // account — which false-blocks this gate while the active account (what
  // `gh`/`git` actually use) is perfectly healthy.
  const ghVersionTuple = parseGhVersion(ghVersion.stdout);
  const ghSupportsActiveFlag = ghVersionTuple !== null && ghVersionAtLeast(ghVersionTuple, GH_ACTIVE_FLAG_MIN_VERSION);
  const ghAuthArgv = ghSupportsActiveFlag
    ? ['gh', 'auth', 'status', '--active', '--hostname', 'github.com']
    : ['gh', 'auth', 'status', '--hostname', 'github.com'];
  const ghAuth = await runner(ghAuthArgv);
  if (ghAuth.code !== 0) {
    throw new BootstrapError(
      'GH_AUTH',
      'GitHub CLI is not authenticated — run `gh auth login`, then re-run `gbrain bootstrap repo`',
      { exitCode: 2, details: { stderr: ghAuth.stderr } },
    );
  }

  // Gate 3: manifest must say initialized (render ran) [CX2-1].
  const { manifest } = requireInitializedManifest(workspaceDir);

  // Gate 4: pre-existing origin [G8]. Two origins are acceptable:
  //  (a) one a prior run recorded (receipt `repo_url` matches) — idempotent
  //      re-run, disposition 'reused';
  //  (b) an origin owned by the authed gh user with NO recorded `repo_url` —
  //      either the human created it (create-repo-first) or we created it but
  //      crashed before recording. Adopting it requires it be SAFE (empty, or
  //      already carrying our history — see assertAdoptableOrigin), disposition
  //      'adopted'. Anything else is refused and pointed at attach.
  const originRes = await runner(['git', '-C', workspaceDir, 'remote', 'get-url', 'origin']);
  if (originRes.code === 0 && originRes.stdout.trim()) {
    const originUrl = originRes.stdout.trim();
    const receipt = readReceipt(gbrainHomeDir) as RepoReceipt | null;
    const sameWorkspace =
      receipt !== null && realpathOrResolve(receipt.workspace_dir) === realpathOrResolve(workspaceDir);
    const viaUrlMatch = sameWorkspace && receipt.repo_url === originUrl;
    // A receipt without a recorded repo_url (crash between create and record, OR
    // a create-repo-first clone rendered in place) may adopt ONLY when the
    // authenticated gh user owns the origin — undefined is never a wildcard,
    // and org-owned repos (owner != login) are out of scope by design.
    let viaOwnedUndefined = false;
    if (!viaUrlMatch && sameWorkspace && receipt.repo_url === undefined) {
      const parsedOrigin = parseGithubRemote(originUrl);
      if (parsedOrigin) {
        const login = await fetchAuthedLogin(runner);
        viaOwnedUndefined = login !== null && login === parsedOrigin.owner;
      }
    }
    if (!viaUrlMatch && !viaOwnedUndefined) {
      throw new BootstrapError(
        'ORIGIN_EXISTS',
        `this workspace already has an \`origin\` remote (${originUrl}) that bootstrap can neither adopt nor claim. ` +
          '`gbrain bootstrap repo` creates a dedicated private repo, OR adopts an EMPTY private repo you created under your own account. ' +
          'If this is a clone of an existing agent workspace, run `gbrain bootstrap attach` instead.',
        { details: { origin: originUrl } },
      );
    }
    const parsed = parseGithubRemote(originUrl);
    if (!parsed) {
      throw new BootstrapError(
        'ORIGIN_EXISTS',
        `the recorded bootstrap origin (${originUrl}) is not a GitHub remote — cannot verify privacy; fix the remote or remove it and re-run`,
        { details: { origin: originUrl } },
      );
    }
    // Adopting a not-yet-recorded origin: it must be safe. Empty is always safe.
    // A NON-empty origin is safe only when it carries OUR interrupted push —
    // proven by `pending_repo_url` matching (a user's existing project has no
    // such marker). Everything else is refused (turns the old silent no-op into
    // a clear ORIGIN_NOT_EMPTY).
    if (viaOwnedUndefined) {
      const ours = sameWorkspace && receipt.pending_repo_url === originUrl;
      if (!ours) await assertAdoptableOrigin(runner, workspaceDir, parsed.owner, parsed.name);
    }
    // PRIVACY VERIFY [G8] — hard gate before any push.
    await verifyRepoPrivate(runner, parsed.owner, parsed.name);
    // Repo-local git identity so the (possibly first-ever) commit on a fresh
    // machine succeeds — this path used to skip it, breaking clone-then-adopt.
    await setRepoLocalIdentity(runner, workspaceDir, await resolveGhIdentity(runner));
    updateGithubMd(workspaceDir, originUrl);
    // Proof-of-intent BEFORE the push so a post-push/pre-record crash is
    // recognized as ours on re-run (see the `pending_repo_url` bypass above).
    recordPendingRepo(gbrainHomeDir, workspaceDir, manifest, originUrl);
    // [FIX3] Don't report success on an empty remote — a prior run may have set
    // origin but failed to push. Verify the remote has our branch; complete the
    // (scan-gated) push if it doesn't.
    await ensureRemoteHasWorkspace(runner, workspaceDir, parsed.owner, parsed.name);
    // Record repo_url AFTER a successful push (clears pending): recording before
    // push let a push failure look "done" to `bootstrap status` (repo_url
    // present), so a re-run skipped the repo phase and never pushed the workspace.
    recordRepoInReceipt(gbrainHomeDir, workspaceDir, manifest, originUrl);
    return { url: originUrl, name: parsed.name, disposition: viaUrlMatch ? 'reused' : 'adopted', reused: true };
  }

  // Cloud-sandbox guard: `gh repo create` inside a proxied cloud session
  // makes a repo the session is NOT attached to — REST verification 403s and
  // the proxy denies every push to it, so creation there is a dead end by
  // construction. Fail fast with the flow that works instead. (Adoption of an
  // EXISTING attached origin above is untouched — that is the sanctioned path.)
  if (detectExecutionEnvironment() === 'cloud-sandbox') {
    throw new BootstrapError(
      'CLOUD_SANDBOX_REPO',
      'this is a cloud sandbox session — a repo created from inside it would not be attached to the ' +
        "session's GitHub scope (verification and pushes are blocked by the proxy). " +
        CLOUD_ATTACH_FLOW_HINT,
      { exitCode: 2 },
    );
  }

  // Ensure a git repo exists (main branch on fresh init).
  const gitDir = await runner(['git', '-C', workspaceDir, 'rev-parse', '--git-dir']);
  if (gitDir.code !== 0) {
    const init = await runner(['git', '-C', workspaceDir, 'init', '-b', 'main']);
    if (init.code !== 0) {
      throw new BootstrapError('REPO_CREATE_FAILED', `git init failed: ${init.stderr.trim() || `exit ${init.code}`}`);
    }
  }

  // Repo-local identity from the authed gh user (never global git config).
  const ident = await resolveGhIdentity(runner);
  const login = ident.login;
  await setRepoLocalIdentity(runner, workspaceDir, ident);

  // Name: slug(agent_name)-workspace, probed for availability, suffix -2..-100.
  // The probe is best-effort convenience; `gh repo create` remains the
  // authority (a probe fooled by rate limiting surfaces as a loud create
  // failure, never a silent wrong-repo adoption — idempotency keys off the
  // remote URL, not this probe) [G8].
  const base = `${slugifyRepoName(manifest.agent_name)}-workspace`;
  let name: string | null = null;
  for (let i = 1; i <= 100; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const probe = await runner(['gh', 'repo', 'view', `${login}/${candidate}`]);
    if (probe.code !== 0) {
      name = candidate;
      break;
    }
  }
  if (name === null) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `could not find a free repo name after 100 candidates (base: ${base}) — delete stale ${base}-* repos or rename the agent`,
    );
  }

  // Create: private, sourced from the workspace. Deliberately WITHOUT --push:
  // nothing leaves this machine until the privacy bit is verified [G8].
  const create = await runner(['gh', 'repo', 'create', name, '--private', '--source', workspaceDir]);
  if (create.code !== 0) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `gh repo create failed: ${create.stderr.trim() || `exit ${create.code}`}`,
      { details: { name, stderr: create.stderr } },
    );
  }

  // The remote URL is the durable identity (idempotency key). Prefer what git
  // actually recorded; fall back to the constructed URL.
  const postOrigin = await runner(['git', '-C', workspaceDir, 'remote', 'get-url', 'origin']);
  const url = postOrigin.code === 0 && postOrigin.stdout.trim() ? postOrigin.stdout.trim() : `https://github.com/${login}/${name}`;

  // PRIVACY VERIFY [G8] — the hard gate, BEFORE the first push. Must be the
  // literal `true`; only then does any workspace content leave this machine.
  await verifyRepoPrivate(runner, login, name);

  // [FIX3] Ensure the first push has content: a freshly-rendered workspace is
  // uncommitted, so stage + secret-scan + commit before pushing (create →
  // verify → commit → push; the scan is never bypassed).
  await ensureWorkspaceCommit(runner, workspaceDir);

  // Proof-of-intent before the push: if we crash after pushing but before
  // recording repo_url, a re-run recognizes the (now non-empty) repo as ours.
  recordPendingRepo(gbrainHomeDir, workspaceDir, manifest, url);

  const branch = await currentBranch(runner, workspaceDir);
  // [FIX4] Bind the verified privacy result to the actual push target.
  await assertOriginMatches(runner, workspaceDir, login, name);
  const push = await runner(['git', '-C', workspaceDir, 'push', '-u', 'origin', branch]);
  if (push.code !== 0) {
    throw new BootstrapError(
      'REPO_CREATE_FAILED',
      `git push to the verified-private repo failed: ${push.stderr.trim() || `exit ${push.code}`} — the repo exists and is private; commit your work and re-run \`gbrain bootstrap repo\``,
      { details: { name, branch, stderr: push.stderr } },
    );
  }

  updateGithubMd(workspaceDir, url);
  recordRepoInReceipt(gbrainHomeDir, workspaceDir, manifest, url);
  return { url, name, disposition: 'created', reused: false };
}
