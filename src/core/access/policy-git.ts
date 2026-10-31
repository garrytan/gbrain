/**
 * GBRA-218 (PR A2): the git store of folder rules. On a git-backed source the
 * desired rules are `<source root>/.gbrain/access.yml` and the approved baseline is
 * `<source root>/.gbrain/access.approved` (the approved rulebook in the same grammar),
 * both committed through the one door (`gbrain git commit-push`, the checkout's
 * commit lock). Sync reads both explicitly from the synced commit (it skips dot
 * paths otherwise) and hands the desired rulebook to the shared lifecycle in
 * policy.ts, which applies narrowing at once and holds widening. The serve
 * path never calls git: page writes stamp from the applied rulebook in the
 * database.
 *
 * An approved file is trusted as the baseline only when the database has no
 * revision for the source yet (a rebuild or a second database, which then
 * reaches the same applied rules from git alone) or when it matches the
 * database's approved revision. An access.approved changed by a plain commit
 * is reported and ignored, so git write access alone never widens.
 */
import { spawnSync } from '../spawn.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readSyncAnchor } from '../sync-anchor.ts';
import { gitChildEnv } from '../git-env.ts';
import { gitAsync } from '../sync-git.ts';
import { acquireCommitLock, checkoutRoot, commitAndPush, COMMIT_LOCK_ENV, type CommitPushResult } from '../git/commit-push.ts';
import { parsePolicyYaml, rulebookDigest, serializePolicyYaml, type FolderRule, type PolicyProblem } from './folder-rules.ts';
import { clearPolicyInvalid, getRevision, listRevisions, markPolicyInvalid, proposeRevision, readAccessStore, writeAccessStore, type ProposalResult, type RestampProgress } from './policy.ts';

export const POLICY_DIR = '.gbrain';
export const POLICY_FILE = '.gbrain/access.yml';
export const APPROVED_FILE = '.gbrain/access.approved';
const POLICY_HEADER = 'Folder read rules for this source (gbrain access rule add|rm). Narrowing changes apply at the next sync;\nwidening changes wait for gbrain access apply --source <id> on the brain host.';
const APPROVED_HEADER = 'The folder rules an operator approved with gbrain access apply. Written by gbrain; do not edit.';

/** The filesystem root of a source (its local path, or sync.repo_path for the default source), or null. */
export async function sourcePolicyRoot(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const root = await readSyncAnchor(engine, sourceId, 'repo_path');
  return root && existsSync(root) ? root : null;
}

/** Whether `root` is inside a git work tree. */
export function isGitWorkTree(root: string): boolean {
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', env: gitChildEnv() });
  return r.status === 0 && r.stdout.trim() === 'true';
}

