/**
 * #6543 (B2): why the queued head of a root is not claimable, one predicate of `claimableWriteSql` at a time, so a drain stop,
 * the stall line and `sources writer status` name what blocks it instead of a constant "claimable here: no".
 *
 * Blockers are classified. Intervention-required ones stop the drain (`drain_stalled`, `cause: head_blocked`) after one
 * governor tick of confirmation: a durable refresh fence no live refresh process holds, a running row ahead whose owner
 * reports `restart_required` (a zombie publication), or a withdrawal-mirror effect recovery its own last attempt refused
 * `unexpected_file_bytes` whose file still matches neither recorded version (an edit made while the mirror was publishing;
 * recovery only finishes forward and never overwrites it), or a page write's publication recovery refused the same way (#6650;
 * `gbrain repair stuck-recovery` is its exit, for a page write and a shared-skill bundle alike), whether it blocks a queued head or is the head itself;
 * the effect recovery's exit is the same preview (`--keep withdrawn`); or an effect or request recovery record a newer gbrain wrote
 * (`recovery_version_unsupported`: an upgrade is its exit). Every other blocker is live and transient (a foreground publication,
 * a refresh or recovery making progress, a lapsed lease the next consumer reclaims), so the drain keeps its progress-aware wait.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { cliRenderContext, renderAction, type Action, type RenderedAction } from '../agent-output.ts';
import { claimStateOf } from './claim-phase.ts';
import { isTerminal, type RequestState } from './model.ts';
import { sha256 } from './digest.ts';
import { claimableWriteSql, EARLIER_HEAD, foregroundPrioritySql, SYNC_KIND } from './journal.ts';
import { BACKOFF_ELAPSED } from './transient-retry.ts';
import { recoveryUpgradeFix, recoveryVersionKnown, type RecoveryTable } from './recovery-version.ts';

export type HeadBlockerPredicate = 'worktree_owner' | 'refresh_fence' | 'effect_recovery' | 'withdrawal_mirror' | 'request_recovery'
  | 'zombie_publication' | 'lease' | 'root_hold' | 'transient_backoff';
export interface HeadBlocker {
  predicate: HeadBlockerPredicate;
  /** The refresh id for a fence, the request ids of blocking requests (the head itself for `transient_backoff`), the effect ids of blocking effects, or the worktree id. */
  ids: string[];
  /** The fence state, the blocking request's state, the worktree state (`other_host` when another host owns it), why an effect recovery cannot finish, or when a backoff ends (ISO time). */
  state: string | null;
  /** The process behind the blocker when one is known: a refresh process (`live` from its lock) or a claim's stamped owner. */
  owner: { kind: string | null; pid: number | null; live: boolean | null; restart_required: boolean } | null;
  /** True when only an operator clears it; the drain stops on these and keeps waiting on the rest. */
  intervention: boolean;
  /** The canonical file an `unexpected_file_bytes` effect or request recovery refuses to overwrite; an effect's names the withdrawal request. */
  file?: { slug: string; path: string; request_id?: string };
}
/** A blocking request this caller may cancel: not publishing, no recovery record; `cancel-write-request` is scoped to its principal. */
export interface HeadBlockerCancel { request_id: string; principal_kind: string; principal_id: string }
export type HeadBlockerRead = { status: 'claimable' } | { status: 'blocked'; blocker: HeadBlocker; cancel: HeadBlockerCancel | null } | { status: 'unknown' };

interface RowRef { request_id: string; state: string; claim_phase: unknown; execution_token: string | null; claim_lapsed: boolean;
  publication_started: boolean; recovery: boolean; principal_kind: string; principal_id: string }
interface ProbeRow { id: string; worktree_id: string | null; owner_host_id: string | null; worktree_state: string | null; claimable: boolean;
  fence: { id: string; state: string } | null; effect_recovery: EffectRecoveryRef[] | null; mirrors: string[] | null; request_recovery: RequestRecoveryRef[] | null;
  request_id: string; backoff_until: string | Date | null; earlier: RowRef[] | null; ahead: RowRef[] | null }
