/**
 * A deliberately narrow view of the recovery record that blocks a connector.
 *
 * `connector-sync.ts` has to read the oldest recovery record so that the
 * consumer can resume it.  The operator needs to know only whether that head
 * is safe to investigate; it must not receive the record's JSON payload,
 * intent bytes, slugs, paths, or another principal's receipt metadata.
 */
import type { BrainEngine } from '../engine.ts';
import { currentVerifiedLocalWriter, existingLocalHostId, readLocalWriter } from './identity.ts';

const ALLOWED_OPERATIONS = [
  'put_page', 'put_pages', 'capture', 'delete_page', 'restore_page', 'revert_version', 'edit_page', 'append_page',
  'remember', 'forget', 'extract_facts', 'put_skill', 'delete_skill', 'import_skill_proposal',
  'add_tag', 'remove_tag', 'add_timeline_entry', 'takes_add', 'takes_update', 'takes_supersede', 'takes_resolve', 'takes_remove', 'takes_rebuild',
  'submit_job', 'connector_v2_checkpoint', 'connector_v2_import', 'connector_v2_delete', 'connector_v2_google_receipts',
] as const;
const ALLOWED_STATES = ['queued', 'running', 'recovering', 'committed', 'conflict', 'failed', 'cancelled'] as const;
const ALLOWED_BLOCKED_REASONS = ['unexpected_staging_bytes', 'unexpected_file_bytes', 'database_unavailable', 'preparation_deadline', 'preparation_stalled', 'write_interrupted', 'publication_deadline', 'claim_lost'] as const;

interface BindingRow {
  source_incarnation: string;
  binding_incarnation: string | null;
  worktree_id: string | null;
  owner_host_id: string | null;
}
interface RecoveryRow {
  owned: boolean;
  fields_valid: boolean;
  request_id: string | null;
  sequence: string | null;
  operation: string | null;
  state: string | null;
  blocked_reason: string | null;
}

const BINDING_SQL = `SELECT s.incarnation::text AS source_incarnation,
  b.source_incarnation::text AS binding_incarnation,b.worktree_id::text AS worktree_id,
  w.owner_host_id::text AS owner_host_id
FROM sources s
LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
LEFT JOIN persistence_worktrees w ON w.id=b.worktree_id
WHERE s.id=$1 AND s.archived IS NOT TRUE`;

function sameBinding(left: BindingRow | undefined, right: BindingRow | undefined): boolean {
  return left?.source_incarnation === right?.source_incarnation
    && left?.binding_incarnation === right?.binding_incarnation
    && left?.worktree_id === right?.worktree_id
    && left?.owner_host_id === right?.owner_host_id;
}
function unavailable(sourceId: string, reason: string, worktreeBound = false): Record<string, unknown> {
  return { status: 'unavailable', source_id: sourceId, worktree_bound: worktreeBound, reason };
}
function permissionDenied(sourceId: string, reason: string, worktreeBound = false): Record<string, unknown> {
  return { status: 'permission_denied', source_id: sourceId, worktree_bound: worktreeBound, reason };
}
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Reads one validated projection for the current source binding.  This code
 * intentionally does not import connector-sync, writer status, or repair:
 * all three can start consumers, clean markers, or inspect record bodies.
 */
