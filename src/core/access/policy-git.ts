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
 * is reported and ignored, so git write access alone never widens. A rebuild replays each committed access.yml since that
 * baseline, so a narrowing a later plain commit removed is applied again with its removal held.
 */
import { spawnSync } from '../spawn.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { serr } from '../console-prefix.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readSyncAnchor } from '../sync-anchor.ts';
import { gitChildEnv } from '../git-env.ts';
import { execFileBounded } from '../bounded-child-exec.ts';
import { HARDENED_GIT_ARGS, NO_LAZY_FETCH_ENV } from '../hardened-git.ts';
import { acquireCommitLock, checkoutRoot, commitAndPush, COMMIT_LOCK_ENV, type CommitPushResult } from '../git/commit-push.ts';
import { parsePolicyYaml, rulebookDigest, serializePolicyYaml, type FolderRule, type PolicyProblem } from './folder-rules.ts';
import { clearPolicyInvalid, coverageRows, getRevision, listRevisions, markPolicyInvalid, proposeRevision, readAccessStore, writeAccessStore, type ProposalResult, type RestampProgress } from './policy.ts';

export const POLICY_DIR = '.gbrain';
export const POLICY_FILE = '.gbrain/access.yml';
export const APPROVED_FILE = '.gbrain/access.approved';
const REBUILD_MARK = 'rebuild';
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

/**
 * GST-2331: a Git read for sync (a resident runs it in-process on a commit) under `HARDENED_GIT_ARGS` and
 * `GIT_NO_LAZY_FETCH`, so a partial clone fetches nothing; rejects on a nonzero exit, and `raw` keeps the output untrimmed.
 */
async function policyGit(root: string, args: string[], raw = false): Promise<string> {
  const r = await execFileBounded('git', ['-c', 'core.quotepath=false', ...HARDENED_GIT_ARGS, '-C', root, ...args],
    { env: gitChildEnv(NO_LAZY_FETCH_ENV), timeout: 30_000, maxBuffer: 100 * 1024 * 1024 });
  if (r.error) throw r.error;
  return raw ? r.stdout : r.stdout.trim();
}

/** isGitWorkTree without blocking the event loop, for sync. */
async function isGitWorkTreeAsync(root: string): Promise<boolean> {
  return policyGit(root, ['rev-parse', '--is-inside-work-tree']).then(out => out === 'true', () => false);
}

/**
 * GST-2331: `path` as committed at `rev`: null when there is no such commit or the commit has no such file, undefined when
 * the commit names the file and the repository cannot read it (a partial clone never fetched its object or a tree on the
 * way, and sync fetches nothing).
 */
async function committedFile(root: string, rev: string, path: string): Promise<string | null | undefined> {
  const text = await policyGit(root, ['show', `${rev}:./${path}`], true).catch(() => null);
  if (text !== null) return text;
  if (!await policyGit(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).then(() => true, () => false)) return null;
  return await policyGit(root, ['ls-tree', '-z', rev, '--', path], true).catch(() => undefined) === '' ? null : undefined;
}

export interface CommittedPolicy { yml: string | null; approved: string | null; commit: string | null; unreadable: string[] }

/**
 * The policy files as committed at `rev` (never the working tree), the last commit that touched access.yml, and the policy
 * files the commit names that the repository cannot read (GST-2331: a partial clone that never fetched them).
 */
