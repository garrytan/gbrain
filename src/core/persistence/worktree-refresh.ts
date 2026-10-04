/**
 * F0 `gbrain sources refresh`: the one sanctioned Git writer for a managed
 * checkout. A worktree-wide, drained, fast-forward-only refresh with a
 * durable checkpoint (`persistence_worktree_refreshes`):
 *
 *   precheck (no DB state) -> draining -> fenced -> merged -> syncing -> completed
 *
 * `draining` refuses new checkout writes for every member source at admission
 * while queued work drains; `fenced` (worktree native lock held) stops claims
 * and runs `git merge --ff-only`; `merged` writes the upstream observation;
 * `syncing` runs the managed `--no-pull` sync per member and admits only those
 * sync writes. A crash converges through `resumeWorktreeRefreshes`, which only
 * adopts a HEAD it can verify. Git and network waits never run inside a
 * database transaction; fetch also runs outside the native locks.
 *
 * A per-worktree refresh lock (`locks/refresh-<worktree>.lock`) is held by the
 * refreshing process for its whole run, so recovery never touches the row of a
 * live refresh: holding that native lock proves the previous process exited.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { SyncResult } from '../../commands/sync.ts';
import { execFileBounded } from '../brain-repo-durability.ts';
import { loadConfig } from '../config.ts';
import { catalogueError, type CatalogueName } from '../error-catalogue.ts';
import type { Action } from '../agent-output.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { recordUpstreamObservation } from '../sync-upstream.ts';
import { checkpointRetryCommand } from './checkpoint-validation.ts';
import { localHostId, persistenceHome } from './identity.ts';
import { acquireNativeLock, tryAcquireNativeLock, type NativeLockHandle } from './native-lock.ts';
import { getWorktreeBinding, managedPersistenceEnabled, type WorktreeBinding } from './ownership.ts';
import { isPhysicalRootMetadata } from './physical-root-record.ts';
import { startPersistenceConsumer } from './service.ts';
import { lockTopologyPrincipal, lockTopologyRows, topologyPrincipal, withTopologyLocks } from './topology-locks.ts';
import { ACTIVE_REFRESH_STATES_SQL, CHECKOUT_EFFECT_KINDS_SQL, type WorktreeRefreshState } from './worktree-refresh-schema.ts';

export interface WorktreeRefreshRow {
  id: string; worktree_id: string; source_ids: string[]; principal_id: string; owner_epoch: string | number;
  topology_generation: string | number; state: WorktreeRefreshState; old_head: string; target_head: string; upstream_ref: string;
  preserved_uncommitted: string[]; outcome: Record<string, unknown>; created_at: string | Date; updated_at: string | Date; completed_at: string | Date | null;
}
export type RefreshBoundary = 'drained' | 'fenced' | 'merged';
export interface RefreshHooks { boundary?: (point: RefreshBoundary, row: WorktreeRefreshRow) => Promise<void> | void }
export interface RefreshOptions {
  dryRun?: boolean; resume?: boolean; abandon?: boolean;
  /** Flag value; falls back to GBRAIN_REFRESH_DRAIN_WAIT_MS, then `sources.refresh_drain_wait_ms`, then 60 s. */
  waitDrainMs?: number;
  /** Flag value; falls back to GBRAIN_REFRESH_FETCH_TIMEOUT_MS, then `sources.refresh_fetch_timeout_ms`, then 120 s. */
  fetchTimeoutMs?: number;
  hooks?: RefreshHooks;
}
export interface RefreshMemberSync { source_id: string; status: string; last_commit: string | null }
export interface RefreshSyncBlocked { source_id: string; code: string; message: string; resume: string }
export interface WorktreeRefreshResult {
  status: 'already_current' | 'completed' | 'sync_blocked' | 'dry_run' | 'syncing' | 'abandoned' | 'nothing_to_resume';
  refresh_id: string | null; worktree_id: string; source_ids: string[]; old_head: string | null; target_head: string | null;
  upstream_ref: string | null; preserved_uncommitted: string[]; incoming_files?: number;
  synced: RefreshMemberSync[]; sync_blocked?: RefreshSyncBlocked[]; next?: string;
}

const DRAIN_POLL_MS = 250;
const MAX_MEMBER_SYNC_PASSES = 20;
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };

function refusal(name: CatalogueName, cause: string, fix: string, refreshId?: string): OperationError {
  const error = catalogueError(name, cause, fix);
  if (refreshId) error.detail = `refresh_id=${refreshId}`;
  return error;
}
const writerStatusFix = (why: string, sourceId?: string): Action => readFix(why,
  { argv: ['gbrain', 'sources', 'writer', 'status', ...(sourceId ? ['--source', sourceId] : []), '--json'] });
const q = (value: string) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** Hardened git: no prompts, no user hooks, untranslated output, bounded. */
async function withGit<T>(run: (git: (args: string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }>) => Promise<T>): Promise<T> {
  const base = join(persistenceHome(), 'empty-hooks');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const hooks = mkdtempSync(join(base, 'refresh-'));
  try {
    return await run(async (args, timeoutMs = 30_000) => {
      const { error, stdout, stderr } = await execFileBounded('git', ['-c', 'core.quotepath=false', '-c', `core.hooksPath=${hooks}`, ...args],
        { timeout: timeoutMs, maxBuffer: 32 * 1024 ** 2, env: { ...process.env, ...GIT_ENV } });
      const timedOut = !!error && (error.killed || typeof error.code !== 'number');
      return { stdout, stderr, code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, timedOut };
    });
  } finally { rmSync(hooks, { recursive: true, force: true }); }
}
type Git = Parameters<Parameters<typeof withGit>[0]>[0];

