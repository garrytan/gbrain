import { randomUUID } from 'node:crypto';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { OperationError } from '../ops/contract.ts';
import type { PreparedMutation } from './coordinator.ts';
import { sha256 } from './digest.ts';
import { PARK_AFTER_FAILURES, type EffectKind, type PersistenceEffect, type EffectRequest } from './effect-model.ts';
import type { SqlEngine } from './model.ts';
import { isFactsExtractionEnabled } from '../facts/extract.ts';
import { resolveDefaultVisibility } from '../facts/visibility.ts';
import { declarePersistenceProtocol, PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';

/** `snapshot` is the publication's final read of the page, including deleted rows, in this transaction. */
export async function queuePublicationEffects(tx: BrainEngine, row: EffectRequest, snapshot: PageSnapshot | null,
  outcome: Record<string, unknown>, prepared?: PreparedMutation): Promise<void> {
  if (prepared?.noop || prepared?.target === 'skill_bundle') return;
  await declarePersistenceProtocol(tx);
  const revision = snapshot?.revision;
  const data = { slug: row.slug, page_id: snapshot?.page.id };
  const queue = async (kind: EffectKind, extra: Record<string, unknown> = {}) => tx.executeRaw(`INSERT INTO persistence_effects
    (request_id,kind,revision,data,source_id,source_incarnation,worktree_id)
    VALUES($1::uuid,$2,$3::uuid,$4::text::jsonb,$5,$6::uuid,$7::uuid) ON CONFLICT(request_id,kind) DO NOTHING`,
  [row.id, kind, revision ?? null, JSON.stringify({ ...data, ...extra }), row.source_id, row.source_incarnation, row.worktree_id]);
  if (prepared?.file && row.worktree_id) {
    const [binding] = await tx.executeRaw<{ local_path: string }>(`SELECT h.local_path FROM persistence_host_bindings h
      JOIN persistence_worktrees w ON w.id=h.worktree_id AND w.owner_host_id=h.host_id WHERE w.id=$1::uuid`, [row.worktree_id]);
    if (!binding?.local_path) throw new OperationError('owner_unavailable', 'Cannot record the canonical Git target without its owner binding.');
    await queue('git', { relative_path: relative(binding.local_path, prepared.file.path).split(sep).join('/'),
      expected_hash: prepared.file.content === null ? null : sha256(prepared.file.content) });
    if (outcome.persistence && typeof outcome.persistence === 'object') Object.assign(outcome.persistence, { git_state: 'queued' });
  }
  if (snapshot && !snapshot.page.deleted_at) {
    if (!prepared?.deferEmbedding) await queue('embedding');
    outcome.embedding_state = prepared?.deferEmbedding ? 'deferred' : 'queued';
    if ((outcome.facts_backstop as { queued?: boolean } | undefined)?.queued) {
      if (!(await isFactsExtractionEnabled(tx))) outcome.facts_backstop = { skipped: 'extraction_disabled' };
      else await queue('facts-backstop', { visibility: await resolveDefaultVisibility(tx) });
    }
  }
}

/** Claims release their database connection before waiting for a filesystem lock/provider. */
export async function claimPersistenceEffect(engine: BrainEngine, hostId: string): Promise<PersistenceEffect | null> {
  return engine.transactionDirect(async tx => {
    await declarePersistenceProtocol(tx);
    const [candidate] = await tx.executeRaw<PersistenceEffect>(`SELECT e.* FROM persistence_effects e
      LEFT JOIN persistence_worktrees w ON w.id=e.worktree_id
      WHERE (e.state='queued' OR e.state='running' AND e.claim_expires_at<now()) AND e.next_attempt_at<=now()
      AND (e.worktree_id IS NULL OR w.owner_host_id=$1::uuid)
      AND e.recovery IS NULL AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND (e.kind='withdrawal-mirror' OR NOT EXISTS (SELECT 1 FROM persistence_effects mirror
        WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state<>'committed'))
      ORDER BY e.next_attempt_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`, [hostId]);
    if (!candidate) return null;
    const [claimed] = await tx.executeRaw<PersistenceEffect>(`UPDATE persistence_effects SET state='running',execution_token=$2::uuid,
      claim_expires_at=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *`, [candidate.id, randomUUID()]);
    return claimed;
  });
}

/** #5530: an effect that commits exactly one recorded file (not a withdrawal walk or a source scan). */
export function singleFileGitEffect(effect: PersistenceEffect): boolean {
  return effect.kind === 'git' && typeof effect.data.relative_path === 'string' && effect.data.version === undefined
    && !effect.data.source_scan && effect.data.targets === undefined;
}

/**
 * #5530: claim up to `limit` more ready single-file Git effects for one
 * worktree, under the same readiness, recovery and withdrawal-mirror ordering
 * rules as claimPersistenceEffect, so the runner commits them together.
 */
export async function claimCoalescedGitEffects(engine: BrainEngine, hostId: string, worktreeId: string, limit: number): Promise<PersistenceEffect[]> {
  if (limit <= 0) return [];
  const rows = await engine.transactionDirect(async tx => {
    await declarePersistenceProtocol(tx);
    return tx.executeRaw<PersistenceEffect>(`WITH ready AS (SELECT e.id FROM persistence_effects e
      JOIN persistence_worktrees w ON w.id=e.worktree_id AND w.owner_host_id=$1::uuid
      WHERE e.worktree_id=$2::uuid AND e.kind='git' AND e.data ? 'relative_path'
      AND NOT (e.data ? 'targets') AND NOT (e.data ? 'source_scan') AND NOT (e.data ? 'version')
      AND (e.state='queued' OR e.state='running' AND e.claim_expires_at<now()) AND e.next_attempt_at<=now()
      AND e.recovery IS NULL AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror
        WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state<>'committed')
      ORDER BY e.next_attempt_at,e.id LIMIT $3 FOR UPDATE OF e SKIP LOCKED)
      UPDATE persistence_effects p SET state='running',execution_token=gen_random_uuid(),
      claim_expires_at=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
      FROM ready WHERE p.id=ready.id RETURNING p.*`, [hostId, worktreeId, limit]);
  });
  return rows.sort((a, b) => Number(a.id) - Number(b.id));
}

export async function renewPersistenceEffectClaim(engine: SqlEngine, effect: PersistenceEffect): Promise<boolean> {
  const rows = await engine.executeRaw(`UPDATE persistence_effects SET claim_expires_at=now()+interval '2 minutes',updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND state='running' AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`, [effect.id, effect.execution_token]);
  return rows.length === 1;
}

export async function advanceEffectCursor(engine: SqlEngine, effect: PersistenceEffect, slug: string): Promise<void> {
  const retrying = effect.data.retry_slugs ?? [];
  if (retrying.includes(slug)) {
    // A retried parked target finishes without moving the scan cursor. Each
    // remaining retried target keeps a single authorized attempt.
    const { retry_slugs: _retry, target_failures: _failures, failing_target: _target, ...data } = effect.data;
    const remaining = retrying.filter(candidate => candidate !== slug);
    await requeueEffect(engine, effect, remaining.length ? { ...data, retry_slugs: remaining, target_failures: PARK_AFTER_FAILURES - 1 } : data, null, 0);
    return;
  }
  await engine.executeRaw(`UPDATE persistence_effects SET state='queued',data=jsonb_set(
    CASE WHEN kind='embedding' THEN jsonb_set(data,'{embedding_attempt_base}',to_jsonb(attempts)) ELSE data-'target_failures'-'failing_target' END,'{after_slug}',to_jsonb($3::text)),
    execution_token=NULL,claim_expires_at=NULL,next_attempt_at=now(),error_code=NULL,
    updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}`, [effect.id, effect.execution_token, slug]);
}

/** An effect with parked targets finishes as failed (`targets_parked`), never as committed. */
export async function completeEffect(engine: SqlEngine, effect: PersistenceEffect, outcome: Record<string, unknown> = {}): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET
    state=CASE WHEN jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 THEN 'failed' ELSE 'committed' END,
    error_code=CASE WHEN jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 THEN 'targets_parked' END,
    data=data-'retry_slugs'-'target_failures'-'failing_target',execution_token=NULL,claim_expires_at=NULL,
    outcome=$3::text::jsonb,updated_at=now() WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}`,
  [effect.id, effect.execution_token, JSON.stringify(outcome)]);
}
export async function retryEffect(engine: SqlEngine, effect: PersistenceEffect, reason: string, delayMs = 1000): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,error_code=$3,
    next_attempt_at=now()+($4::double precision*interval '1 millisecond'),updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND ${PERSISTENCE_PROTOCOL_PREDICATE}`, [effect.id, effect.execution_token, reason, delayMs]);
}
/** Release a claim with replacement bookkeeping; parking never applies while recovery is recorded. */
export async function requeueEffect(engine: SqlEngine, effect: PersistenceEffect, data: PersistenceEffect['data'], reason: string | null, delayMs: number): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET state='queued',data=$3::text::jsonb,execution_token=NULL,claim_expires_at=NULL,error_code=$4,
    next_attempt_at=now()+($5::double precision*interval '1 millisecond'),updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}`,
  [effect.id, effect.execution_token, JSON.stringify(data), reason, delayMs]);
}
export async function parkEffect(engine: SqlEngine, effect: PersistenceEffect, data: PersistenceEffect['data']): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET state='failed',data=$3::text::jsonb,execution_token=NULL,claim_expires_at=NULL,
    error_code='targets_parked',updated_at=now() WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}`,
  [effect.id, effect.execution_token, JSON.stringify(data)]);
}
export async function failEffect(engine: SqlEngine, effect: PersistenceEffect, reason: string): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET state='failed',execution_token=NULL,claim_expires_at=NULL,error_code=$3,updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}`, [effect.id, effect.execution_token, reason]);
}

/** Only public kind/state/reason, aggregated so withdrawal page counts cannot leak. */
export async function publicEffectsForRequest(engine: SqlEngine, requestId: string): Promise<Array<{ kind: EffectKind; state: string; reason?: string; push?: string }>> {
  const rows = await engine.executeRaw<{ kind: EffectKind; state: string; error_code: string | null; recovering: boolean; outcome: Record<string, unknown> | null }>(
    'SELECT kind,state,error_code,outcome,recovery IS NOT NULL AS recovering FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind', [requestId]);
  return rows.filter(row => ['git', 'embedding', 'withdrawal-mirror', 'facts-backstop'].includes(row.kind)).map(row => {
    const reason = row.error_code ?? row.outcome?.reason;
    const push = row.outcome?.push;
    return { kind: row.kind, state: row.recovering ? 'recovering' : row.outcome?.git === 'skipped' || row.outcome?.facts === 'skipped' || row.outcome?.embedding === 'skipped' ? 'skipped'
      : row.outcome?.facts === 'queued' ? 'dispatched' : row.state,
      ...(typeof reason === 'string' && /^[a-z_]{1,80}$/.test(reason) ? { reason } : {}),
      ...(row.kind === 'git' && (push === 'committed' || push === 'skipped') ? { push } : {}),
    };
  });
}