export async function readCommittedPolicy(root: string, rev = 'HEAD'): Promise<CommittedPolicy> {
  const [yml, approved, log] = await Promise.all([committedFile(root, rev, POLICY_FILE), committedFile(root, rev, APPROVED_FILE),
    policyGit(root, ['log', '-1', '--format=%h %an', rev, '--', POLICY_FILE]).catch(() => '')]);
  return { yml: yml ?? null, approved: approved ?? null, commit: log || null,
    unreadable: [...(yml === undefined ? [POLICY_FILE] : []), ...(approved === undefined ? [APPROVED_FILE] : [])] };
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
  const rev = opts.rev ?? 'HEAD';
  if (files.yml === null && files.approved === null && !files.unreadable.length && store !== 'git'
    && !(await policyGit(root, ['log', '-1', '--first-parent', '--format=%H', rev, '--', POLICY_FILE]).catch(() => 'unknown'))
    && !(await coverageRows(engine, sourceId)).some(c => c.reason === 'invalid')) {
    return { source_id: sourceId, state: 'skipped', reason: 'no_policy' };
  }
  const rebuild = await rebuildPending(engine, sourceId);
  if (files.unreadable.length) {
    const problems = [{ line: null, message: `${files.unreadable.join(' and ')} of source ${sourceId} at ${rev} cannot be read: the repository lacks its Git object (a partial clone, git clone --filter, never fetched it) and sync fetches nothing, so the source reads as nobody. `
      + `Fetch it in the checkout (${files.unreadable.map(path => `git -C ${root} cat-file -p ${rev}:./${path}`).join('; ')} fetches it from the partial clone's remote) or use a clone without --filter, then sync again.` }];
    await markPolicyInvalid(engine, sourceId, null, { problems, commit: files.commit, file: rebuild ? REBUILD_MARK : POLICY_FILE });
    return { source_id: sourceId, state: 'invalid', problems, commit: files.commit };
  }
  const approved = files.approved === null ? null : parsePolicyYaml(files.approved);
  let approvedFile: GitPolicySyncResult['approved_file'] = approved === null ? 'absent' : approved.ok ? undefined : 'invalid';
  if (rebuild) {
    const history = await policyHistory(root, rev, !!approved?.ok);
    if ('refusal' in history) {
      const problems = [{ line: null, message: history.refusal === 'shallow'
        ? `The checkout of source ${sourceId} is shallow, so its folder-rule history cannot be replayed; the source reads as nobody. Fetch the full history (git -C ${root} fetch --unshallow) and sync again.`
        : `The folder-rule history of source ${sourceId} cannot be read: the repository lacks Git objects it needs (a partial clone, git clone --filter, never fetched them) and sync fetches nothing, so the source reads as nobody. `
          + `Fetch them in the checkout (git -C ${root} log --first-parent -p ${rev} -- ${POLICY_FILE} reads every version, fetching what is missing from the partial clone's remote) or use a clone without --filter, then sync again.` }];
      await markPolicyInvalid(engine, sourceId, null, { problems, commit: files.commit, file: REBUILD_MARK });
      return { source_id: sourceId, state: 'invalid', problems, commit: files.commit, ...(approvedFile ? { approved_file: approvedFile } : {}) };
    }
    const replay = history.versions.slice(0, -1);
    if (approved?.ok || replay.length) {
      await markPolicyInvalid(engine, sourceId, null, { problems: [{ line: null, message: 'The folder rules are being rebuilt from git history; the source reads as nobody until the rebuild finishes.' }], commit: files.commit, file: REBUILD_MARK });
    }
    if (approved?.ok) {
      await proposeRevision(engine, sourceId, approved.rules, { origin: 'git-approved', approved: true, store: 'git', proposedBy: 'git:access.approved', onProgress: opts.onProgress });
      approvedFile = 'loaded';
    }
    for (const { commit, yml } of replay) {
      const parsed = yml === null ? { ok: true as const, rules: [] as FolderRule[] } : parsePolicyYaml(yml);
      if (parsed.ok) await proposeRevision(engine, sourceId, parsed.rules, { origin: 'git', store: 'git', proposedBy: `git:${commit.slice(0, 7)}`, onProgress: opts.onProgress });
    }
  } else if (approved?.ok) {
    const lastApproved = (await listRevisions(engine, sourceId, 500)).find(r => r.approved_at);
    approvedFile = lastApproved?.digest === rulebookDigest(approved.rules) ? 'matches' : 'untrusted';
  }
  const desired = files.yml === null ? { ok: true as const, rules: [] as FolderRule[] } : parsePolicyYaml(files.yml);
  if (!desired.ok) {
    await markPolicyInvalid(engine, sourceId, desired.prefixes, { problems: desired.problems, commit: files.commit, file: POLICY_FILE });
    if (store !== 'git') await writeAccessStore(engine, sourceId, 'git');
    return { source_id: sourceId, state: 'invalid', problems: desired.problems, commit: files.commit, approved_file: approvedFile };
  }
  const proposal = await proposeRevision(engine, sourceId, desired.rules, { origin: 'git', store: 'git', proposedBy: files.commit ? `git:${files.commit}` : 'git', onProgress: opts.onProgress });
  await clearPolicyInvalid(engine, sourceId);
  return { source_id: sourceId, state: proposal.state, proposal, commit: files.commit, approved_file: approvedFile };
}

