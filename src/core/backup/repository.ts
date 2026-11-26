import { execFile, execFileSync, spawn } from '../spawn.ts';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { buildGitEnv } from '../git-remote.ts';
import { pushStatusPathForRoot, readPushStatusForRoot } from '../workspace-push.ts';
import { readManifest } from '../bootstrap/format.ts';
import { managedFilesystemRootFor } from '../persistence/filesystem-guard.ts';
import { withoutPhysicalRootMetadata } from '../persistence/root-metadata.ts';
import { BACKUP_VERIFICATION_MAX_AGE_MS, type BackupAssetVerdict } from './status-file.ts';

export const BACKUP_REMOTE_PROBE_CAP = 8;
export const BACKUP_REMOTE_BUDGET_MS = 8_000;
export const BACKUP_REMOTE_TIMEOUT_MS = 2_000;
export const BACKUP_REMOTE_TIMEOUT_KEY = 'backup.remote_timeout_ms';
export const BACKUP_REMOTE_TIMEOUT_MIN_MS = 500;
export const BACKUP_REMOTE_TIMEOUT_MAX_MS = 30_000;

/** `timeoutMs`: each remote probe's slot (resolveBackupRemoteTimeoutMs); default BACKUP_REMOTE_TIMEOUT_MS. */
export interface RemoteProbeBudget { remaining: number; deadline?: number; timeoutMs?: number }

/**
 * #6907: the remote probe slot. GBRAIN_BACKUP_REMOTE_TIMEOUT_MS wins over the
 * brain's `backup.remote_timeout_ms`; a non-number is ignored, and a number is
 * clamped to 0.5-30 s. Default 2 s.
 */
export function resolveBackupRemoteTimeoutMs(configured: string | null | undefined, env: string | undefined = process.env.GBRAIN_BACKUP_REMOTE_TIMEOUT_MS): number {
  for (const raw of [env, configured]) {
    if (raw == null || raw.trim() === '') continue;
    const ms = Number(raw);
    if (Number.isFinite(ms)) return Math.min(BACKUP_REMOTE_TIMEOUT_MAX_MS, Math.max(BACKUP_REMOTE_TIMEOUT_MIN_MS, Math.round(ms)));
  }
  return BACKUP_REMOTE_TIMEOUT_MS;
}

/** The sweep's remote budget: eight seconds, or four slots when the slot is longer. */
export function backupRemoteBudgetMs(timeoutMs: number): number {
  return Math.max(BACKUP_REMOTE_BUDGET_MS, 4 * timeoutMs);
}

/**
 * A remote probe starts only when its full slot is still inside the sweep
 * deadline. A probe started on the leftover sub-slot would be killed
 * mid-handshake and record a healthy slow remote as `unavailable` (#6499);
 * deferring it reports `budget_exhausted` instead.
 */
export function budgetAllowsProbe(budget: RemoteProbeBudget, nowMs: number = Date.now()): boolean {
  if (budget.remaining <= 0) return false;
  return budget.deadline === undefined || budget.deadline - nowMs >= (budget.timeoutMs ?? BACKUP_REMOTE_TIMEOUT_MS);
}

/** Variables that locate the user's own git config, credentials and network path. */
export const BACKUP_GIT_ENV_ALLOWLIST = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'SSH_AUTH_SOCK', 'GIT_CONFIG_GLOBAL',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const;
export const BACKUP_GIT_ENV_WINDOWS_ALLOWLIST = ['USERPROFILE', 'APPDATA', 'SystemRoot'] as const;

/**
 * The probe env passes only the allowlist, so git reads the user's config and
 * credential helpers (#5794) but never a repository-redirecting variable such
 * as GIT_DIR or GIT_WORK_TREE; the no-prompt overrides always win.
 */
export function backupGitEnv(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BACKUP_GIT_ENV_ALLOWLIST, ...(platform === 'win32' ? BACKUP_GIT_ENV_WINDOWS_ALLOWLIST : [])]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...buildGitEnv(platform) };
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: backupGitEnv(),
  }).trim();
}

/**
 * #6907: does the tree hold changes besides physical-root metadata? Reads
 * `git status --porcelain` as it streams and stops git at the first other
 * line, so a tree with a huge listing costs one line instead of overflowing a
 * buffer; a single line past the bound reads dirty (metadata names are short).
 * Fails on a timeout or a git error, like the other local probes.
 */
