import type { SqlEngine, WriteRequest } from './model.ts';
import { opError, OperationError } from '../ops/contract.ts';

const declared = new WeakSet<object>();
/**
 * Global persistence lock order: the `persistence_brain` row, then worktree
 * rows (id order), then source rows (id order), then counters, requests and
 * page keys. The request and effect protocol triggers read the brain row
 * FOR SHARE, and worktree claims and topology changes lock it FOR UPDATE
 * before their worktrees, sources and counters. A transaction that locked a
 * source or counter row before its first request or effect write would wait
 * for the brain row while holding what the topology change waits for, so
 * every protocol declaration takes the brain row FOR SHARE first, in the same
 * statement as its settings (a missing row still declares). Declare before
 * any other row lock. A transaction needing the exclusive brain lock takes it
 * first and declares after it.
 */
const BRAIN_SHARE = '(SELECT brain_id::text FROM persistence_brain WHERE singleton=1 FOR SHARE) AS brain';

/** Transaction-local; #5984: a transaction engine declares it once (a savepoint is its own engine object). */
export async function declarePersistenceProtocol(tx: SqlEngine): Promise<void> {
  const inTransaction = (tx as { _pageTransaction?: boolean })._pageTransaction === true;
  if (inTransaction && declared.has(tx)) return;
  await tx.executeRaw(`SELECT set_config('gbrain.persistence_protocol','2',true),${BRAIN_SHARE}`);
  if (inTransaction) declared.add(tx);
}

/**
 * #6007: the protocol declaration plus the durable-write settings (synchronous
 * commit, lock and statement timeouts) in one round trip, then the brain row
 * under that lock timeout. Later `declarePersistenceProtocol` calls on the
 * same transaction engine are free.
 */
/** Returns the brain id read under that lock (null when the row is missing). */
export async function declareDurablePersistence(tx: SqlEngine, lockTimeout = '1s', statementTimeout = '5s'): Promise<string | null> {
  const [row] = await tx.executeRaw<{ brain: string | null }>(`SELECT set_config('gbrain.persistence_protocol','2',true),set_config('synchronous_commit','on',true),
    set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true),${BRAIN_SHARE}`, [lockTimeout, statementTimeout]);
  if ((tx as { _pageTransaction?: boolean })._pageTransaction === true) declared.add(tx);
  return row?.brain ?? null;
}

export const PERSISTENCE_PROTOCOL_PREDICATE = "set_config('gbrain.persistence_protocol','2',true)='2'";

export function assertMutationProtocol(row: Pick<WriteRequest, 'target_kind' | 'protocol_version'>): void {
  if (((row.target_kind ?? 'page') === 'page' && (row.protocol_version ?? 1) === 1)
    || (row.target_kind === 'skill_bundle' && row.protocol_version === 2)) return;
  throw opError('unsupported_mutation_protocol', 'This consumer does not support the request target and protocol version.',
    `This gbrain process cannot apply ${row.target_kind ?? 'page'} requests at protocol ${row.protocol_version ?? 1}, so it left the request untouched. A newer gbrain wrote it: upgrading gbrain on this host (the user's call) lets it be applied.`);
}

export async function assertSharedSkillPersistence(engine: SqlEngine, sourceId?: string): Promise<void> {
  const [brain] = await engine.executeRaw<{ enabled: boolean; skill_bundles_enabled: boolean; writer_protocol_floor: number }>(
    'SELECT enabled,skill_bundles_enabled,writer_protocol_floor FROM persistence_brain WHERE singleton=1');
  if (!brain?.enabled || !brain.skill_bundles_enabled || brain.writer_protocol_floor !== 2) {
    throw new OperationError('writer_not_quiesced', 'Shared skill publication requires an activated protocol-2 canonical owner.',
      'Stop older writers and direct-file skill servers, then activate shared skill persistence on the canonical host.');
  }
  if (sourceId !== undefined) {
    const owners = await engine.executeRaw(`SELECT w.id FROM sources s JOIN persistence_source_bindings b
      ON b.source_id=s.id AND b.source_incarnation=s.incarnation JOIN persistence_worktrees w ON w.id=b.worktree_id
      JOIN persistence_writer_protocols p ON p.worktree_id=w.id AND p.host_id=w.owner_host_id AND p.owner_epoch=w.owner_epoch
      WHERE s.id=$1 AND NOT s.archived AND w.state='active' AND p.protocol_version=2`, [sourceId]);
    if (!owners.length) throw new OperationError('writer_not_quiesced', 'The canonical owner capability changed after shared publication was activated.',
      'Drain or cancel pending requests and revalidate the canonical owner before activating shared publication again.');
  }
}