function gitShow(root: string, rev: string, path: string): string | null {
  const r = spawnSync('git', ['show', `${rev}:./${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: gitChildEnv() });
  return r.status === 0 ? r.stdout : null;
}

/** isGitWorkTree without blocking the event loop, for sync (a resident runs it in-process on a commit). */
async function isGitWorkTreeAsync(root: string): Promise<boolean> {
  return gitAsync(root, ['rev-parse', '--is-inside-work-tree'], { silenceStderr: true }).then(out => out === 'true', () => false);
}

export interface CommittedPolicy { yml: string | null; approved: string | null; commit: string | null }

/** The policy files as committed at `rev` (never the working tree), and the last commit that touched access.yml. */
export async function readCommittedPolicy(root: string, rev = 'HEAD'): Promise<CommittedPolicy> {
  const show = (path: string) => gitAsync(root, ['show', `${rev}:./${path}`], { silenceStderr: true, raw: true }).catch(() => null);
  const [yml, approved, log] = await Promise.all([show(POLICY_FILE), show(APPROVED_FILE),
    gitAsync(root, ['log', '-1', '--format=%h %an', rev, '--', POLICY_FILE], { silenceStderr: true }).catch(() => '')]);
  return { yml, approved, commit: log || null };
}

export interface GitPolicySyncResult {
  source_id: string;
  state: 'skipped' | 'invalid' | ProposalResult['state'];
  reason?: 'database_store' | 'no_policy';
  proposal?: ProposalResult;
  problems?: PolicyProblem[];
  commit?: string | null;
  /** access.approved differs from the database's approved revision and was ignored (approve with gbrain access apply). */
  approved_file?: 'matches' | 'absent' | 'untrusted' | 'invalid' | 'loaded';
}

/** Reads the committed policy of a git-store source at `rev` and applies it through the shared lifecycle. */
export async function syncGitPolicy(engine: BrainEngine, sourceId: string, root: string, opts: { rev?: string; onProgress?: (p: RestampProgress) => void } = {}): Promise<GitPolicySyncResult> {
  const store = await readAccessStore(engine, sourceId);
  if (store === 'database') return { source_id: sourceId, state: 'skipped', reason: 'database_store' };
  const files = await readCommittedPolicy(root, opts.rev ?? 'HEAD');
  if (files.yml === null && files.approved === null && store !== 'git') return { source_id: sourceId, state: 'skipped', reason: 'no_policy' };
  let approvedFile: GitPolicySyncResult['approved_file'] = 'absent';
  if (files.approved !== null) {
    const approved = parsePolicyYaml(files.approved);
    if (!approved.ok) approvedFile = 'invalid';
    else if (!(await getRevision(engine, sourceId))) {
      await proposeRevision(engine, sourceId, approved.rules, { origin: 'git-approved', approved: true, store: 'git', proposedBy: 'git:access.approved', onProgress: opts.onProgress });
      approvedFile = 'loaded';
    } else {
      const lastApproved = (await listRevisions(engine, sourceId, 500)).find(r => r.approved_at);
      approvedFile = lastApproved?.digest === rulebookDigest(approved.rules) ? 'matches' : 'untrusted';
    }
  }
  const desired = files.yml === null ? { ok: true as const, rules: [] as FolderRule[] } : parsePolicyYaml(files.yml);
  if (!desired.ok) {
    await markPolicyInvalid(engine, sourceId, desired.prefixes, { problems: desired.problems, commit: files.commit, file: POLICY_FILE });
    if (store !== 'git') await writeAccessStore(engine, sourceId, 'git');
    return { source_id: sourceId, state: 'invalid', problems: desired.problems, commit: files.commit, approved_file: approvedFile };
  }
  await clearPolicyInvalid(engine, sourceId);
  const proposal = await proposeRevision(engine, sourceId, desired.rules, { origin: 'git', store: 'git', proposedBy: files.commit ? `git:${files.commit}` : 'git', onProgress: opts.onProgress });
  return { source_id: sourceId, state: proposal.state, proposal, commit: files.commit, approved_file: approvedFile };
}

export interface GitPolicyReceipt {
  outcome: CommitPushResult['outcome'] | 'committed_not_pushed';
  commit: string | null;
  path: string;
  note?: string;
}

/**
 * Writes one policy file under the checkout's commit lock (held across the read, the edit and the commit) and commits it
 * through the door. commit_lock_busy is retried once; integrate_conflict and writer_coordinator_required propagate (the
 * first needs the user's choice, the second a managed write on the brain host); a commit whose push is unconfirmed is a
 * success with a note.
 */
export async function commitPolicyFile(root: string, relPath: string, edit: (current: string | null) => string, message: string): Promise<GitPolicyReceipt> {
  const file = join(root, relPath);
  const attempt = (): GitPolicyReceipt => {
    const lock = acquireCommitLock(checkoutRoot(root));
    const prior = process.env[COMMIT_LOCK_ENV];
    process.env[COMMIT_LOCK_ENV] = lock.lockPath;
    try {
      const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
      mkdirSync(join(root, POLICY_DIR), { recursive: true });
      const next = edit(current);
      writeFileSync(file, next);
      try {
        const r = commitAndPush({ repo: root, cwd: root, paths: [file], message });
        return { outcome: r.outcome, commit: r.committed ?? r.sha, path: relPath,
          ...(r.outcome === 'committed_local' ? { note: 'Committed locally; this checkout has no remote or is managed, so nothing was pushed.' } : {}) };
      } catch (e) {
        if (e instanceof OperationError && (e.code === 'push_unconfirmed' || (e as { canonical?: string }).canonical === 'push_unconfirmed') && e.detail) {
          return { outcome: 'committed_not_pushed', commit: String(e.detail), path: relPath, note: 'Committed locally; the push is unconfirmed. Rerun gbrain git commit-push --push-only to publish it.' };
        }
        if (gitShow(root, 'HEAD', relPath) !== next) {
          if (current === null) rmSync(file, { force: true }); else writeFileSync(file, current);
        }
        throw e;
      }
    } finally {
      if (prior === undefined) delete process.env[COMMIT_LOCK_ENV]; else process.env[COMMIT_LOCK_ENV] = prior;
      lock.release();
    }
  };
  try {
    return attempt();
  } catch (e) {
    if ((e as { code?: string }).code === 'commit_lock_busy') return attempt();
    throw e;
  }
}

/** The desired rules in the working tree's access.yml (what a rule edit starts from); a file that does not validate refuses. */
export function workingTreeRules(root: string, sourceId: string): FolderRule[] {
  const file = join(root, POLICY_FILE);
  if (!existsSync(file)) return [];
  const parsed = parsePolicyYaml(readFileSync(file, 'utf8'));
  if (parsed.ok) return parsed.rules;
  throw opError('access_policy_invalid', `${POLICY_FILE} of source ${sourceId} does not validate: ${parsed.problems.map(p => `${p.line ? `line ${p.line}: ` : ''}${p.message}`).join('; ')}.`,
    `Fix the file (gbrain access rule list --source ${sourceId} shows each problem and line) and commit it with gbrain git commit-push, then retry.`);
}

/** Writes the desired rules to access.yml through the door and applies them at once (as sync would). */
export async function writeGitRules(engine: BrainEngine, sourceId: string, root: string, rules: FolderRule[], message: string, onProgress?: (p: RestampProgress) => void): Promise<{ receipt: GitPolicyReceipt; sync: GitPolicySyncResult }> {
  const receipt = await commitPolicyFile(root, POLICY_FILE, () => serializePolicyYaml(rules, POLICY_HEADER), message);
  const sync = await syncGitPolicy(engine, sourceId, root, { onProgress });
  return { receipt, sync };
}

/** Commits access.approved (the rulebook an operator approved) through the door. */
export async function writeApprovedFile(root: string, rules: FolderRule[], message: string): Promise<GitPolicyReceipt> {
  return commitPolicyFile(root, APPROVED_FILE, () => serializePolicyYaml(rules, APPROVED_HEADER), message);
}

/** Sync's hook: apply the committed policy of a source when its store is git (or unset and the commit holds a policy file). */
export async function syncAccessPolicyAt(engine: BrainEngine, sourceId: string, root: string | null | undefined, rev = 'HEAD', log?: (line: string) => void): Promise<GitPolicySyncResult | null> {
  if (!root || !existsSync(root) || !await isGitWorkTreeAsync(root)) return null;
  const result = await syncGitPolicy(engine, sourceId, root, { rev });
  if (result.state === 'skipped') return result;
  if (result.state === 'invalid') {
    log?.(`[access] ${POLICY_FILE} of source ${sourceId} does not validate (access_policy_invalid); the last applied rules stay and the prefixes it names read as nobody. Run gbrain access rule list --source ${sourceId}.`);
  } else if (result.proposal?.held.length) {
    log?.(`[access] ${result.proposal.held.length} widening change(s) to source ${sourceId}'s folder rules are held (access_policy_widening_held). Preview with gbrain access apply --source ${sourceId}.`);
  }
  if (result.approved_file === 'untrusted') {
    log?.(`[access] ${APPROVED_FILE} of source ${sourceId} does not match the approved revision in the database and was ignored; approve changes with gbrain access apply.`);
  }
  return result;
}