export async function readRecoveryHead(engine: BrainEngine, sourceId: string): Promise<Record<string, unknown>> {
  const hostId = existingLocalHostId();
  const caller = currentVerifiedLocalWriter();
  if (!hostId || caller?.remote || (caller !== undefined && caller.principal.kind !== 'local_cli')) {
    return permissionDenied(sourceId, 'host_admin_required');
  }
  try {
    return await engine.transaction(async tx => {
      await tx.executeRaw('SET TRANSACTION READ ONLY');
      if (engine.kind === 'postgres') {
        await tx.executeRaw("SET LOCAL statement_timeout = '5s'");
        await tx.executeRaw("SET LOCAL lock_timeout = '2s'");
      }
      const [binding] = await tx.executeRaw<BindingRow>(BINDING_SQL, [sourceId]);
      if (!binding) return unavailable(sourceId, 'source_not_active');
      if (!binding.worktree_id || !binding.owner_host_id || !binding.binding_incarnation) return unavailable(sourceId, 'source_unbound');
      if (binding.owner_host_id !== hostId) return permissionDenied(sourceId, 'owner_not_this_host', true);

      let local;
      try { local = await readLocalWriter(tx, 'cli'); }
      catch (error) {
        const code = errorCode(error);
        return code === 'permission_denied' || code === 'writer_registration_required'
          ? permissionDenied(sourceId, 'writer_unregistered', true)
          : unavailable(sourceId, 'writer_unavailable', true);
      }
      if (caller && caller.principal.id !== local.id) return permissionDenied(sourceId, 'caller_mismatch', true);

      const [head] = await tx.executeRaw<RecoveryRow>(`SELECT
        (r.source_id=$2 AND r.source_incarnation::text=$3 AND r.principal_kind=$4 AND r.principal_id=$5) AS owned,
        (r.operation=ANY($6::text[]) AND r.state=ANY($7::text[]) AND
          (r.blocked_reason IS NULL OR r.blocked_reason=ANY($8::text[]))) AS fields_valid,
        CASE WHEN r.source_id=$2 AND r.source_incarnation::text=$3 AND r.principal_kind=$4 AND r.principal_id=$5
          AND r.operation=ANY($6::text[]) AND r.state=ANY($7::text[])
          AND (r.blocked_reason IS NULL OR r.blocked_reason=ANY($8::text[])) THEN r.request_id::text ELSE NULL END AS request_id,
        CASE WHEN r.source_id=$2 AND r.source_incarnation::text=$3 AND r.principal_kind=$4 AND r.principal_id=$5
          AND r.operation=ANY($6::text[]) AND r.state=ANY($7::text[])
          AND (r.blocked_reason IS NULL OR r.blocked_reason=ANY($8::text[])) THEN r.sequence::text ELSE NULL END AS sequence,
        CASE WHEN r.source_id=$2 AND r.source_incarnation::text=$3 AND r.principal_kind=$4 AND r.principal_id=$5
          AND r.operation=ANY($6::text[]) AND r.state=ANY($7::text[])
          AND (r.blocked_reason IS NULL OR r.blocked_reason=ANY($8::text[])) THEN r.operation ELSE NULL END AS operation,
        CASE WHEN r.source_id=$2 AND r.source_incarnation::text=$3 AND r.principal_kind=$4 AND r.principal_id=$5
          AND r.operation=ANY($6::text[]) AND r.state=ANY($7::text[])
          AND (r.blocked_reason IS NULL OR r.blocked_reason=ANY($8::text[])) THEN r.state ELSE NULL END AS state,
        CASE WHEN r.source_id=$2 AND r.source_incarnation::text=$3 AND r.principal_kind=$4 AND r.principal_id=$5
          AND r.operation=ANY($6::text[]) AND r.state=ANY($7::text[])
          AND (r.blocked_reason IS NULL OR r.blocked_reason=ANY($8::text[])) THEN r.blocked_reason ELSE NULL END AS blocked_reason
      FROM persistence_requests r
      WHERE r.worktree_id=$1::uuid AND r.recovery IS NOT NULL
      ORDER BY r.sequence ASC LIMIT 1`, [binding.worktree_id, sourceId, binding.source_incarnation, 'local_cli', local.id,
        [...ALLOWED_OPERATIONS], [...ALLOWED_STATES], [...ALLOWED_BLOCKED_REASONS]]);

      const [after] = await tx.executeRaw<BindingRow>(BINDING_SQL, [sourceId]);
      if (!sameBinding(binding, after)) return unavailable(sourceId, 'binding_changed', Boolean(after?.worktree_id));
      if (!head) return { status: 'none', source_id: sourceId, worktree_bound: true };
      if (!head.owned) return unavailable(sourceId, 'recovery_head_not_owned', true);
      if (!head.fields_valid || !head.request_id || !head.sequence || !head.operation || !head.state) {
        return unavailable(sourceId, 'field_unvalidated', true);
      }
      return { status: 'present', source_id: sourceId, worktree_bound: true, request_id: head.request_id,
        sequence: head.sequence, operation: head.operation, state: head.state, recovery: true, blocked_reason: head.blocked_reason };
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === '57014' || code === '55P03') return unavailable(sourceId, 'timeout');
    return unavailable(sourceId, 'read_failed');
  }
}
