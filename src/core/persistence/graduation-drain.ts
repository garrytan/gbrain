/**
 * Engine graduation drain: under the PGLite kernel lock, queued, running and
 * recovering requests this host owns are published to terminal states by a
 * request-only consumer (no effect, projection, topology or maintenance
 * workers), bounded by `--drain-timeout`, behind the consumer's stop barrier.
 * Effects, connector holds and leases are carried or classified, never waited
 * on. After the drain the source is frozen read-only for the copy.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { PersistenceConsumer } from './consumer.ts';
import { disposePersistenceConsumer, preparePersistedMutation } from './service.ts';
import { readWriterAdminLock } from './admin-lock.ts';
import type { GraduationBlocker } from './engine-graduation.types.ts';

const PENDING_REQUESTS_SQL = `SELECT r.request_id::text AS request_id, r.source_id, r.operation, r.state,
    r.recovery IS NOT NULL AS recovering, r.blocked_reason, w.owner_host_id::text AS owner_host_id
  FROM persistence_requests r LEFT JOIN persistence_worktrees w ON w.id = r.worktree_id
  WHERE r.state IN ('queued', 'running', 'recovering') OR r.recovery IS NOT NULL
  ORDER BY r.sequence`;

const TERMINAL = new Set(['committed', 'conflict', 'failed', 'cancelled']);

type PendingRequest = { request_id: string; source_id: string; operation: string; state: string; recovering: boolean; blocked_reason: string | null; owner_host_id: string | null };

/** The read-only stuck-recovery preview of one record: the exit of a recovery that refuses a hand-edited file (C-1, C-4). */
const stuckRecoveryPreview = (sourceId: string, requestId: string) => ['gbrain', 'repair', 'stuck-recovery', '--source', sourceId, '--request-id', requestId];

/**
 * Everything that keeps graduation from copying, each with its graduation
 * action. Read-only. Queued, running and recovering requests owned by this
 * host are `request` blockers the drain itself clears (recovering ones carry
 * the retry command for when the drain cannot finish them), except a live
 * recovery blocked on a hand-edited file (`unexpected_file_bytes`), which only
 * the user resolves through the stuck-recovery preview it names; requests and host
 * bindings owned by another host, recovering topology changes, recovering
 * effects, the writer admin lock and OAuth clients bound to a missing source
 * (an FK only Postgres enforces) need someone else to act first.
 */
export async function graduationBlockers(source: BrainEngine, hostId: string): Promise<readonly GraduationBlocker[]> {
  const blockers: GraduationBlocker[] = [];
  const lock = await readWriterAdminLock(source);
  if (lock.locked) {
    blockers.push({ kind: 'writer_admin_lock', id: 'persistence.writer_admin_lock', detail: `writer administration locked at ${lock.set_at ?? 'unknown time'}`,
      argv: ['gbrain', 'sources', 'writer', 'unlock'], needsUser: true });
  }
  for (const r of await source.executeRaw<PendingRequest>(PENDING_REQUESTS_SQL)) {
    const detail = `${r.operation} ${r.state}${r.recovering ? ', recovering' : ''} (source ${r.source_id})`;
    if (r.owner_host_id && r.owner_host_id !== hostId) {
      blockers.push({ kind: 'foreign_host_binding', id: r.request_id, detail: `${detail} is bound to a worktree owned by host ${r.owner_host_id}`,
        argv: ['gbrain', 'sources', 'writer', 'transfer', 'prepare', r.source_id], needsUser: true });
    } else if (r.recovering && r.blocked_reason === 'unexpected_file_bytes' && !TERMINAL.has(r.state)) {
      blockers.push({ kind: 'request', id: r.request_id, detail: `${detail} is blocked on a hand-edited file (unexpected_file_bytes)`,
        argv: stuckRecoveryPreview(r.source_id, r.request_id), needsUser: true });
    } else if (r.recovering || r.state === 'recovering') {
      blockers.push({ kind: 'request', id: r.request_id, detail, argv: ['gbrain', 'sync', '--source', r.source_id, '--no-pull'], needsUser: false });
    } else {
      blockers.push({ kind: 'request', id: r.request_id, detail, needsUser: false });
    }
  }
  const topology = await source.executeRaw<{ id: string; operation: string; source_id: string }>(
    "SELECT id::text AS id, operation, source_id FROM persistence_topology_changes WHERE state = 'recovering' OR recovery IS NOT NULL ORDER BY created_at");
  for (const t of topology) {
    blockers.push({ kind: 'topology_recovery', id: t.id, detail: `${t.operation} for ${t.source_id} is recovering`,
      argv: ['gbrain', 'sources', 'writer', 'status', t.source_id, '--json'], needsUser: false });
  }
  const effects = await source.executeRaw<{ id: string; kind: string; state: string; error_code: string | null; source_id: string | null; request_id: string }>(
    `SELECT e.id::text AS id, e.kind, e.state, e.error_code, COALESCE(e.source_id, r.source_id) AS source_id, r.request_id::text AS request_id
     FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id WHERE e.recovery IS NOT NULL ORDER BY e.id`);
  for (const e of effects) {
    const sourceId = e.source_id ?? 'default';
    const stuck = e.kind === 'withdrawal-mirror' && e.error_code === 'unexpected_file_bytes';
    blockers.push({ kind: 'effect_recovery', id: e.id, detail: `${e.kind} effect ${e.state} for request ${e.request_id} is recovering${stuck ? ' and blocked on a hand-edited file (unexpected_file_bytes)' : ''}`,
      argv: e.kind === 'embedding' ? ['gbrain', 'repair', 'embedding-effects', '--source', sourceId]
        : stuck ? stuckRecoveryPreview(sourceId, e.request_id) : ['gbrain', 'sources', 'writer', 'status', sourceId, '--json'], needsUser: stuck });
  }
  const bindings = await source.executeRaw<{ worktree_id: string; host_id: string; source_id: string | null }>(
    `SELECT b.worktree_id::text AS worktree_id, b.host_id::text AS host_id,
       (SELECT s.source_id FROM persistence_source_bindings s WHERE s.worktree_id = b.worktree_id ORDER BY s.source_id LIMIT 1) AS source_id
     FROM persistence_host_bindings b WHERE b.host_id <> $1::uuid ORDER BY b.worktree_id, b.host_id`, [hostId]);
  for (const b of bindings) {
    blockers.push({ kind: 'foreign_host_binding', id: `${b.worktree_id}:${b.host_id}`, detail: `worktree ${b.worktree_id} has a binding on host ${b.host_id}`,
      argv: ['gbrain', 'sources', 'writer', 'transfer', 'prepare', b.source_id ?? b.worktree_id], needsUser: true });
  }
  const [boundColumn] = await source.executeRaw<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'oauth_clients' AND column_name = 'bound_source_id') AS present`);
  if (boundColumn?.present) {
    const dangling = await source.executeRaw<{ client_id: string; client_name: string; bound_source_id: string }>(`SELECT c.client_id, c.client_name, c.bound_source_id
      FROM oauth_clients c WHERE c.bound_source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = c.bound_source_id) ORDER BY c.client_id`);
    for (const c of dangling) {
      blockers.push({ kind: 'dangling_reference', id: `oauth_clients.${c.client_id}`,
        detail: `OAuth client ${c.client_name} is bound to source ${c.bound_source_id}, which no longer exists; Postgres enforces this binding, and clearing it would widen the client's access. Restore the source, or revoke the client and register a replacement`,
        argv: ['gbrain', 'auth', 'revoke-client', c.client_id], needsUser: true });
    }
  }
  return blockers;
}