interface EffectRecoveryRef { id: string; request_id: string | null; error_code: string | null; slug: string | null; path: string | null; before: string | null; after: string | null; version: unknown }
interface RequestRecoveryRef { request_id: string; state: RequestState; blocked_reason: string | null; slug: string; version: string | null; path: string | null;
  before: string | null; after: string | null; files: Array<{ path: string | null; before: string | null; after: string | null }> | null }
const REQUEST_RECOVERY = (alias: string) => `jsonb_build_object('request_id',${alias}.request_id::text,'state',${alias}.state,'blocked_reason',${alias}.blocked_reason,
  'slug',${alias}.slug,'version',${alias}.recovery->>'version','path',${alias}.recovery->>'path','before',${alias}.recovery->>'beforeHash','after',${alias}.recovery->>'afterHash',
  'files',(SELECT jsonb_agg(jsonb_build_object('path',f->>'path','before',f->>'beforeHash','after',f->>'afterHash'))
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${alias}.recovery->'files')='array' THEN ${alias}.recovery->'files' ELSE '[]'::jsonb END) f))`;

/**
 * Whether a recovery's last attempt refused `unexpected_file_bytes` and its file still matches neither recorded hash (the check
 * recovery itself refuses on), so only the user clears it. A file put back on a recorded version is live again before the next
 * attempt clears the code; a file this process cannot read keeps the recovery's own verdict.
 */
function stuckOnFile(code: string | null, path: string | null, before: string | null, after: string | null): path is string {
  if (code !== 'unexpected_file_bytes' || !path) return false;
  try {
    const actual = existsSync(path) ? sha256(readFileSync(path)) : null;
    return actual !== before && actual !== after;
  } catch { return true; }
}
const effectRecoveryStuck = (effect: EffectRecoveryRef) => stuckOnFile(effect.error_code, effect.path, effect.before, effect.after);
/** A live page or skill-bundle recovery's first file that matches neither recorded version (a terminal one never restores its file). */
const requestRecoveryStuckFile = (request: RequestRecoveryRef): string | null => {
  if (isTerminal(request)) return null;
  const files = request.version === '1' ? [{ path: request.path, before: request.before, after: request.after }] : request.version === '2' ? request.files ?? [] : [];
  return files.find(file => stuckOnFile(request.blocked_reason, file.path, file.before, file.after))?.path ?? null;
};
/** A record a newer gbrain wrote (recovery-version.ts): no recovery here finishes it, so only an upgrade clears it. */
const newerRecord = (table: RecoveryTable, version: unknown) => !recoveryVersionKnown(table, { version: typeof version === 'string' && /^\d+$/.test(version) ? Number(version) : version });
const newerBlocker = (predicate: 'effect_recovery' | 'request_recovery', ids: string[]): HeadBlocker =>
  ({ predicate, ids, state: 'recovery_version_unsupported', owner: null, intervention: true });
const requestRecoveryBlocker = (refs: RequestRecoveryRef[]): HeadBlocker => {
  if (refs.some(ref => newerRecord('persistence_requests', ref.version))) return newerBlocker('request_recovery', refs.map(ref => ref.request_id));
  const stuck = refs.map(ref => ({ ref, path: requestRecoveryStuckFile(ref) })).find(entry => entry.path);
  return { predicate: 'request_recovery', ids: refs.map(ref => ref.request_id), state: stuck ? 'unexpected_file_bytes' : null, owner: null, intervention: !!stuck,
    ...(stuck ? { file: { slug: stuck.ref.slug, path: stuck.path! } } : {}) };
};

const REF = (alias: string) => `jsonb_build_object('request_id',${alias}.request_id::text,'state',${alias}.state,'claim_phase',${alias}.claim_phase,
  'execution_token',${alias}.execution_token::text,'claim_lapsed',COALESCE(${alias}.claim_expires_at<now(),false),'publication_started',COALESCE(${alias}.publication_started,false),
  'recovery',${alias}.recovery IS NOT NULL,'principal_kind',${alias}.principal_kind,'principal_id',${alias}.principal_id)`;

