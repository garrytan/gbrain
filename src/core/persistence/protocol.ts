import type { SqlEngine, WriteRequest } from './model.ts';
import { OperationError } from '../ops/contract.ts';

export async function declarePersistenceProtocol(tx: SqlEngine): Promise<void> {
  await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
}

export const PERSISTENCE_PROTOCOL_PREDICATE = "set_config('gbrain.persistence_protocol','2',true)='2'";

export function assertMutationProtocol(row: Pick<WriteRequest, 'target_kind' | 'protocol_version'>): void {
  if (((row.target_kind ?? 'page') === 'page' && (row.protocol_version ?? 1) === 1)
    || (row.target_kind === 'skill_bundle' && row.protocol_version === 2)) return;
  throw new OperationError('unsupported_mutation_protocol', 'This consumer does not support the request target and protocol version.');
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
