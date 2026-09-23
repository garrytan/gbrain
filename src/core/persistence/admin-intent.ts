import type { SqlEngine } from './model.ts';
import { OperationError } from '../ops/contract.ts';
import { sha256 } from './digest.ts';

export const WRITER_INSPECTION_HINT = 'Inspect gbrain sources writer status --json on the selected brain host first to identify the designated owner and any recovery. Routine repair must not claim, activate, or transfer ownership. Ask the operator to review docs/architecture/topologies.md before a deliberate topology change.';

export async function writerAdminState(engine: SqlEngine): Promise<string> {
  const [row] = await engine.executeRaw<{ state: string }>(`SELECT jsonb_build_object(
    'brain', (SELECT jsonb_build_object('id',brain_id,'enabled',enabled) FROM persistence_brain WHERE singleton=1),
    'sources', (SELECT jsonb_agg(jsonb_build_array(id,incarnation,archived,local_path) ORDER BY id) FROM sources),
    'fallback', (SELECT value FROM config WHERE key='sync.repo_path'),
    'worktrees', (SELECT jsonb_agg(jsonb_build_array(id,owner_host_id,owner_epoch::text,topology_generation::text,state,manifest) ORDER BY id) FROM persistence_worktrees),
    'bindings', (SELECT jsonb_agg(jsonb_build_array(source_id,source_incarnation,worktree_id,relative_path,topology_generation::text) ORDER BY source_id) FROM persistence_source_bindings),
    'hosts', (SELECT jsonb_agg(jsonb_build_array(worktree_id,host_id,local_path,coordination_path) ORDER BY worktree_id,host_id) FROM persistence_host_bindings)
  )::text AS state`);
  return sha256(row.state);
}

export async function assertWriterAdminState(engine: SqlEngine, expected: string | undefined, lock = true): Promise<void> {
  if (expected === undefined) return;
  if (lock) {
    await engine.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    await engine.executeRaw('LOCK TABLE sources, config, persistence_worktrees, persistence_source_bindings, persistence_host_bindings IN SHARE ROW EXCLUSIVE MODE');
  }
  if (await writerAdminState(engine) !== expected) {
    throw new OperationError('writer_admin_state_changed', 'Writer topology changed since inspection; the administrative request was not applied.', WRITER_INSPECTION_HINT);
  }
}

export async function requireWriterAdminIntent(engine: SqlEngine, operation: string, params: Record<string, unknown>): Promise<string | undefined> {
  if (params.dry_run === true) return;
  if (params.admin_intent !== operation || typeof params.expected_state !== 'string' || !/^[a-f0-9]{64}$/.test(params.expected_state)) {
    throw new OperationError('writer_admin_intent_required', 'Topology changes require an action-specific --admin-intent and the --expected-state from a reviewed writer status. A TTY, --yes, or --confirm-quiesced alone is not authorization.', WRITER_INSPECTION_HINT);
  }
  await assertWriterAdminState(engine, params.expected_state, false);
  return params.expected_state;
}
