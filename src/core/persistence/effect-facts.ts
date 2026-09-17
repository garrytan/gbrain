import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import { isFactsBackstopEligible } from '../facts/eligibility.ts';
import { isFactsExtractionEnabled } from '../facts/extract.ts';
import { MinionQueue } from '../minions/queue.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeStoredRequest, authorizeWrite } from './authority.ts';
import { completeEffect } from './effect-journal.ts';
import { guardEffectSource } from './effect-recovery.ts';
import type { PersistenceEffect } from './effect-model.ts';
import type { WriteRequest } from './model.ts';

export type FactsBackstopStatus = { queued: true } | { skipped: string };

async function authorizeFactsBackstop(engine: BrainEngine, row: WriteRequest, lock = false): Promise<void> {
  if (row.authority.restrictedNamespace || row.authority.delegated || row.authority.slugPrefixes != null) {
    throw new OperationError('permission_denied', 'A confined writer cannot extract into unnamed entity pages.');
  }
  await authorizeStoredRequest(engine, row, lock);
  await authorizeWrite(engine, row.authority, 'extract_facts', row.slug, lock);
  // A grant may have become confined while the page itself remains in scope.
  if (row.principal_kind === 'oauth_client') {
    const [current] = await engine.executeRaw<{ bound_slug_prefixes: unknown }>('SELECT bound_slug_prefixes FROM oauth_clients WHERE client_id=$1', [row.principal_id]);
    if (current?.bound_slug_prefixes != null) throw new OperationError('permission_denied', 'The current writer grant is confined.');
  } else if (row.principal_kind === 'local_cli' || row.principal_kind === 'local_stdio') {
    const [current] = await engine.executeRaw<{ prefixes: unknown }>("SELECT grant_ceiling->'slugPrefixes' AS prefixes FROM persistence_local_writers WHERE id=$1::uuid", [row.principal_id]);
    if (current?.prefixes != null) throw new OperationError('permission_denied', 'The current writer grant is confined.');
  }
}

/** Provider availability belongs to the durable job's execution process. */
export async function prepareFactsBackstop(engine: BrainEngine, row: WriteRequest, page: ParsedPage): Promise<FactsBackstopStatus> {
  if (row.authority.restrictedNamespace || row.authority.delegated || row.authority.slugPrefixes != null) return { skipped: 'slug_bound_client' };
  if (row.authority.operations != null && !row.authority.operations.includes('extract_facts')) return { skipped: 'operation_bound_client' };
  if (!(await isFactsExtractionEnabled(engine))) return { skipped: 'extraction_disabled' };
  const eligible = isFactsBackstopEligible(row.slug, page);
  if (!eligible.ok) return { skipped: eligible.reason };
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  return brain?.enabled ? { skipped: 'writer_coordinator_required' } : { queued: true };
}

/** Optional fence on new durable jobs; old jobs retain their established input contract. */
export async function readFactsBackstopJobPage(engine: BrainEngine, data: Record<string, unknown>) {
  const slug = typeof data.slug === 'string' ? data.slug : '';
  const sourceId = typeof data.sourceId === 'string' ? data.sourceId : 'default';
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (brain?.enabled) return { skipped: 'writer_coordinator_required' } as const;
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) return { skipped: 'page_missing' } as const;
  if (data.persistence_request_id !== undefined) {
    if (typeof data.persistence_request_id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.persistence_request_id)) return { skipped: 'invalid_write_request' } as const;
    const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [data.persistence_request_id]);
    if (!row || row.state !== 'committed' || row.slug !== slug || row.source_id !== sourceId
      || row.source_incarnation !== snapshot.sourceIncarnation || snapshot.page.id !== data.page_id
      || snapshot.revision !== data.revision) return { skipped: 'superseded' } as const;
    try { await authorizeFactsBackstop(engine, row); }
    catch (error) {
      if (error instanceof OperationError && ['permission_denied', 'source_changed'].includes(error.code)) return { skipped: error.code } as const;
      throw error;
    }
  }
  return { page: snapshot.page };
}

/** Job insertion and outbox completion commit together; losing their ACK cannot create another job. */
export async function dispatchFactsBackstopEffect(engine: BrainEngine, effect: PersistenceEffect, hostId: string): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    const [brain] = await tx.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1 FOR SHARE');
    await guardEffectSource(tx, effect, hostId);
    const [row] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [effect.request_id]);
    let skipped: string | undefined = brain?.enabled ? 'writer_coordinator_required' : undefined;
    if (!row || row.state !== 'committed') skipped = 'invalid_write_request';
    if (row && !skipped) {
      try { await authorizeFactsBackstop(tx, row, true); }
      catch (error) {
        if (error instanceof OperationError && ['permission_denied', 'source_changed'].includes(error.code)) skipped = error.code;
        else throw error;
      }
    }
    if (effect.data.slug) await tx.lockPageKeys([{ sourceId: effect.source_id, slug: effect.data.slug }]);
    const [current] = await tx.executeRaw<PersistenceEffect>('SELECT * FROM persistence_effects WHERE id=$1 FOR UPDATE', [effect.id]);
    if (!current || current.state !== 'running' || current.execution_token !== effect.execution_token) return;
    const snapshot = effect.data.slug ? await tx.readPageSnapshot(effect.data.slug, { sourceId: effect.source_id }) : null;
    if (!snapshot || snapshot.page.id !== effect.data.page_id || snapshot.revision !== effect.revision) skipped ??= 'superseded';
    if (!(await isFactsExtractionEnabled(tx))) skipped ??= 'extraction_disabled';
    if (skipped) { await completeEffect(tx, effect, { facts: 'skipped', reason: skipped }); return; }
    const job = await new MinionQueue(tx).add('facts-absorb', {
      slug: effect.data.slug, sourceId: effect.source_id, source: 'mcp:put_page', notabilityFilter: 'all',
      visibility: effect.data.visibility === 'world' ? 'world' : 'private',
      persistence_request_id: effect.request_id, page_id: effect.data.page_id, revision: effect.revision,
    }, { queue: 'default', idempotency_key: `facts-absorb:write:${effect.request_id}`, max_attempts: 5, backoff_delay: 60_000 });
    await completeEffect(tx, effect, { facts: 'queued', job_id: job.id });
  });
}