function worktreeDirty(root: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, 'status', '--porcelain'], { stdio: ['ignore', 'pipe', 'ignore'], env: backupGitEnv() });
    let pending = '';
    let settled = false;
    const settle = (result: boolean | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (result instanceof Error) reject(result); else resolve(result);
    };
    const timer = setTimeout(() => settle(new Error('git status timed out')), 2_000);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop()!;
      if (withoutPhysicalRootMetadata(lines.join('\n')).length > 0 || pending.length > 1024 * 1024) settle(true);
    });
    child.on('error', settle);
    child.on('close', (code: number | null) => settle(code === 0 ? withoutPhysicalRootMetadata(pending).length > 0 : new Error(`git status exited ${code}`)));
  });
}

function repositoryFingerprint(root: string, origin: string, branch: string, head: string): string {
  const directory = realpathSync(git(root, ['rev-parse', '--absolute-git-dir']));
  const stat = statSync(directory, { bigint: true });
  const push = readPushStatusForRoot(root);
  const pushFile = push?.file ?? pushStatusPathForRoot(root);
  const pushStat = existsSync(pushFile) ? statSync(pushFile, { bigint: true }) : null;
  return createHash('sha256').update(JSON.stringify([
    realpathSync(root), directory, String(stat.dev), String(stat.ino), String(stat.birthtimeNs), origin, branch, head,
    push?.ok, push?.ts, pushStat ? [String(pushStat.dev), String(pushStat.ino), String(pushStat.mtimeNs)] : null,
  ])).digest('hex');
}

