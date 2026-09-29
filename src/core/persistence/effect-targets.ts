import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { discoverWithdrawalTargets, withdrawalDiscoveryFailure, WITHDRAWAL_LIMITS, type WithdrawalClaim } from '../facts/withdrawal-discovery.ts';
import type { PersistenceEffect } from './effect-model.ts';
import { guardEffectSource } from './effect-recovery.ts';

export function targetedWithdrawalEffect(effect: PersistenceEffect): boolean {
  if (effect.data.version === undefined) return false;
  const targets = effect.data.targets;
  if (effect.data.version !== 2 || !Array.isArray(targets) || targets.length > WITHDRAWAL_LIMITS.targets || Buffer.byteLength(JSON.stringify(targets)) > WITHDRAWAL_LIMITS.targetBytes ||
    targets.some((target, index) => !target || typeof target.slug !== 'string' || !target.slug || !Number.isSafeInteger(target.page_id) || target.page_id <= 0 ||
      typeof target.revision !== 'string' || !/^[0-9a-f-]{36}$/i.test(target.revision) || index > 0 && targets[index - 1].slug >= target.slug)) {
    throw new OperationError('withdrawal_provenance', 'The withdrawal target manifest is invalid. Durable intent remains pending.',
      'Keep older mutation workers stopped and inspect the retained receipt on the host. Do not reset its cursor. See docs/guides/concurrent-writes.md#withdrawal-recovery.');
  }
  return true;
}

export async function upgradeWithdrawalEffect(engine: BrainEngine, effect: PersistenceEffect, hostId: string, persist = true): Promise<PersistenceEffect> {
  if (targetedWithdrawalEffect(effect) || !effect.data.source_scan && effect.kind !== 'withdrawal-mirror') return effect;
  if (effect.kind !== 'withdrawal-mirror') {
    const withdrawal = await engine.executeRaw(`SELECT r.id FROM persistence_requests r WHERE r.id=$1::uuid
      AND (r.operation IN ('forget','forget_fact') OR EXISTS (SELECT 1 FROM persistence_effects m WHERE m.request_id=r.id AND m.kind='withdrawal-mirror'))`, [effect.request_id]);
    if (!withdrawal.length) return effect;
  }
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    if (effect.worktree_id) await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [effect.worktree_id]);
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [effect.source_id]);
    await guardEffectSource(tx, effect, hostId);
    // Key discovery on the request's own forgotten fact; fall back to the
    // whole ledger only when that fact row no longer exists.
    const requested = await tx.executeRaw<WithdrawalClaim>(`SELECT w.visibility,w.fact_hash,w.subject,f.fact AS claim
      FROM persistence_requests r JOIN facts f ON r.intent->>'id' ~ '^[0-9]+$' AND f.id=(r.intent->>'id')::bigint AND f.source_id=$1
      JOIN fact_withdrawals w ON w.source_id=f.source_id AND w.visibility=f.visibility
        AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact),gbrain_fact_fingerprint_v1(f.fact))
        AND (w.subject='*' OR w.subject=COALESCE(f.entity_slug,'*'))
      WHERE r.id=$2::uuid ORDER BY w.visibility,w.fact_hash,w.subject`, [effect.source_id, effect.request_id]);
    const claims = requested.length ? requested : await tx.executeRaw<WithdrawalClaim>(`SELECT visibility,fact_hash,subject FROM fact_withdrawals
      WHERE source_id=$1 ORDER BY visibility,fact_hash,subject LIMIT $2`, [effect.source_id, WITHDRAWAL_LIMITS.targets + 1]);
    if (!claims.length) throw new OperationError('withdrawal_provenance', 'Legacy withdrawal intent has no verifiable ledger. Its queued work remains retained.');
    const discovered = await discoverWithdrawalTargets(tx, effect.source_id, claims).catch(withdrawalDiscoveryFailure);
    const remaining = await tx.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id=$1 AND id=ANY($2::int[])
      AND ($3::text IS NULL OR slug>$3)`, [effect.source_id, discovered.map(target => target.page_id), effect.data.after_slug ?? null]);
    const ids = new Set(remaining.map(row => row.id));
    const targets = discovered.filter(target => ids.has(target.page_id));
    const { source_scan, after_slug, ...retained } = effect.data;
    const data = { ...retained, version: 2 as const, targets, legacy_after_slug: after_slug ?? null };
    if (!persist) return { ...effect, data };
    const [current] = await tx.executeRaw<PersistenceEffect>(`UPDATE persistence_effects SET data=(data-'source_scan'-'after_slug')||$3::text::jsonb,updated_at=now()
      WHERE id=$1 AND execution_token IS NOT DISTINCT FROM $2::uuid AND recovery IS NULL RETURNING *`,
      [effect.id, effect.execution_token, JSON.stringify(data)]);
    if (!current) throw new OperationError('write_claim_lost', 'The legacy withdrawal effect changed during discovery.');
    return current;
  });
}