/** Whether the next sync of the source rebuilds its rules from git: it has no revision yet, or an earlier rebuild was interrupted. */
async function rebuildPending(engine: BrainEngine, sourceId: string): Promise<boolean> {
  return !(await getRevision(engine, sourceId))
    || (await coverageRows(engine, sourceId)).some(c => c.reason === 'invalid' && (c.detail as { file?: string } | null)?.file === REBUILD_MARK);
}

/**
 * A rebuild replays every committed access.yml from the approved baseline's commit on (first-parent order), so a narrowing
 * that a later plain commit removed or deleted the file over is applied again and its removal held, as on the database that
 * saw each commit. This reads those versions through `rev` (the anchor first when `fromApproved`), fetching nothing, or
 * refuses: a shallow checkout cannot show the history, and a partial clone may lack a tree or a version of access.yml
 * (GST-2331: sync fetches nothing). GST-2638: a rebuild with nothing to replay installs one rulebook and needs no
 * whole-source mark; one with history reads as nobody from its start until it finishes (the next sync resumes it).
 */
async function policyHistory(root: string, rev: string, fromApproved: boolean): Promise<{ versions: Array<{ commit: string; yml: string | null }> } | { refusal: 'shallow' | 'partial' }> {
  if (await policyGit(root, ['rev-parse', '--is-shallow-repository']) === 'true') return { refusal: 'shallow' };
  const log = (args: string[]) => policyGit(root, ['log', '--first-parent', '--format=%H', ...args]);
  let commits: string[];
  try {
    const anchor = fromApproved ? await log(['-1', rev, '--', APPROVED_FILE]) : '';
    commits = [...(anchor ? [anchor] : []), ...(await log(['--reverse', anchor ? `${anchor}..${rev}` : rev, '--', POLICY_FILE])).split('\n').filter(Boolean)];
  } catch {
    return { refusal: 'partial' };
  }
  const versions: Array<{ commit: string; yml: string | null }> = [];
  for (const commit of commits) {
    const yml = await committedFile(root, commit, POLICY_FILE);
    if (yml === undefined) return { refusal: 'partial' };
    versions.push({ commit, yml });
  }
  return { versions };
}

/**
 * GST-2638: the refusal for a rule edit on a git-store source whose next sync would rebuild from history this checkout
 * cannot give (shallow, or a partial clone that lacks an object), or null. Read before anything is written, so a refused
 * edit commits nothing and marks nothing, and the source keeps its current reads.
 */