export async function assessBackupRepository(
  root: string,
  kind: 'source_repo' | 'bootstrap_workspace',
  id: string,
  now: Date,
  budget?: RemoteProbeBudget,
  previous?: BackupAssetVerdict,
): Promise<BackupAssetVerdict> {
  const asset: BackupAssetVerdict = { kind, id, state: 'unknown', fix_argv: null, verification: { state: 'not_checked' } };
  let failedPush = false;
  try {
    failedPush = readPushStatusForRoot(root)?.ok === false;
    // #6083: a managed canonical worktree is committed and pushed by its persistence owner; `sources push` refuses there.
    const managed = managedFilesystemRootFor(root);
    const managedFix = managed ? ['gbrain', 'sources', 'writer', 'status', ...(managed.sourceId ? [managed.sourceId] : []), '--probe', '--json'] : null;
    if (failedPush && kind === 'bootstrap_workspace') asset.fix_argv = managedFix ?? ['gbrain', 'sources', 'push', '--path', root];
    let origin: string;
    try {
      origin = git(root, ['remote', 'get-url', 'origin']);
      asset.configured_remote = true;
    } catch (error) {
      if ((error as { status?: number }).status !== 2) {
        if (failedPush) return { ...asset, state: 'failing', detail: 'last_push_failed' };
        throw error;
      }
      asset.configured_remote = false;
      asset.state = 'no_remote';
      asset.fix_argv = null;
      asset.detail = `${failedPush ? 'the last recorded push failed because there is no origin remote; ' : ''}fix: git remote add origin <url> && git push -u origin <branch>, then gbrain sources harden <id>`;
      try { if (readManifest(root).state === 'initialized') asset.fix_argv = ['gbrain', 'bootstrap', 'repo']; } catch {}
      return asset;
    }
    const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const head = git(root, ['rev-parse', '--verify', 'HEAD']);
    const dirty = await worktreeDirty(root);
    let ahead: number | undefined;
    try { ahead = Number(git(root, ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`])); } catch {}
    asset.state = ahead && ahead > 0 ? 'unpushed' : dirty ? 'dirty' : 'ok';
    if (ahead && ahead > 0) { asset.ahead = ahead; asset.detail = `${ahead} commit(s) ahead of origin/${branch} (local tracking ref only)`; }
    else if (dirty) asset.detail = 'uncommitted changes';
    if (failedPush) { asset.state = 'failing'; asset.detail = 'last_push_failed'; }
    if (managedFix && (dirty || (ahead ?? 0) > 0 || failedPush)) asset.fix_argv = managedFix;
    const fingerprint = repositoryFingerprint(root, origin, branch, head);
    asset.verification = { state: 'not_checked', repository_fingerprint: fingerprint };
    if (!budget) {
      const prior = previous?.verification;
      const age = now.getTime() - Date.parse(prior?.checked_at ?? '');
      if (previous?.id === id && previous.kind === kind && prior?.repository_fingerprint === fingerprint && Number.isFinite(age) && age >= 0) {
        asset.verification = { ...prior };
        if (prior.state === 'verified') {
          if (previous.state === 'ok' && !dirty && age <= BACKUP_VERIFICATION_MAX_AGE_MS && prior.local_commit === head && prior.remote_commit === head) {
            asset.state = 'ok'; asset.fix_argv = null; delete asset.ahead; delete asset.detail;
            return asset;
          }
          asset.verification.state = 'stale';
        }
      }
      if (ahead === undefined && !dirty && !failedPush) {
        asset.state = 'no_remote';
        asset.detail = 'remote configured but nothing pushed is recorded locally — run: git push -u origin <branch>; verify with gbrain backup check';
      }
      return asset;
    }
    const timeoutMs = budget.timeoutMs ?? BACKUP_REMOTE_TIMEOUT_MS;
    budget.deadline ??= Date.now() + backupRemoteBudgetMs(timeoutMs);
    if (!budgetAllowsProbe(budget)) {
      asset.verification = { state: 'budget_exhausted', repository_fingerprint: fingerprint };
      return asset;
    }
    budget.remaining--;
    const ref = `refs/heads/${branch}`;
    const output = await new Promise<string>((resolve, reject) => {
      execFile('git', ['-C', root, '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
        '-c', 'protocol.https.allow=always', '-c', 'protocol.http.allow=always', '-c', 'protocol.ssh.allow=always',
        '-c', 'http.followRedirects=false', '-c', 'credential.interactive=false', 'ls-remote', '--exit-code', '--refs', 'origin', ref], {
        encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024,
        env: { ...backupGitEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
          GIT_SSH_COMMAND: `ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=${Math.ceil(timeoutMs / 1000)}` },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    }).catch((error: { code?: unknown; killed?: boolean }) => {
      asset.verification = error.code === 2
        ? { state: 'missing_ref', checked_at: now.toISOString(), repository_fingerprint: fingerprint }
        : { state: 'unavailable', cause: error.killed ? 'timeout' : 'exit', checked_at: now.toISOString(), repository_fingerprint: fingerprint };
      return null;
    });
    if (output === null) return asset;
    const remoteHead = output.trim().split('\n').map(line => line.split(/\s+/)).find(parts => parts[1] === ref)?.[0];
    if (!remoteHead || !/^[a-f0-9]{40,64}$/.test(remoteHead)) {
      asset.verification = { state: 'unavailable', checked_at: now.toISOString(), repository_fingerprint: fingerprint };
      return asset;
    }
    const stillClean = git(root, ['rev-parse', '--verify', 'HEAD']) === head
      && git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']) === branch
      && !await worktreeDirty(root)
      && git(root, ['remote', 'get-url', 'origin']) === origin
      && repositoryFingerprint(root, origin, branch, head) === fingerprint;
    asset.verification = { state: remoteHead === head && stillClean && !dirty ? 'verified' : 'mismatch', checked_at: now.toISOString(), local_commit: head, remote_commit: remoteHead, repository_fingerprint: fingerprint };
    if (asset.verification.state === 'verified') {
      asset.state = 'ok';
      asset.fix_argv = null;
      delete asset.ahead;
      delete asset.detail;
    }
    return asset;
  } catch {
    // A later local probe that failed (a 2 s git timeout on a loaded host) cannot undo a finding already
    // established: a recorded failed push, or commits/edits a completed probe saw. It never certifies `ok`.
    if (failedPush) return { ...asset, state: 'failing', detail: 'last_push_failed', verification: { state: 'unavailable' } };
    if (asset.state === 'unpushed' || asset.state === 'dirty') return { ...asset, verification: { state: 'unavailable' } };
    return { ...asset, state: 'unknown', detail: 'probe_failed', verification: { state: 'unavailable' } };
  }
}
