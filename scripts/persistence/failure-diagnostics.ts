import type { BrainEngine } from '../../src/core/engine.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';

export const DIAGNOSTIC_BUDGET_MS = 2_000;
export type DiagnosticResult<T> = { status: 'ok'; value: T } | { status: 'timeout' } | { status: 'error'; code: string };
export function diagnosticCode(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(value) ? value : null;
}
export function diagnosticError(error: unknown): string {
  return diagnosticCode((error as { code?: unknown } | null)?.code) ?? 'diagnostic_error';
}
/** A stalled diagnostic must never extend the original gate or hide its failure. */
export async function boundedDiagnostic<T>(task: () => Promise<T>, milliseconds = DIAGNOSTIC_BUDGET_MS): Promise<DiagnosticResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(task).then(value => ({ status: 'ok' as const, value }), error => ({ status: 'error' as const, code: diagnosticError(error) })),
      new Promise<{ status: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : null;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const decimal = (value: unknown) => /^\d+$/.test(String(value)) ? String(value) : null;
function timestamp(value: unknown): string | null {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
/** Explicit allowlist: no intent, body, path, authority, tokens or error messages. */
export function receiptDiagnostic(row: Partial<WriteRequest> | null) {
  if (!row) return null;
  return { id: uuid(row.id), request_id: uuid(row.request_id), worktree_id: uuid(row.worktree_id),
    sequence: decimal(row.sequence), state: diagnosticCode(row.state), error_code: diagnosticCode(row.error_code),
    blocked_reason: diagnosticCode(row.blocked_reason), created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
    completed_at: timestamp(row.completed_at), claim_expires_at: timestamp(row.claim_expires_at),
    publication_started: row.publication_started === true, has_recovery: row.recovery != null,
    recovery_bytes: decimal(row.recovery_bytes), intent_bytes: decimal(row.intent_bytes) };
}
export interface ActiveSoakRequest { requestId: string; index: number; startedAt: number; receipt: Partial<WriteRequest> | null; }
export function soakFailureDiagnostic(principal: number, completed: number, active: Iterable<ActiveSoakRequest>) {
  return { at: new Date().toISOString(), principal, completed, active: [...active].slice(0, 4).map(row => ({
    request_id: uuid(row.requestId), index: row.index, elapsed_ms: Math.max(0, performance.now() - row.startedAt), receipt: receiptDiagnostic(row.receipt),
  })) };
}
/** Only computed counts, UUIDs and states leave the synthetic owner. SQL never selects content or paths. */
export async function ownerDatabaseDiagnostic(engine: Pick<BrainEngine, 'executeRaw'>) {
  const [row] = await engine.executeRaw<{ queue: Record<string, unknown>[]; roots: Record<string, unknown>[]; counters: Record<string, unknown> | null }>(`
    WITH pending AS (SELECT worktree_id,state,blocked_reason,created_at FROM persistence_requests
      WHERE state IN ('queued','running','recovering'))
    SELECT COALESCE((SELECT jsonb_agg(q) FROM (SELECT state,blocked_reason,count(*)::text AS count,
      EXTRACT(EPOCH FROM now()-min(created_at))*1000 AS oldest_ms FROM pending GROUP BY state,blocked_reason
      ORDER BY state,blocked_reason LIMIT 32) q),'[]'::jsonb) AS queue,
    COALESCE((SELECT jsonb_agg(w) FROM (SELECT id,owner_host_id,owner_epoch::text,state,heartbeat_at,
      (SELECT count(*)::text FROM pending p WHERE p.worktree_id=worktrees.id) AS pending
      FROM persistence_worktrees worktrees ORDER BY id LIMIT 16) w),'[]'::jsonb) AS roots,
    (SELECT jsonb_build_object('outstanding_count',outstanding_count::text,'intent_bytes',intent_bytes::text,
      'recovery_bytes',recovery_bytes::text,'lifetime_ids',lifetime_ids::text) FROM persistence_counters WHERE key='brain') AS counters`);
  return { queue: (row?.queue ?? []).map(q => ({ state: diagnosticCode(q.state), blocked_reason: diagnosticCode(q.blocked_reason),
    count: decimal(q.count), oldest_ms: number(Number(q.oldest_ms)) })),
  roots: (row?.roots ?? []).map(r => ({ id: uuid(r.id), owner_host_id: uuid(r.owner_host_id), owner_epoch: decimal(r.owner_epoch),
    state: diagnosticCode(r.state), heartbeat_at: timestamp(r.heartbeat_at), pending: decimal(r.pending) })),
  counters: row?.counters ? Object.fromEntries(['outstanding_count', 'intent_bytes', 'recovery_bytes', 'lifetime_ids']
    .map(key => [key, decimal(row.counters![key])])) : null };
}

export function retentionMetadata(scratch: string, databases: string[]) {
  // Only names created by this harness can appear in an executable cleanup command.
  if (!databases.every(name => /^gbrain_persistence_test_[0-9a-f]{32}$/.test(name))) throw new Error('Invalid retained fixture database name');
  return { version: 1, scratch_root: scratch, databases,
    cleanup: { instruction: 'After inspection and after all listed worker processes have stopped, remove only these retained synthetic fixtures. Keep config.json private; it contains the test connection URL.',
      database_commands: databases.map(name => `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS "${name}" WITH (FORCE)'`),
      remove_scratch_argv: ['rm', '-rf', '--', scratch] } };
}
