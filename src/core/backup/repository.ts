import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { GIT_ENV } from '../git-remote.ts';
import { pushStatusPathForRoot, readPushStatusForRoot } from '../workspace-push.ts';
import { readManifest } from '../bootstrap/format.ts';
import { BACKUP_VERIFICATION_MAX_AGE_MS, type BackupAssetVerdict } from './status-file.ts';

export const BACKUP_REMOTE_PROBE_CAP = 8;
export const BACKUP_REMOTE_BUDGET_MS = 8_000;
export const BACKUP_REMOTE_TIMEOUT_MS = 2_000;

export interface RemoteProbeBudget { remaining: number; deadline?: number }

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV,
  }).trim();
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
  try {
    const failedPush = readPushStatusForRoot(root)?.ok === false;
    if (failedPush && kind === 'bootstrap_workspace') asset.fix_argv = ['gbrain', 'sources', 'push', '--path', root];
    let origin: string;
    try {
      origin = git(root, ['remote', 'get-url', 'origin']);
      asset.configured_remote = true;
    } catch (error) {
      if (failedPush) return { ...asset, state: 'failing', detail: 'last_push_failed' };
      if ((error as { status?: number }).status !== 2) throw error;
      asset.configured_remote = false;
      asset.state = 'no_remote';
      asset.detail = 'fix: git remote add origin <url> && git push -u origin <branch>, then gbrain sources harden <id>';
      try { if (readManifest(root).state === 'initialized') asset.fix_argv = ['gbrain', 'bootstrap', 'repo']; } catch {}
      return asset;
    }
    const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const head = git(root, ['rev-parse', '--verify', 'HEAD']);
    const dirty = git(root, ['status', '--porcelain']).length > 0;
    let ahead: number | undefined;
    try { ahead = Number(git(root, ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`])); } catch {}
    asset.state = ahead && ahead > 0 ? 'unpushed' : dirty ? 'dirty' : 'ok';
    if (ahead && ahead > 0) { asset.ahead = ahead; asset.detail = `${ahead} commit(s) ahead of origin/${branch} (local tracking ref only)`; }
    else if (dirty) asset.detail = 'uncommitted changes';
    if (failedPush) { asset.state = 'failing'; asset.detail = 'last_push_failed'; }
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
    budget.deadline ??= Date.now() + BACKUP_REMOTE_BUDGET_MS;
    const remainingMs = budget.deadline - Date.now();
    if (budget.remaining <= 0 || remainingMs <= 0) {
      asset.verification = { state: 'budget_exhausted', repository_fingerprint: fingerprint };
      return asset;
    }
    budget.remaining--;
    const ref = `refs/heads/${branch}`;
    const output = await new Promise<string>((resolve, reject) => {
      execFile('git', ['-C', root, '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
        '-c', 'protocol.https.allow=always', '-c', 'protocol.http.allow=always', '-c', 'protocol.ssh.allow=always',
        '-c', 'http.followRedirects=false', '-c', 'credential.interactive=false', 'ls-remote', '--exit-code', '--refs', 'origin', ref], {
        encoding: 'utf8', timeout: Math.min(BACKUP_REMOTE_TIMEOUT_MS, remainingMs), maxBuffer: 64 * 1024,
        env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=2' },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    }).catch(error => {
      asset.verification = { state: error.code === 2 ? 'missing_ref' : 'unavailable', checked_at: now.toISOString(), repository_fingerprint: fingerprint };
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
      && git(root, ['status', '--porcelain']).length === 0
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
    return { ...asset, state: 'unknown', detail: 'probe_failed', verification: { state: 'unavailable' } };
  }
}