async function revParse(git: Git, root: string, rev: string): Promise<string | null> {
  const out = await git(['-C', root, 'rev-parse', '--verify', '-q', `${rev}^{commit}`]);
  return out.code === 0 ? out.stdout.trim() : null;
}
async function isAncestor(git: Git, root: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(['-C', root, 'merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
}

/** Uncommitted paths (ignored files excluded) split into those the incoming diff touches and the rest. */
async function dirtyOverlap(git: Git, root: string, from: string, to: string): Promise<{ overlap: string[]; preserved: string[]; incoming: number }> {
  const status = await git(['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (status.code !== 0) {
    throw opError('storage_error', `git status failed in ${root}: ${status.stderr.trim().split('\n')[0]}`,
      `Git could not read the checkout at ${root}, so the refresh stopped before merging and the checkout was not changed. Fix what git status reports there, check the refresh state, then rerun gbrain sources refresh for that source with --resume or --abandon.`,
      { fix: writerStatusFix('Shows any refresh holding these sources in draining or fenced state, read-only.') });
  }
  const dirty: string[] = [];
  const fields = status.stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    dirty.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') dirty.push(fields[++i]);
  }
  const diff = await git(['-C', root, 'diff', '--name-only', '-z', '--no-renames', from, to]);
  if (diff.code !== 0) {
    throw opError('storage_error', `git diff failed in ${root}: ${diff.stderr.trim().split('\n')[0]}`,
      `Git could not compare ${from} with ${to} in ${root}, so the refresh stopped before merging and the checkout was not changed. Make sure both commits exist locally (fetch again if needed), check the refresh state, then rerun gbrain sources refresh for that source with --resume or --abandon.`,
      { fix: writerStatusFix('Shows any refresh holding these sources in draining or fenced state, read-only.') });
  }
  const incoming = diff.stdout.split('\0').filter(Boolean);
  const touches = (path: string) => incoming.some(file => file === path || (path.endsWith('/') && file.startsWith(path)) || path.startsWith(`${file}/`));
  const ours = (path: string) => isPhysicalRootMetadata(path.replace(/\/$/, '')) || path === '.gbrain-managed' || path.startsWith('.gbrain-managed/');
  const unique = [...new Set(dirty)].filter(path => !ours(path)).sort();
  return { overlap: unique.filter(touches), preserved: unique.filter(path => !touches(path)), incoming: incoming.length };
}

async function configuredMs(engine: BrainEngine, flag: number | undefined, env: string, key: string, fallback: number): Promise<number> {
  const raw = flag ?? (process.env[env] !== undefined && process.env[env] !== '' ? Number(process.env[env]) : undefined) ?? await engine.getConfig(key).then(v => v == null ? undefined : Number(v));
  if (raw === undefined) return fallback;
  if (!Number.isFinite(raw) || raw < 0) throw new OperationError('invalid_params', `${key} (or ${env}) must be a whole number of milliseconds; got ${raw}.`,
    `Run gbrain config set ${key} ${fallback} (or unset ${env}), then retry.`);
  return Math.floor(raw);
}

function refreshLockPath(worktreeId: string): string { return join(persistenceHome(), 'locks', `refresh-${worktreeId}.lock`); }

async function readActiveRefresh(engine: BrainEngine, worktreeId: string): Promise<WorktreeRefreshRow | null> {
  const [row] = await engine.executeRaw<WorktreeRefreshRow>(`SELECT * FROM persistence_worktree_refreshes
    WHERE worktree_id=$1::uuid AND state IN ${ACTIVE_REFRESH_STATES_SQL}`, [worktreeId]);
  return row ?? null;
}
async function readRefresh(engine: BrainEngine, id: string): Promise<WorktreeRefreshRow> {
  const [row] = await engine.executeRaw<WorktreeRefreshRow>('SELECT * FROM persistence_worktree_refreshes WHERE id=$1::uuid', [id]);
  if (!row) {
    throw opError('not_found', 'The worktree refresh record disappeared.',
      `Refresh ${id}'s record is gone, so another process finished or removed it. Check the writer status before refreshing again.`,
      { fix: writerStatusFix('Shows the current refresh and drain state of every managed source, read-only.') });
  }
  return row;
}
/** Conditional transition: returns false when another process already moved the row. */
async function transition(tx: BrainEngine, row: WorktreeRefreshRow, from: WorktreeRefreshState[], to: WorktreeRefreshState, outcome: Record<string, unknown> = {}): Promise<boolean> {
  const terminal = to === 'completed' || to === 'aborted';
  const changed = await tx.executeRaw(`UPDATE persistence_worktree_refreshes SET state=$3,outcome=outcome||$4::text::jsonb,updated_at=now(),
    completed_at=CASE WHEN $5::boolean THEN now() ELSE completed_at END WHERE id=$1::uuid AND state=ANY($2::text[]) RETURNING id`,
  [row.id, from, to, JSON.stringify(outcome), terminal]);
  return changed.length === 1;
}
function refusalOutcome(error: OperationError): Record<string, unknown> {
  return { refusal: { code: error.code, cause: error.message, fix: error.suggestion, docs: error.docs } };
}
async function abort(engine: BrainEngine, row: WorktreeRefreshRow, from: WorktreeRefreshState[], error: OperationError, extra: Record<string, unknown> = {}): Promise<never> {
  await engine.transaction(tx => transition(tx, row, from, 'aborted', { ...refusalOutcome(error), ...extra }));
  error.detail = `refresh_id=${row.id}`;
  throw error;
}
async function markRecoveryRequired(engine: BrainEngine, row: WorktreeRefreshRow, head: string | null, root: string): Promise<OperationError> {
  const source = row.source_ids[0];
  const error = refusal('refresh_recovery_required',
    `The checkout HEAD (${head ?? 'unreadable'}) is neither the pre-refresh commit ${row.old_head} nor the verified upstream commit ${row.target_head}; writes to this worktree stay fenced.`,
    `Inspect with gbrain sources writer status ${source}. Ask the user before resetting the checkout (destructive): git -C ${q(root)} reset --hard ${row.old_head} then gbrain sources refresh ${source} --abandon, or git -C ${q(root)} reset --hard ${row.target_head} then gbrain sources refresh ${source} --resume.`,
    row.id);
  await engine.transaction(tx => transition(tx, row, ['draining', 'fenced', 'merged', 'syncing', 'recovery_required'], 'recovery_required',
    { ...refusalOutcome(error), observed_head: head }));
  return error;
}

interface Plan {
  binding: WorktreeBinding; root: string; members: string[]; upstreamRef: string; oldHead: string; targetHead: string;
  overlap: string[]; preserved: string[]; incoming: number;
}

/** Steps 1.3/1: refusals before any database state; fetch moves only remote-tracking refs. */
async function precheck(engine: BrainEngine, git: Git, sourceId: string, fetchTimeoutMs: number): Promise<Plan> {
  if (!await managedPersistenceEnabled(engine)) throw refusal('refresh_not_managed',
    'This brain is not managed, so gbrain sync pulls the checkout itself; there is no worktree fence to coordinate.', `gbrain sync --source ${sourceId}`);
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!binding) throw refusal('refresh_not_managed',
    `Source ${sourceId} has no claimed canonical worktree, so gbrain sync pulls it without a refresh.`, `gbrain sync --source ${sourceId}`);
  if (binding.owner_host_id !== localHostId() || !binding.local_path) throw refusal('refresh_not_owner',
    `Only the registered owner host of source ${sourceId} may move its checkout; this host is not that owner.`,
    `Run gbrain sources refresh ${sourceId} on the owner host; check which host owns it with gbrain sources writer status ${sourceId}`);
  const root = binding.local_path;
  const active = await readActiveRefresh(engine, binding.worktree_id);
  if (active) throw refusal('refresh_in_progress', `Refresh ${active.id} of this worktree is ${active.state}; only one refresh per worktree runs at a time.`,
    `gbrain sources refresh ${sourceId} --resume`, active.id);
  if (binding.state !== 'active' || await worktreeRecoveryPending(engine, binding)) throw refusal('refresh_recovery_required',
    'Publication or topology recovery is pending on this worktree; the checkout must not move until it is recovered.',
    `gbrain sources writer status ${sourceId}, let the owner finish recovery, then gbrain sources refresh ${sourceId}`);
  const members = (await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid ORDER BY source_id',
    [binding.worktree_id])).map(row => row.source_id);
  await assertNoUnfinishedSync(engine, members);
  const branch = (await git(['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  const upstream = branch ? await git(['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) : null;
  if (!branch || !upstream || upstream.code !== 0) {
    const remote = (await git(['-C', root, 'remote'])).stdout.split('\n').map(v => v.trim()).filter(Boolean)[0] ?? 'origin';
    throw refusal('refresh_no_upstream', `The checkout ${branch ? `branch ${branch}` : '(detached HEAD)'} has no upstream branch, so there is nothing to fast-forward to.`,
      branch ? `git -C ${q(root)} branch --set-upstream-to ${remote}/${branch}` : `git -C ${q(root)} switch <branch>, then git -C ${q(root)} branch --set-upstream-to ${remote}/<branch>`);
  }
  const upstreamRef = upstream.stdout.trim();
  const remote = (await git(['-C', root, 'config', '--get', `branch.${branch}.remote`])).stdout.trim();
  const merge = (await git(['-C', root, 'config', '--get', `branch.${branch}.merge`])).stdout.trim();
  if (remote && remote !== '.') {
    const fetched = await git(['-C', root, 'fetch', '--no-tags', '--quiet', remote, merge || branch], fetchTimeoutMs);
    if (fetched.code !== 0) throw refusal('fetch_failed',
      fetched.timedOut ? `git fetch ${remote} did not finish within ${fetchTimeoutMs} ms; nothing changed.`
        : `git fetch ${remote} failed (${fetched.stderr.trim().split('\n')[0] || `exit ${fetched.code}`}); nothing changed.`,
      `Retry gbrain sources refresh ${sourceId}; for a slow remote raise the bound: gbrain sources refresh ${sourceId} --fetch-timeout-ms ${Math.max(fetchTimeoutMs * 2, 120_000)} (or gbrain config set sources.refresh_fetch_timeout_ms <ms>).`);
  }
  const oldHead = await revParse(git, root, 'HEAD');
  const targetHead = await revParse(git, root, '@{upstream}');
  if (!oldHead || !targetHead) throw refusal('refresh_no_upstream', `The checkout HEAD or its upstream ${upstreamRef} does not resolve to a commit.`,
    `git -C ${q(root)} fetch ${remote || 'origin'}, then gbrain sources refresh ${sourceId}`);
  if (oldHead !== targetHead && !await isAncestor(git, root, oldHead, targetHead)) throw refusal('refresh_diverged',
    `The checkout HEAD ${oldHead} is not an ancestor of ${upstreamRef} (${targetHead}); a fast-forward is impossible and nothing changed.`,
    `Reconcile the histories and push from a non-managed clone, then retry gbrain sources refresh ${sourceId}; or replace the checkout with gbrain sources reclone ${sourceId} (ask the user first).`);
  const dirt = await dirtyOverlap(git, root, oldHead, targetHead);
  if (dirt.overlap.length) throw dirtyRefusal(sourceId, dirt.overlap);
  return { binding, root, members, upstreamRef, oldHead, targetHead, ...dirt };
}
function dirtyRefusal(sourceId: string, overlap: string[], refreshId?: string): OperationError {
  const named = overlap.slice(0, 20).join(', ') + (overlap.length > 20 ? ` and ${overlap.length - 20} more` : '');
  return refusal('refresh_dirty', `Uncommitted or untracked paths overlap the incoming upstream changes: ${named}. Nothing changed.`,
    `Commit or discard those paths (check gbrain sources writer status ${sourceId} --json for pending git effects first), then retry gbrain sources refresh ${sourceId}.`, refreshId);
}
/**
 * Recovery no live execution will finish. A publisher holds the worktree native
 * lock from its claim until it clears its recovery record, and that clear runs
 * after the receipt commits (coordinator `completeWrite`, then
 * `clearResolvedRecovery`). So a request or effect record is in flight, and left
 * to the drain step, while it is under an unexpired running claim or while the
 * worktree lock is held; only a record still present while this probe holds
 * that lock (no live process can finish it) refuses.
 * Topology recovery always refuses.
 */
async function worktreeRecoveryPending(engine: BrainEngine, binding: WorktreeBinding): Promise<boolean> {
  const probe = async () => (await engine.executeRaw<{ publication: boolean; topology: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL
      AND NOT (state='running' AND claim_expires_at > now()))
    OR EXISTS (SELECT 1 FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL
      AND NOT (state='running' AND claim_expires_at > now())) AS publication,
    EXISTS (SELECT 1 FROM persistence_topology_changes WHERE recovery IS NOT NULL AND recovery->>'worktreeId'=$1::text) AS topology`, [binding.worktree_id]))[0];
  const first = await probe();
  if (first?.topology === true) return true;
  if (first?.publication !== true || !binding.coordination_path) return first?.publication === true;
  const lock = await tryAcquireNativeLock(binding.coordination_path);
  if (!lock) return false;
  // Holding the lock, no publisher is mid-flight: a record that is still here has no live owner.
  try { const held = await probe(); return held?.publication === true || held?.topology === true; }
  finally { await lock.release(); }
}
/** Never wait on a sync: an unexhausted cursor names its own resume command. */
async function assertNoUnfinishedSync(engine: BrainEngine, members: string[]): Promise<void> {
  const [cursor] = await engine.executeRaw<{ source_id: string; header: Record<string, unknown>; failed: boolean }>(`SELECT c.completed_keys->0->>'sourceId' AS source_id,
    c.completed_keys->0 AS header,EXISTS (SELECT 1 FROM op_checkpoints f WHERE f.op='managed-sync-failure' AND f.fingerprint=c.fingerprint) AS failed
    FROM op_checkpoints c WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
    AND c.completed_keys->0->>'sourceId'=ANY($1::text[]) ORDER BY c.updated_at LIMIT 1`, [members]);
  if (!cursor) return;
  const header = cursor.header as { processingOptions?: Record<string, boolean>; syncOptions?: Parameters<typeof checkpointRetryCommand>[0]['syncOptions'] };
  const resume = checkpointRetryCommand({ sourceId: cursor.source_id, processingOptions: header.processingOptions, syncOptions: header.syncOptions ?? null });
  throw refusal('sync_in_progress', `Source ${cursor.source_id} has an unfinished managed sync cursor; moving the checkout now would strand it.`,
    `${cursor.failed ? resume : resume.replace(' --retry-failed', '')}, then retry the refresh.`);
}

async function drainCounts(engine: BrainEngine, worktreeId: string): Promise<{ requests: number; effects: number; recovery: number }> {
  const [row] = await engine.executeRaw<{ requests: number; effects: number; recovery: number }>(`SELECT
    (SELECT count(*) FROM persistence_requests WHERE worktree_id=$1::uuid AND state IN ('queued','running','recovering'))::int AS requests,
    (SELECT count(*) FROM persistence_effects WHERE worktree_id=$1::uuid AND kind IN ${CHECKOUT_EFFECT_KINDS_SQL} AND state IN ('queued','running'))::int AS effects,
    ((SELECT count(*) FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL)
      +(SELECT count(*) FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL))::int AS recovery`, [worktreeId]);
  return { requests: Number(row.requests), effects: Number(row.effects), recovery: Number(row.recovery) };
}

async function headOf(git: Git, root: string): Promise<string | null> { return revParse(git, root, 'HEAD'); }

/** Step 5: `merged` and the lane B upstream observation, then `syncing`, in one transaction. */
async function bookkeeping(engine: BrainEngine, row: WorktreeRefreshRow): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    if (!await transition(tx, row, ['fenced', 'merged', 'recovery_required'], 'merged')) {
      throw opError('source_changed', 'The refresh record changed under its own lock.',
        `Another process moved refresh ${row.id} for ${row.source_ids.join(', ')} while this one held its lock, so this run stopped after the merge without recording it. Check the writer status, then converge with gbrain sources refresh ${row.source_ids[0]} --resume, which adopts only a HEAD it can verify.`,
        { fix: writerStatusFix(`Shows refresh ${row.id}'s state and the member sources' heads, read-only.`, row.source_ids[0]) });
    }
    await tx.executeRaw(`UPDATE sources SET upstream_checked_at=now(),upstream_commit=$2,upstream_behind=0 WHERE id=ANY($1::text[])`, [row.source_ids, row.target_head]);
    await transition(tx, row, ['merged'], 'syncing');
  });
}

/** Steps 6-7: the managed `--no-pull` sync per member, then completion when every member is at target_head. */
async function syncMembers(engine: BrainEngine, git: Git, row: WorktreeRefreshRow, root: string): Promise<{ synced: RefreshMemberSync[]; blocked: RefreshSyncBlocked[] }> {
  const { performManagedSync } = await import('./sync-run.ts');
  const synced: RefreshMemberSync[] = [], blocked: RefreshSyncBlocked[] = [];
  for (const sourceId of row.source_ids) {
    let status = 'up_to_date';
    for (let pass = 0; pass < MAX_MEMBER_SYNC_PASSES; pass++) {
      const commit = await lastCommit(engine, sourceId);
      if (commit === row.target_head || (commit && commit !== row.old_head && await isAncestor(git, root, row.target_head, commit))) break;
      let result: SyncResult;
      try { result = await performManagedSync(engine, { sourceId, noPull: true }); }
      catch (error) {
        const failure = error instanceof OperationError ? error : opError('storage_error', error instanceof Error ? error.message : String(error),
          `The managed sync of source ${sourceId} failed during refresh ${row.id}. Check its writer status, fix the cause, then resume with gbrain sync --source ${sourceId} --no-pull --retry-failed.`);
        blocked.push({ source_id: sourceId, code: failure.code, message: failure.message, resume: `gbrain sync --source ${sourceId} --no-pull --retry-failed` });
        status = 'blocked';
        break;
      }
      status = result.status;
      if (result.status === 'blocked_by_failures') {
        blocked.push({ source_id: sourceId, code: result.managedWrite?.write_error ?? result.failureCodes?.[0]?.code ?? 'sync_blocked',
          message: result.managedWrite?.message ?? 'The managed sync is blocked by a failed write.', resume: `gbrain sync --source ${sourceId} --no-pull --retry-failed` });
        break;
      }
      if (result.status === 'partial') await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_MS));
    }
    await recordUpstreamObservation(engine, sourceId);
    synced.push({ source_id: sourceId, status, last_commit: await lastCommit(engine, sourceId) });
  }
  const atTarget = synced.every(member => member.last_commit === row.target_head);
  if (atTarget || blocked.length) await engine.transaction(tx => transition(tx, row, ['syncing'], 'completed',
    { synced, ...(blocked.length ? { sync_blocked: blocked } : {}) }));
  return { synced, blocked };
}
async function lastCommit(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]);
  return row?.last_commit ?? null;
}

function finished(row: WorktreeRefreshRow, sync: { synced: RefreshMemberSync[]; blocked: RefreshSyncBlocked[] }, preserved = row.preserved_uncommitted): WorktreeRefreshResult {
  const status = sync.blocked.length ? 'sync_blocked' : sync.synced.every(member => member.last_commit === row.target_head) ? 'completed' : 'syncing';
  return { status, refresh_id: row.id, worktree_id: row.worktree_id, source_ids: row.source_ids, old_head: row.old_head, target_head: row.target_head,
    upstream_ref: row.upstream_ref, preserved_uncommitted: preserved, synced: sync.synced,
    ...(sync.blocked.length ? { sync_blocked: sync.blocked, next: sync.blocked.map(item => item.resume).join(' ; ') } : {}),
    ...(status === 'syncing' ? { next: `gbrain sources refresh ${row.source_ids[0]} --resume` } : {}) };
}

/**
 * `gbrain sources refresh <source>`. Trusted local CLI on the registered owner
 * host only; refusals throw catalogue errors (`code`, cause, literal fix, docs).
 */
export async function refreshWorktree(engine: BrainEngine, sourceId: string, opts: RefreshOptions = {}): Promise<WorktreeRefreshResult> {
  if (opts.resume || opts.abandon) return resumeOrAbandon(engine, sourceId, opts);
  const fetchTimeoutMs = await configuredMs(engine, opts.fetchTimeoutMs, 'GBRAIN_REFRESH_FETCH_TIMEOUT_MS', 'sources.refresh_fetch_timeout_ms', 120_000);
  const waitDrainMs = await configuredMs(engine, opts.waitDrainMs, 'GBRAIN_REFRESH_DRAIN_WAIT_MS', 'sources.refresh_drain_wait_ms', 60_000);
  return withGit(async git => {
    const plan = await precheck(engine, git, sourceId, fetchTimeoutMs);
    const base = { refresh_id: null, worktree_id: plan.binding.worktree_id, source_ids: plan.members, old_head: plan.oldHead,
      target_head: plan.targetHead, upstream_ref: plan.upstreamRef, preserved_uncommitted: plan.preserved, incoming_files: plan.incoming };
    if (opts.dryRun) return { ...base, status: 'dry_run', synced: [],
      next: plan.oldHead === plan.targetHead ? `Already at ${plan.upstreamRef}; nothing to fast-forward.` : `gbrain sources refresh ${sourceId}` };
    if (plan.oldHead === plan.targetHead) {
      const synced: RefreshMemberSync[] = [], blocked: RefreshSyncBlocked[] = [];
      const { performManagedSync } = await import('./sync-run.ts');
      for (const member of plan.members) {
        await recordUpstreamObservation(engine, member);
        if (await lastCommit(engine, member) === plan.oldHead) { synced.push({ source_id: member, status: 'up_to_date', last_commit: plan.oldHead }); continue; }
        try {
          const result = await performManagedSync(engine, { sourceId: member, noPull: true });
          if (result.status === 'blocked_by_failures') blocked.push({ source_id: member, code: result.managedWrite?.write_error ?? 'sync_blocked',
            message: result.managedWrite?.message ?? 'The managed sync is blocked by a failed write.', resume: `gbrain sync --source ${member} --no-pull --retry-failed` });
          synced.push({ source_id: member, status: result.status, last_commit: await lastCommit(engine, member) });
        } catch (error) {
          blocked.push({ source_id: member, code: (error as OperationError).code ?? 'storage_error', message: (error as Error).message, resume: `gbrain sync --source ${member} --no-pull --retry-failed` });
        }
      }
      return { ...base, status: blocked.length ? 'sync_blocked' : 'already_current', synced, ...(blocked.length ? { sync_blocked: blocked, next: blocked.map(b => b.resume).join(' ; ') } : {}) };
    }
    const refreshLock = await tryAcquireNativeLock(refreshLockPath(plan.binding.worktree_id));
    if (!refreshLock) throw refusal('refresh_in_progress', 'Another process is refreshing this worktree right now.', `gbrain sources refresh ${sourceId} --resume`);
    try {
      const principal = await topologyPrincipal(engine);
      const row = await fenceDraining(engine, sourceId, plan, principal);
      const config = loadConfig() ?? { engine: engine.kind };
      // The owner keeps claiming what is already queued; this process may be that owner.
      startPersistenceConsumer(engine, config);
      const deadline = performance.now() + waitDrainMs;
      for (;;) {
        const counts = await drainCounts(engine, row.worktree_id);
        if (counts.requests + counts.effects + counts.recovery === 0) break;
        if (performance.now() >= deadline) {
          await abort(engine, row, ['draining'], refusal('refresh_drain_timeout',
            `The worktree queue did not drain within ${waitDrainMs} ms (${counts.requests} request(s), ${counts.effects} checkout effect(s), ${counts.recovery} recovery record(s) pending); the fence was lifted and nothing moved.`,
            `Retry gbrain sources refresh ${sourceId}, or wait longer: gbrain sources refresh ${sourceId} --wait-drain ${Math.ceil(Math.max(waitDrainMs * 2, 120_000) / 1000)}. Inspect the queue with gbrain sources writer status ${sourceId} --json.`), { counts });
        }
        await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_MS));
      }
      await opts.hooks?.boundary?.('drained', row);
      const merged = await fenceAndMerge(engine, git, sourceId, plan, row, opts.hooks);
      const sync = await syncMembers(engine, git, merged, plan.root);
      return finished(await readRefresh(engine, row.id), sync, plan.preserved);
    } finally { await refreshLock.release(); }
  });
}

/** Step 2: native topology + worktree locks, then one transaction inserting the `draining` row. */
async function fenceDraining(engine: BrainEngine, sourceId: string, plan: Plan, principal: string): Promise<WorktreeRefreshRow> {
  return withTopologyLocks(engine, sourceId, async bindings => engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','5s',true)");
    await lockTopologyPrincipal(tx, principal);
    const sources = await lockTopologyRows(tx, sourceId, bindings);
    const current = bindings.find(binding => binding.worktree_id === plan.binding.worktree_id);
    if (!current || String(current.owner_epoch) !== String(plan.binding.owner_epoch) || String(current.topology_generation) !== String(plan.binding.topology_generation)
      || sources.join(',') !== plan.members.join(',')) {
      throw refusal('refresh_source_changed', 'The worktree ownership or source membership changed after the refresh precheck; nothing moved.', `Retry gbrain sources refresh ${sourceId}`);
    }
    const [row] = await tx.executeRaw<WorktreeRefreshRow>(`INSERT INTO persistence_worktree_refreshes
      (worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref,preserved_uncommitted)
      VALUES($1::uuid,$2::text[],$3::uuid,$4,$5,'draining',$6,$7,$8,$9::text[]) RETURNING *`,
    [plan.binding.worktree_id, plan.members, principal, String(current.owner_epoch), String(current.topology_generation),
      plan.oldHead, plan.targetHead, plan.upstreamRef, plan.preserved]);
    return row;
  })).catch(error => {
    if ((error as { code?: string }).code === '23505') throw refusal('refresh_in_progress', 'Another refresh of this worktree started first.', `gbrain sources refresh ${sourceId} --resume`);
    throw error;
  });
}

/** Steps 3-5 under the worktree native lock: recheck drained, fence, verify HEAD, ff-only merge, bookkeeping. */
async function fenceAndMerge(engine: BrainEngine, git: Git, sourceId: string, plan: Plan, row: WorktreeRefreshRow, hooks?: RefreshHooks): Promise<WorktreeRefreshRow> {
  let fenced: WorktreeRefreshRow;
  try {
    fenced = await withTopologyLocks(engine, sourceId, async bindings => {
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','5s',true)");
        const sources = await lockTopologyRows(tx, sourceId, bindings, row.id);
        const current = bindings.find(binding => binding.worktree_id === row.worktree_id);
        if (!current || String(current.owner_epoch) !== String(row.owner_epoch) || String(current.topology_generation) !== String(row.topology_generation)
          || sources.join(',') !== row.source_ids.join(',')) {
          throw refusal('refresh_source_changed', 'The worktree ownership or source membership changed while the refresh drained; nothing moved.', `Retry gbrain sources refresh ${sourceId}`, row.id);
        }
        const counts = await drainCounts(tx, row.worktree_id);
        if (counts.requests + counts.effects + counts.recovery > 0) throw refusal('refresh_source_changed',
          `Work reached the worktree after the drain check (${counts.requests} request(s), ${counts.effects} checkout effect(s), ${counts.recovery} recovery record(s)); nothing moved.`,
          `Retry gbrain sources refresh ${sourceId}`, row.id);
        if (!await transition(tx, row, ['draining'], 'fenced')) throw refusal('refresh_source_changed', 'The refresh record was moved by recovery while draining.', `gbrain sources refresh ${sourceId} --resume`, row.id);
      });
      const current = await readRefresh(engine, row.id);
      await hooks?.boundary?.('fenced', current);
      const head = await headOf(git, plan.root);
      if (head !== row.old_head) {
        if (head === null) throw await markRecoveryRequired(engine, current, head, plan.root);
        await abort(engine, current, ['fenced'], refusal('refresh_source_changed',
          `The checkout HEAD moved from ${row.old_head} to ${head} after the precheck (an external commit or checkout); nothing was merged.`, `Retry gbrain sources refresh ${sourceId}`));
      }
      const dirt = await dirtyOverlap(git, plan.root, row.old_head, row.target_head);
      if (dirt.overlap.length) await abort(engine, current, ['fenced'], dirtyRefusal(sourceId, dirt.overlap));
      const merge = await git(['-C', plan.root, 'merge', '--ff-only', '--no-edit', '--quiet', row.target_head], 120_000);
      const after = await headOf(git, plan.root);
      if (merge.code !== 0 || after !== row.target_head) {
        if (after === row.old_head) await abort(engine, current, ['fenced'], refusal('refresh_dirty',
          `git merge --ff-only refused (${merge.stderr.trim().split('\n')[0] || `exit ${merge.code}`}); HEAD is unchanged at ${row.old_head}.`,
          `Commit or discard the paths git names (check gbrain sources writer status ${sourceId} --json for pending git effects), then retry gbrain sources refresh ${sourceId}.`));
        throw await markRecoveryRequired(engine, current, after, plan.root);
      }
      await hooks?.boundary?.('merged', current);
      await bookkeeping(engine, current);
      return readRefresh(engine, row.id);
    }, undefined, 30_000);
  } catch (error) {
    const stored = await readRefresh(engine, row.id);
    if (stored.state === 'draining' && error instanceof OperationError) {
      await engine.transaction(tx => transition(tx, stored, ['draining'], 'aborted', refusalOutcome(error)));
      error.detail ??= `refresh_id=${row.id}`;
    }
    throw error;
  }
  return fenced;
}

async function hostRoot(engine: BrainEngine, worktreeId: string, hostId = localHostId()): Promise<string | null> {
  const [row] = await engine.executeRaw<{ local_path: string | null }>(
    'SELECT local_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid', [worktreeId, hostId]);
  return row?.local_path ?? null;
}

/**
 * Section 1.5: deterministic, bounded convergence of one interrupted refresh.
 * The caller holds the refresh lock. Returns the row after the step.
 */
async function recoverOne(engine: BrainEngine, git: Git, row: WorktreeRefreshRow, root: string): Promise<WorktreeRefreshRow> {
  const head = await headOf(git, root);
  if (row.state === 'draining') {
    await engine.transaction(tx => transition(tx, row, ['draining'], 'aborted', { refusal: { code: 'refresh_interrupted', cause: 'The refreshing process stopped while draining; no merge was started.' } }));
  } else if (row.state === 'fenced' && head === row.old_head) {
    await engine.transaction(tx => transition(tx, row, ['fenced'], 'aborted', { refusal: { code: 'refresh_interrupted', cause: 'The refreshing process stopped before merging; HEAD is unchanged.' } }));
  } else if (['fenced', 'merged', 'recovery_required'].includes(row.state) && head === row.target_head && await isAncestor(git, root, row.old_head, row.target_head)) {
    await bookkeeping(engine, row);
  } else if (row.state === 'syncing' && head !== null && (head === row.target_head || await isAncestor(git, root, row.target_head, head))) {
    // stays syncing; the member syncs run from --resume or any later cycle sync.
  } else if (row.state !== 'recovery_required') {
    await markRecoveryRequired(engine, row, head, root);
  }
  return readRefresh(engine, row.id);
}

/**
 * Owner-startup recovery: every interrupted refresh (draining, fenced or
 * merged) on this host's worktrees whose refreshing process has exited (its
 * refresh lock is free) is converged one step, so the scan finds nothing on
 * the next tick. Member syncs are not run here: a `syncing` row is finished by
 * `--resume`, or by the next cycle sync plus admission's lazy completion.
 */
export async function resumeWorktreeRefreshes(engine: BrainEngine, opts: { hostId?: string } = {}): Promise<number> {
  const host = opts.hostId ?? localHostId();
  const rows = await engine.executeRaw<WorktreeRefreshRow>(`SELECT f.* FROM persistence_worktree_refreshes f
    JOIN persistence_worktrees w ON w.id=f.worktree_id WHERE w.owner_host_id=$1::uuid AND f.state IN ('draining','fenced','merged')
    ORDER BY f.created_at LIMIT 16`, [host]);
  let moved = 0;
  for (const row of rows) {
    const root = await hostRoot(engine, row.worktree_id, host);
    if (!root) continue;
    const lock = await tryAcquireNativeLock(refreshLockPath(row.worktree_id));
    if (!lock) continue;
    try {
      await withGit(async git => {
        const after = await withTopologyLocks(engine, row.source_ids[0], async () => recoverOne(engine, git, await readRefresh(engine, row.id), root), undefined, 0);
        if (after.state !== row.state) moved++;
      });
    } catch (error) {
      if (!(error instanceof OperationError && ['write_pending', 'recovery_required', 'refresh_recovery_required', 'owner_unavailable'].includes(error.code))) throw error;
    } finally { await lock.release(); }
  }
  return moved;
}

async function resumeOrAbandon(engine: BrainEngine, sourceId: string, opts: RefreshOptions): Promise<WorktreeRefreshResult> {
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!await managedPersistenceEnabled(engine) || !binding) throw refusal('refresh_not_managed',
    `Source ${sourceId} has no claimed canonical worktree on a managed brain, so there is no refresh to resume.`, `gbrain sync --source ${sourceId}`);
  if (binding.owner_host_id !== localHostId() || !binding.local_path) throw refusal('refresh_not_owner',
    `Only the registered owner host of source ${sourceId} may resume its refresh.`, `Run it on the owner host; check it with gbrain sources writer status ${sourceId}`);
  const root = binding.local_path;
  const active = await readActiveRefresh(engine, binding.worktree_id);
  const empty: WorktreeRefreshResult = { status: 'nothing_to_resume', refresh_id: null, worktree_id: binding.worktree_id, source_ids: [sourceId],
    old_head: null, target_head: null, upstream_ref: null, preserved_uncommitted: [], synced: [], next: `gbrain sources refresh ${sourceId}` };
  if (!active) return empty;
  const lock = await acquireNativeLock(refreshLockPath(binding.worktree_id), { timeoutMs: 1000 }).catch(() => null as NativeLockHandle | null);
  if (!lock) throw refusal('refresh_in_progress', `Refresh ${active.id} is still running in another process.`, `Wait for it, then gbrain sources refresh ${sourceId} --resume`, active.id);
  try {
    return await withGit(async git => {
      const head = await headOf(git, root);
      if (opts.abandon) {
        const row = await readRefresh(engine, active.id);
        if (row.state === 'syncing') throw refusal('refresh_in_progress', 'The checkout already holds the upstream commit; abandoning now would leave files ahead of the database.',
          `gbrain sources refresh ${sourceId} --resume`, row.id);
        if (row.state !== 'draining' && head !== row.old_head) {
          if (head === row.target_head) throw refusal('refresh_in_progress', `The checkout is at the refresh target ${row.target_head}; finish it instead of abandoning.`,
            `gbrain sources refresh ${sourceId} --resume`, row.id);
          throw await markRecoveryRequired(engine, row, head, root);
        }
        await engine.transaction(tx => transition(tx, row, ['draining', 'fenced', 'merged', 'recovery_required'], 'aborted',
          { refusal: { code: 'refresh_abandoned', cause: `The operator abandoned the refresh with HEAD at ${head}.` } }));
        return { ...empty, status: 'abandoned', refresh_id: row.id, source_ids: row.source_ids, old_head: row.old_head, target_head: row.target_head,
          upstream_ref: row.upstream_ref, preserved_uncommitted: row.preserved_uncommitted, next: `gbrain sources refresh ${sourceId}` };
      }
      let row = await withTopologyLocks(engine, sourceId, async () => recoverOne(engine, git, await readRefresh(engine, active.id), root), undefined, 30_000);
      if (row.state === 'recovery_required' && head === row.old_head) throw refusal('refresh_recovery_required',
        `The checkout is back at the pre-refresh commit ${row.old_head}; nothing remains to resume.`, `gbrain sources refresh ${sourceId} --abandon`, row.id);
      if (row.state === 'recovery_required') {
        const stored = (row.outcome.refusal ?? {}) as { cause?: string; fix?: string };
        throw refusal('refresh_recovery_required', stored.cause ?? 'The refresh could not verify the checkout HEAD.',
          stored.fix ?? `gbrain sources writer status ${sourceId}, then gbrain sources refresh ${sourceId} --resume`, row.id);
      }
      if (row.state !== 'syncing') return { ...empty, status: 'abandoned', refresh_id: row.id, source_ids: row.source_ids, old_head: row.old_head,
        target_head: row.target_head, upstream_ref: row.upstream_ref, next: `The interrupted refresh was rolled back without moving HEAD; start again with gbrain sources refresh ${sourceId}` };
      startPersistenceConsumer(engine, loadConfig() ?? { engine: engine.kind });
      const sync = await syncMembers(engine, git, row, root);
      row = await readRefresh(engine, row.id);
      return finished(row, sync);
    });
  } finally { await lock.release(); }
}

/**
 * A managed sync started elsewhere (cycle, autopilot, `gbrain sync`) while a
 * refresh drains or holds the fence is refused before discovery, so it never
 * freezes a cursor against the pre-refresh HEAD; the next cycle retries.
 */
export async function assertManagedSyncAllowed(engine: BrainEngine, worktreeId: string, sourceId: string): Promise<void> {
  const [refresh] = await engine.executeRaw<{ id: string; state: string }>(`SELECT id,state FROM persistence_worktree_refreshes
    WHERE worktree_id=$1::uuid AND state IN ('draining','fenced','merged','recovery_required')`, [worktreeId]);
  if (!refresh) return;
  if (refresh.state === 'recovery_required') throw refusal('refresh_recovery_required',
    `Refresh ${refresh.id} could not verify the checkout HEAD of source ${sourceId}; sync stays fenced.`,
    `gbrain sources writer status ${sourceId}, then gbrain sources refresh ${sourceId} --resume`, refresh.id);
  const error = refusal('worktree_refreshing', `Source ${sourceId}'s checkout is being fast-forwarded by refresh ${refresh.id} (${refresh.state}); this sync did not start.`,
    `Retry after retry_after_ms: 1000; the refresh runs this sync itself. Check progress with gbrain sources writer status ${sourceId}.`);
  error.detail = 'retry_after_ms=1000';
  throw error;
}

/** `gbrain sources writer status`: active refreshes (optionally of one source's worktree) with the command that moves each on. */
export async function activeWorktreeRefreshes(engine: BrainEngine, sourceId?: string): Promise<Array<Record<string, unknown>>> {
  const rows = await engine.executeRaw<WorktreeRefreshRow>(`SELECT * FROM persistence_worktree_refreshes WHERE state IN ${ACTIVE_REFRESH_STATES_SQL}
    AND ($1::text IS NULL OR $1=ANY(source_ids)) ORDER BY created_at`, [sourceId ?? null]);
  return rows.map(row => ({ refresh_id: row.id, worktree_id: row.worktree_id, state: row.state, source_ids: row.source_ids,
    old_head: row.old_head, target_head: row.target_head, upstream_ref: row.upstream_ref, updated_at: new Date(row.updated_at).toISOString(),
    ...(row.outcome.refusal ? { refusal: row.outcome.refusal } : {}),
    next: row.state === 'draining' ? 'Writes to this worktree are refused while queued work drains; retry them after about a second.'
      : `gbrain sources refresh ${row.source_ids[0]} --resume` }));
}

/** Doctor `worktree_refresh_stuck`: active refreshes older than `minutes`. */
export async function stuckWorktreeRefreshes(engine: BrainEngine, minutes = 15): Promise<Array<Pick<WorktreeRefreshRow, 'id' | 'state' | 'source_ids' | 'updated_at'>>> {
  return engine.executeRaw(`SELECT id,state,source_ids,updated_at FROM persistence_worktree_refreshes
    WHERE state IN ${ACTIVE_REFRESH_STATES_SQL} AND created_at < now()-($1::double precision*interval '1 minute') ORDER BY created_at`, [minutes]);
}