/** Blockers the request-only drain can clear by itself (a recovery that needs the user is not one). */
function drainable(blocker: GraduationBlocker): boolean {
  return blocker.kind === 'request' && !blocker.needsUser;
}

/**
 * Drains this host's requests with a request-only consumer. Any blocker the
 * drain cannot clear is returned before anything starts. The consumer's stop
 * barrier always runs before return, so no publication is in flight when the
 * caller freezes and copies the source. `drained` lists the request ids that
 * reached a terminal state; `blockers` is the re-read blocker list (empty on
 * success).
 */
export async function drainForGraduation(source: BrainEngine, opts: { timeoutMs: number; hostId: string; config: GBrainConfig; pollMs?: number }):
  Promise<{ drained: readonly string[]; blockers: readonly GraduationBlocker[] }> {
  const initial = await graduationBlockers(source, opts.hostId);
  if (initial.some(b => !drainable(b))) return { drained: [], blockers: initial };
  const pending = initial.map(b => b.id);
  if (!pending.length) return { drained: [], blockers: [] };
  await disposePersistenceConsumer(source);
  const pollMs = opts.pollMs ?? 100;
  let lastError: string | undefined;
  const consumer = new PersistenceConsumer(source, opts.config, preparePersistedMutation, {
    hostId: opts.hostId, requestsOnly: true, pollMs, idleMaxMs: pollMs * 5,
    onError: error => { lastError = String((error as { code?: unknown } | null)?.code ?? 'storage_error'); },
  });
  const deadline = Date.now() + opts.timeoutMs;
  consumer.start();
  try {
    while (Date.now() < deadline) {
      const [row] = await source.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests
        WHERE request_id::text = ANY($1::text[]) AND (state IN ('queued', 'running', 'recovering') OR recovery IS NOT NULL)`, [pending]);
      if (Number(row?.n ?? 0) === 0) break;
      consumer.wake();
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  } finally {
    await consumer.stop();
  }
  const terminal = await source.executeRaw<{ request_id: string }>(`SELECT request_id::text AS request_id FROM persistence_requests
    WHERE request_id::text = ANY($1::text[]) AND state NOT IN ('queued', 'running', 'recovering') AND recovery IS NULL ORDER BY sequence`, [pending]);
  const blockers = (await graduationBlockers(source, opts.hostId))
    .map(b => lastError && b.kind === 'request' ? { ...b, detail: `${b.detail}; last drain error ${lastError}` } : b);
  return { drained: terminal.map(r => r.request_id), blockers };
}

/**
 * Freezes the PGLite source after the drain: the resident consumer is stopped
 * and the single connection defaults to read-only transactions, so any
 * in-process background writer fails instead of changing the snapshot being
 * copied. Source-row custody writes go through `withSourceWritable`.
 */
export async function freezeSource(source: BrainEngine): Promise<void> {
  if (source.kind !== 'pglite') throw new Error('freezeSource applies to the PGLite source of a graduation');
  await disposePersistenceConsumer(source);
  await source.executeRaw('SET default_transaction_read_only = on');
}

export async function unfreezeSource(source: BrainEngine): Promise<void> {
  await source.executeRaw('SET default_transaction_read_only = off');
}

/** One read-write transaction on a frozen source (the source-row `quiesced`/`cutover` writes). */
export async function withSourceWritable<T>(source: BrainEngine, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return source.transaction(async tx => {
    await tx.executeRaw('SET TRANSACTION READ WRITE');
    return fn(tx);
  });
}
