import { randomUUID } from 'node:crypto';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import type { PreparedMutation } from './coordinator.ts';
import { sha256 } from './digest.ts';
import type { EffectKind, PersistenceEffect, EffectRequest } from './effect-model.ts';
import type { SqlEngine } from './model.ts';
import { isFactsExtractionEnabled } from '../facts/extract.ts';
import { resolveDefaultVisibility } from '../facts/visibility.ts';

export async function queuePublicationEffects(tx: BrainEngine, row: EffectRequest, revision: string | undefined,
  outcome: Record<string, unknown>, prepared?: PreparedMutation): Promise<void> {
  if (prepared?.noop) return;
  const snapshot = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
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
    await queue('embedding');
    outcome.embedding_state = 'queued';
    if ((outcome.facts_backstop as { queued?: boolean } | undefined)?.queued) {
      // Recheck activation/kill switch at publication, before promising work.
      const [brain] = await tx.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
      if (brain?.enabled) outcome.facts_backstop = { skipped: 'writer_coordinator_required' };
      else if (!(await isFactsExtractionEnabled(tx))) outcome.facts_backstop = { skipped: 'extraction_disabled' };
      else await queue('facts-backstop', { visibility: await resolveDefaultVisibility(tx) });
    }
  }
}

/** Claims release their database connection before waiting for a filesystem lock/provider. */
export async function claimPersistenceEffect(engine: BrainEngine, hostId: string): Promise<PersistenceEffect | null> {
  return engine.transactionDirect(async tx => {
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

export async function advanceEffectCursor(engine: SqlEngine, effect: PersistenceEffect, slug: string): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET state='queued',data=jsonb_set(data,'{after_slug}',to_jsonb($3::text)),
    execution_token=NULL,claim_expires_at=NULL,next_attempt_at=now(),error_code=NULL,updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL`, [effect.id, effect.execution_token, slug]);
}

export async function completeEffect(engine: SqlEngine, effect: PersistenceEffect, outcome: Record<string, unknown> = {}): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET state='committed',execution_token=NULL,claim_expires_at=NULL,error_code=NULL,
    outcome=$3::text::jsonb,updated_at=now() WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL`,
  [effect.id, effect.execution_token, JSON.stringify(outcome)]);
}
export async function retryEffect(engine: SqlEngine, effect: PersistenceEffect, reason: string, delayMs = 1000): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,error_code=$3,
    next_attempt_at=now()+($4::double precision*interval '1 millisecond'),updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid`, [effect.id, effect.execution_token, reason, delayMs]);
}
export async function failEffect(engine: SqlEngine, effect: PersistenceEffect, reason: string): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET state='failed',execution_token=NULL,claim_expires_at=NULL,error_code=$3,updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL`, [effect.id, effect.execution_token, reason]);
}

/** Only public kind/state/reason, aggregated so withdrawal page counts cannot leak. */
export async function publicEffectsForRequest(engine: SqlEngine, requestId: string): Promise<Array<{ kind: EffectKind; state: string; reason?: string; push?: string }>> {
  const rows = await engine.executeRaw<{ kind: EffectKind; state: string; error_code: string | null; recovering: boolean; outcome: Record<string, unknown> | null }>(
    'SELECT kind,state,error_code,outcome,recovery IS NOT NULL AS recovering FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind', [requestId]);
  return rows.filter(row => ['git', 'embedding', 'withdrawal-mirror', 'facts-backstop'].includes(row.kind)).map(row => {
    const reason = row.error_code ?? row.outcome?.reason;
    const push = row.outcome?.push;
    return { kind: row.kind, state: row.recovering ? 'recovering' : row.outcome?.git === 'skipped' || row.outcome?.facts === 'skipped' ? 'skipped'
      : row.outcome?.facts === 'queued' ? 'dispatched' : row.state,
      ...(typeof reason === 'string' && /^[a-z_]{1,80}$/.test(reason) ? { reason } : {}),
      ...(row.kind === 'git' && (push === 'committed' || push === 'skipped') ? { push } : {}),
    };
  });
}