export async function rebuildPreflight(engine: BrainEngine, sourceId: string, root: string): Promise<OperationError | null> {
  if (!await rebuildPending(engine, sourceId)) return null;
  const approved = (await readCommittedPolicy(root)).approved;
  const history = await policyHistory(root, 'HEAD', approved !== null && parsePolicyYaml(approved).ok);
  if (!('refusal' in history)) return null;
  const shallow = history.refusal === 'shallow';
  const argv = shallow ? ['git', '-C', root, 'fetch', '--unshallow'] : ['git', '-C', root, 'log', '--first-parent', '-p', 'HEAD', '--', POLICY_FILE];
  return opError('access_policy_history_unreadable',
    shallow ? `Source ${sourceId} has no folder-rule revision yet and its checkout is shallow, so the first sync after this edit could not replay its folder-rule history and would read the whole source as nobody; nothing was written.`
      : `Source ${sourceId} has no folder-rule revision yet and its checkout is a partial clone that lacks Git objects of its folder-rule history, so the first sync after this edit could not replay it and would read the whole source as nobody; nothing was written.`,
    shallow ? `Fetch the full history (git -C ${root} fetch --unshallow), then run the same command again.`
      : `Fetch the missing objects (git -C ${root} log --first-parent -p HEAD -- ${POLICY_FILE} reads every version, fetching them from the partial clone's remote) or use a clone without --filter, then run the same command again.`,
    { fix: { argv, consent: [], actor: 'user', requires_exclusive: false,
      why: shallow ? 'Fetches the history the first folder-rule sync replays.' : 'Fetches every version of the folder-rule file the first sync replays.',
      verify: { argv: shallow ? ['git', '-C', root, 'rev-parse', '--is-shallow-repository'] : ['gbrain', 'access', 'rule', 'status', '--source', sourceId, '--json'] } } });
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
 * first needs the user's choice, the second a managed write on the brain host); a commit whose push is unconfirmed, or
 * whose push the secret scan refused (publish_secret_found / publish_scan_unreadable), is committed_not_pushed with a note.
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
          return { outcome: 'committed_not_pushed', commit: String(e.detail), path: relPath, note: 'Committed locally; the push is unconfirmed. Rerun gbrain git commit-push --push-only --scan-secrets to publish it.' };
        }
        if (e instanceof OperationError && (e.code === 'publish_secret_found' || e.code === 'publish_scan_unreadable') && gitShow(root, 'HEAD', relPath) === next) {
          const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: gitChildEnv() }).stdout.trim();
          return { outcome: 'committed_not_pushed', commit: head || null, path: relPath,
            note: `Committed locally; nothing was pushed. ${e.code}: ${e.message} Fix: ${e.suggestion}` };
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

/**
 * Writes the desired rules to access.yml through the door and applies them at once (as sync would). The git store is
 * persisted only once the commit landed (GST-2638): a refused commit leaves an unset store unset.
 */
export async function writeGitRules(engine: BrainEngine, sourceId: string, root: string, rules: FolderRule[], message: string, onProgress?: (p: RestampProgress) => void): Promise<{ receipt: GitPolicyReceipt; sync: GitPolicySyncResult }> {
  const receipt = await commitPolicyFile(root, POLICY_FILE, () => serializePolicyYaml(rules, POLICY_HEADER), message);
  if (!(await readAccessStore(engine, sourceId))) await writeAccessStore(engine, sourceId, 'git');
  const sync = await syncGitPolicy(engine, sourceId, root, { onProgress });
  return { receipt, sync };
}

/** Commits access.approved (the rulebook an operator approved) through the door. */
export async function writeApprovedFile(root: string, rules: FolderRule[], message: string): Promise<GitPolicyReceipt> {
  return commitPolicyFile(root, APPROVED_FILE, () => serializePolicyYaml(rules, APPROVED_HEADER), message);
}

/**
 * GBRA-218: applies the committed folder rules before and after `run` moves pages, so a committed narrowing is installed by
 * the same managed pass that pulled it (sync, drain, sources refresh, git conversion), never left for a later plain sync.
 */
export async function withCommittedPolicy<T>(engine: BrainEngine, sourceId: string, repoPath: string | undefined, run: () => Promise<T>): Promise<T> {
  const root = repoPath ?? await sourcePolicyRoot(engine, sourceId);
  await syncAccessPolicyAt(engine, sourceId, root, 'HEAD');
  const result = await run();
  await syncAccessPolicyAt(engine, sourceId, root, 'HEAD', serr);
  return result;
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