/**
 * One read for queued requests (internal ids): each comes back `claimable` for a consumer on `hostId`, `blocked` with the first
 * predicate that fails in `claimableWriteSql` order, or `unknown` when none matched. Rejects when the read fails; callers print `unknown`.
 */
export async function readHeadBlockers(engine: BrainEngine, ids: string[], hostId: string | null,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Map<string, HeadBlockerRead>> {
  const out = new Map<string, HeadBlockerRead>();
  if (!ids.length) return out;
  const priority = foregroundPrioritySql();
  const rows = await engine.executeRaw<ProbeRow>(`SELECT r.id::text AS id, r.request_id::text AS request_id, r.worktree_id::text AS worktree_id, w.owner_host_id::text AS owner_host_id, w.state AS worktree_state,
      CASE WHEN NOT ${BACKOFF_ELAPSED('r')} THEN r.next_attempt_at END AS backoff_until,
      (${claimableWriteSql(priority)}) AS claimable,
      (SELECT jsonb_build_object('id',f.id::text,'state',f.state) FROM persistence_worktree_refreshes f
        WHERE f.worktree_id=r.worktree_id AND f.state IN ('fenced','merged','recovery_required') LIMIT 1) AS fence,
      (SELECT jsonb_agg(jsonb_build_object('id',e.id::text,'request_id',(SELECT q.request_id::text FROM persistence_requests q WHERE q.id=e.request_id),'error_code',e.error_code,'slug',e.recovery->>'slug','path',e.recovery->>'path',
        'before',e.recovery->>'beforeHash','after',e.recovery->>'afterHash','version',e.recovery->'version') ORDER BY e.id) FROM persistence_effects e WHERE e.worktree_id=r.worktree_id AND e.recovery IS NOT NULL) AS effect_recovery,
      (SELECT array_agg(m.id::text) FROM persistence_effects m WHERE m.worktree_id=r.worktree_id AND m.kind='withdrawal-mirror' AND m.state IN ('queued','running')
        AND (NOT (m.data ? 'targets') OR m.data->'targets' @> jsonb_build_array(jsonb_build_object('slug',r.slug)))) AS mirrors,
      (SELECT jsonb_agg(${REQUEST_RECOVERY('b')} ORDER BY b.sequence) FROM persistence_requests b WHERE b.worktree_id=r.worktree_id AND b.recovery IS NOT NULL) AS request_recovery,
      (SELECT jsonb_agg(${REF('e')} ORDER BY e.sequence) FROM persistence_requests e
        WHERE ((r.worktree_id IS NOT NULL AND e.worktree_id=r.worktree_id) OR (r.worktree_id IS NULL AND e.worktree_id IS NULL AND e.source_incarnation=r.source_incarnation))
        AND ${EARLIER_HEAD('e', 'r', priority, "'{}'::text[]")}) AS earlier,
      (SELECT jsonb_agg(${REF('a')} ORDER BY a.sequence) FROM persistence_requests a WHERE (${priority}) AND ${SYNC_KIND('r')}
        AND a.worktree_id=r.worktree_id AND a.sequence>r.sequence AND a.state IN ('running','recovering') AND NOT ${SYNC_KIND('a')}) AS ahead
    FROM persistence_requests r LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
    WHERE r.id=ANY($3::uuid[]) AND r.state='queued'`, [hostId, [], ids], opts);
  let consumers: Awaited<ReturnType<typeof import('./consumer-heartbeat.ts').listHostConsumers>> | null = null;
  for (const row of rows) {
    if (row.claimable) { out.set(row.id, { status: 'claimable' }); continue; }
    const blocked = (blocker: HeadBlocker, cancel: HeadBlockerCancel | null = null) => out.set(row.id, { status: 'blocked', blocker, cancel });
    if (row.worktree_id && (row.owner_host_id !== hostId || row.worktree_state !== 'active')) {
      blocked({ predicate: 'worktree_owner', ids: [row.worktree_id], state: row.owner_host_id !== hostId ? 'other_host' : row.worktree_state, owner: null, intervention: false });
      continue;
    }
    if (row.fence && row.worktree_id) {
      const live = await refreshOwnerLive(row.worktree_id);
      blocked({ predicate: 'refresh_fence', ids: [row.fence.id], state: row.fence.state, owner: { kind: 'refresh', pid: null, live, restart_required: false },
        intervention: row.fence.state === 'recovery_required' || live === false });
      continue;
    }
    if (row.effect_recovery?.length && row.effect_recovery.some(effect => newerRecord('persistence_effects', effect.version))) {
      blocked(newerBlocker('effect_recovery', row.effect_recovery.map(effect => effect.id)));
      continue;
    }
    if (row.effect_recovery?.length) {
      const stuck = row.effect_recovery.find(effectRecoveryStuck);
      blocked({ predicate: 'effect_recovery', ids: row.effect_recovery.map(effect => effect.id), state: stuck ? 'unexpected_file_bytes' : null, owner: null, intervention: !!stuck,
        ...(stuck ? { file: { slug: stuck.slug ?? '', path: stuck.path!, ...(stuck.request_id ? { request_id: stuck.request_id } : {}) } } : {}) });
      continue;
    }
    if (row.mirrors?.length) { blocked({ predicate: 'withdrawal_mirror', ids: row.mirrors, state: null, owner: null, intervention: false }); continue; }
    if (row.request_recovery?.length) { blocked(requestRecoveryBlocker(row.request_recovery)); continue; }
    // v261: the head itself waits out a transient interruption's backoff (transient-retry.ts); it is claimed again when it ends.
    if (row.backoff_until) { blocked({ predicate: 'transient_backoff', ids: [row.request_id], state: new Date(row.backoff_until).toISOString(), owner: null, intervention: false }); continue; }
    const ref = row.earlier?.[0] ?? row.ahead?.[0];
    if (!ref) { out.set(row.id, { status: 'unknown' }); continue; }
    const claim = claimStateOf({ state: ref.state, claim_phase: ref.claim_phase, execution_token: ref.execution_token, claim_lapsed: ref.claim_lapsed, publication_started: ref.publication_started });
    if (claim?.owner && hostId && consumers === null) {
      const { listHostConsumers } = await import('./consumer-heartbeat.ts');
      consumers = await listHostConsumers(engine, hostId, { signal: opts.signal }).catch(() => []);
    }
    const heartbeat = claim?.owner ? consumers?.find(c => c.pid === claim.owner!.pid && (claim.owner!.nonce === undefined || c.nonce === claim.owner!.nonce)) ?? null : null;
    const owner = claim?.owner ? { kind: claim.owner.kind, pid: claim.owner.pid, live: heartbeat ? heartbeat.liveness === 'live' : null, restart_required: heartbeat?.restart_required === true } : null;
    const predicate: HeadBlockerPredicate = owner?.restart_required ? 'zombie_publication' : claim?.phase === 'publication_transaction' ? 'lease' : 'root_hold';
    const cancellable = ref.state !== 'recovering' && !ref.publication_started && !ref.recovery;
    blocked({ predicate, ids: [ref.request_id], state: ref.state, owner, intervention: predicate === 'zombie_publication' },
      cancellable ? { request_id: ref.request_id, principal_kind: ref.principal_kind, principal_id: ref.principal_id } : null);
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { status: 'unknown' });
  return out;
}

/**
 * A head that is itself a recovering page or skill-bundle write: its blocker only when its recovery is stuck on the user (see `requestRecoveryStuckFile`)
 * and this host owns its worktree, so the recorded path is this host's file; null otherwise, the recovery being live work.
 */
async function recoveringHeadBlocker(engine: BrainEngine, id: string, hostId: string | null, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<HeadBlocker | null> {
  const [row] = await engine.executeRaw<{ ref: RequestRecoveryRef; owner_host_id: string | null }>(`SELECT ${REQUEST_RECOVERY('r')} AS ref, w.owner_host_id::text AS owner_host_id
    FROM persistence_requests r JOIN persistence_worktrees w ON w.id=r.worktree_id WHERE r.id=$1::uuid AND r.recovery IS NOT NULL`, [id], opts);
  if (!row || !hostId || row.owner_host_id !== hostId || (!requestRecoveryStuckFile(row.ref) && !newerRecord('persistence_requests', row.ref.version))) return null;
  return requestRecoveryBlocker([row.ref]);
}

/** Whether a refresh process holds the worktree's refresh lock: true held, false free, null when the lock cannot be probed here. */
async function refreshOwnerLive(worktreeId: string): Promise<boolean | null> {
  try {
    const { refreshLockPath } = await import('./worktree-refresh.ts');
    const { tryAcquireNativeLock } = await import('./native-lock.ts');
    const lock = await tryAcquireNativeLock(refreshLockPath(worktreeId));
    if (!lock) return true;
    await lock.release();
    return false;
  } catch { return null; }
}

/** `blocked_by=` for the stall line and the summary. */
export function headBlockerText(blocker: HeadBlocker): string {
  const owner = blocker.owner?.pid ? `${blocker.owner.kind ?? 'owner'} pid ${blocker.owner.pid}${blocker.owner.restart_required ? ' restart_required' : ''}`
    : blocker.predicate === 'refresh_fence' ? blocker.owner?.live === true ? 'refresh running' : blocker.owner?.live === false ? 'no live refresh' : null : null;
  return `${blocker.predicate}(${[blocker.state, blocker.ids.join(','), owner].filter(Boolean).join(' ')})`;
}

/** The predicate's recovery contract, as the drain's JSON `next` (fix) and the writer-status advice carry it. */
export function headBlockerAction(blocker: HeadBlocker, sourceId: string, resumeCommand: string): Action {
  const status = ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'];
  if (blocker.predicate === 'refresh_fence') {
    return { argv: ['gbrain', 'sources', 'refresh', sourceId, '--resume'], consent: [], actor: 'agent', requires_exclusive: false,
      why: `Refresh ${blocker.ids[0]} left the checkout fenced (${blocker.state})${blocker.owner?.live === false ? ' and no refresh process holds its lock' : ''}, so nothing on the source's worktree is claimed. `
        + `Resuming it finishes (or names why it cannot finish) the refresh and lifts the fence; then rerun: ${resumeCommand}`,
      verify: { argv: status } };
  }
  if (blocker.state === 'recovery_version_unsupported') {
    const kind = blocker.predicate === 'effect_recovery' ? 'withdrawal-mirror effect' : 'write request';
    return { ...recoveryUpgradeFix(sourceId),
      why: `A ${kind} recovery record on source ${sourceId}'s worktree (${blocker.ids.join(', ')}) was written by a newer gbrain, so this gbrain cannot finish it and every write there waits; `
        + `waiting does not clear it. Upgrading gbrain on the owner host lets its writer finish the recovery; then rerun: ${resumeCommand}` };
  }
  if (blocker.predicate === 'zombie_publication') {
    const who = `the gbrain ${blocker.owner?.kind ?? 'owner'} process${blocker.owner?.pid ? ` (pid ${blocker.owner.pid})` : ''}`;
    return { argv: status, consent: [], actor: 'host_admin', requires_exclusive: false,
      why: `Request ${blocker.ids[0]} ahead of the head is held by ${who}, which reports restart_required; its root stays held until that process exits. Status names it, read-only.`,
      user_message: `Restart ${who} on the brain host, then run: ${resumeCommand}`, verify: { argv: status } };
  }
  if (blocker.predicate === 'request_recovery' && blocker.intervention && blocker.file) {
    const { path, slug } = blocker.file;
    const preview = ['gbrain', 'repair', 'stuck-recovery', '--source', sourceId];
    return { argv: preview, consent: [], actor: 'agent', requires_exclusive: false,
      why: `A write to ${path} (page ${slug}) was interrupted while publishing and the file was edited after that: it matches neither the bytes from before the write `
        + `nor the bytes the write published, so recovery will not overwrite it, every write to source ${sourceId} waits, and waiting does not clear it. `
        + 'The preview changes no page or canonical file (it writes only private diffs) and lists the file, its diff and the choices; which version to keep is the user\'s call.',
      user_message: `${path} was edited while gbrain was writing page ${slug}, so gbrain will not touch the file and writes to source ${sourceId} are paused. `
        + `Either undo the edit (put the file back as it was) and run: ${resumeCommand}. Or choose which version to keep with ${preview.join(' ')}, which shows the diff: `
        + 'the bytes from before gbrain\'s write, or the edited bytes. Do not delete the file.',
      verify: { argv: status } };
  }
  if (blocker.predicate === 'effect_recovery' && blocker.intervention && blocker.file) {
    const { path, slug, request_id: requestId } = blocker.file;
    const preview = ['gbrain', 'repair', 'stuck-recovery', '--source', sourceId, ...(requestId ? ['--request-id', requestId] : [])];
    return { argv: preview, consent: [], actor: 'agent', requires_exclusive: false,
      why: `Mirroring a fact withdrawal into ${path} (page ${slug}) stopped between writing the file and recording it, and the file was edited after that: `
        + 'it matches neither the version from before the withdrawal nor the withdrawn version gbrain wrote. Recovery only finishes forward and never overwrites '
        + `bytes it cannot account for, so every write to source ${sourceId} waits and waiting does not clear it. The preview changes nothing (it writes only private diffs) `
        + 'and lists the file with its only choice, --keep withdrawn; applying it is the user\'s call.',
      user_message: `${path} was edited while gbrain was removing a withdrawn fact from it, so gbrain will not touch the file and writes to source ${sourceId} are paused. `
        + `Either restore the committed version (git -C ${dirname(path)} checkout -- ${basename(path)}) and run: ${resumeCommand}. Or run ${preview.join(' ')}, which shows the diff `
        + 'and offers --keep withdrawn: it backs the edited file up, then writes the version without the withdrawn fact. Do not delete the file. Either way, make the edit '
        + 'again afterwards, leaving the withdrawn fact out.',
      verify: { argv: status } };
  }
  return { argv: status, consent: [], actor: 'agent', requires_exclusive: false,
    why: `The head waits on ${headBlockerText(blocker)}, which is making progress on its own. Rerun status (read-only) to see it clear.`, verify: { argv: status } };
}

/** The drain's `next` for a `head_blocked` stop. */
export function headBlockedNext(blocker: HeadBlocker, headRequestId: string | null, stalledSeconds: number, sourceId: string, resumeCommand: string):
  { command: string; safe_to_loop: false; retry_after_ms: 0; why: string; fix: RenderedAction } {
  const action = headBlockerAction(blocker, sourceId, resumeCommand);
  return { command: action.argv!.join(' '), safe_to_loop: false, retry_after_ms: 0, fix: renderAction(action, cliRenderContext()),
    why: `The queued write at the head of this source (${headRequestId ?? 'unknown request'}) cannot be claimed by any consumer: it is blocked by ${headBlockerText(blocker)}, `
      + `which no amount of waiting clears${stalledSeconds ? ` (quiet ${stalledSeconds}s)` : ''}. The cursor and accepted writes are intact. ${action.user_message ?? action.why}` };
}

/**
 * `consumer=` for the stall line: this process's own consumer, or the live full/promoted heartbeat row on this host
 * (`serve pid=N last_heartbeat_ago=3s`, plus `restart_required`), or `none`. Never rejects (`unknown`).
 */
export async function describeHostConsumer(engine: BrainEngine, opts: { signal?: AbortSignal } = {}): Promise<string> {
  try {
    const { persistenceConsumerStatus } = await import('./service.ts');
    const status = persistenceConsumerStatus(engine) as { state: string; consumer_election?: { mode: string } };
    const mode = status.consumer_election?.mode ?? (status.state === 'open' ? 'full' : null);
    if (mode === 'full' || mode === 'promoted') return `self(${mode})`;
    const { existingLocalHostId } = await import('./identity.ts');
    const host = existingLocalHostId();
    const { listHostConsumers } = await import('./consumer-heartbeat.ts');
    const rows = host ? await listHostConsumers(engine, host, opts) : [];
    const owner = rows.find(row => !row.self && (row.mode === 'full' || row.mode === 'promoted') && row.liveness === 'live');
    const text = owner ? `${owner.kind} pid=${owner.pid} last_heartbeat_ago=${Math.round(owner.renewed_age_ms / 1000)}s${owner.restart_required ? ' restart_required' : ''}` : null;
    if (mode) return text ? `self(${mode}→${text})` : `self(${mode})`;
    return text ?? 'none';
  } catch { return 'unknown'; }
}

/**
 * `claimable_here` and `blocked_by` for a head: a queued head is probed (a failed read is `null`, printed `unknown`); any other head is not
 * claimable, and a recovering head names itself as its blocker only when its recovery is stuck on the user.
 */
export async function headClaimability(engine: BrainEngine, head: { id: string | null; state: string | null }, hostId: string | null,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ claimable_here: boolean | null; blocked_by: HeadBlocker | null }> {
  if (head.id && head.state === 'recovering') {
    return recoveringHeadBlocker(engine, head.id, hostId, opts).then(blocker => ({ claimable_here: false, blocked_by: blocker }), () => ({ claimable_here: false, blocked_by: null }));
  }
  if (!head.id || head.state !== 'queued') return { claimable_here: false, blocked_by: null };
  const read = await readHeadBlockers(engine, [head.id], hostId, opts).then(found => found.get(head.id!) ?? { status: 'unknown' as const }, () => ({ status: 'unknown' as const }));
  return read.status === 'claimable' ? { claimable_here: true, blocked_by: null } : read.status === 'blocked' ? { claimable_here: false, blocked_by: read.blocker } : { claimable_here: null, blocked_by: null };
}

/**
 * Writer status: the blocker of each root's first queued request (`claimable_here`, `blocked_by`, advice naming the predicate's recovery),
 * plus `cancel_command` only when the blocking request can still be cancelled and belongs to this host's CLI writer principal.
 */
export async function readQueuedHeadBlockers(engine: BrainEngine, rows: Array<{ id: string; worktree_id: string | null; source_id: string | null; state: string }>,
  hostId: string | null): Promise<Map<string, { fields: { claimable_here: boolean | null; blocked_by?: HeadBlocker; cancel_command?: string }; advice: string | null }>> {
  const heads = new Map<string, { id: string; source: string | null }>();
  for (const row of rows) if (row.state === 'queued' && !heads.has(row.worktree_id ?? `db:${row.source_id}`)) heads.set(row.worktree_id ?? `db:${row.source_id}`, { id: row.id, source: row.source_id });
  const out = new Map<string, { fields: { claimable_here: boolean | null; blocked_by?: HeadBlocker; cancel_command?: string }; advice: string | null }>();
  if (!heads.size) return out;
  const reads = await readHeadBlockers(engine, [...heads.values()].map(head => head.id), hostId).catch(() => null);
  let principal: { kind: string; id: string } | null | undefined;
  for (const { id, source } of heads.values()) {
    const read = reads?.get(id) ?? { status: 'unknown' as const };
    if (read.status !== 'blocked') { out.set(id, { fields: { claimable_here: read.status === 'claimable' ? true : null }, advice: null }); continue; }
    if (read.cancel && principal === undefined) {
      const { readLocalWriter } = await import('./identity.ts');
      principal = await readLocalWriter(engine, 'cli').then(local => ({ kind: 'local_cli', id: local.id }), () => null);
    }
    const cancel = read.cancel && principal && read.cancel.principal_kind === principal.kind && read.cancel.principal_id === principal.id
      ? `gbrain cancel-write-request ${read.cancel.request_id}` : null;
    const action = headBlockerAction(read.blocker, source ?? '<source>', `gbrain sync --source ${source ?? '<source>'}`);
    out.set(id, { fields: { claimable_here: false, blocked_by: read.blocker, ...(cancel ? { cancel_command: cancel } : {}) },
      advice: `Blocked by ${headBlockerText(read.blocker)}: ${action.user_message ?? action.why}${read.blocker.predicate === 'refresh_fence' || (read.blocker.predicate === 'request_recovery' && read.blocker.intervention) ? ` Run: ${action.argv!.join(' ')}.` : ''}`
        + `${cancel ? ` Cancelling the blocking request (it has not started publishing) also frees the head; a sync rerun admits it again: ${cancel}` : ''}` });
  }
  return out;
}
