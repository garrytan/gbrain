/**
 * The blocker reads of the engine graduation drain (persistence/graduation-drain.ts `graduationBlockers`): the requests
 * still in flight or under recovery with their worktree's owner, the topology changes and effects under recovery, the
 * host bindings of other hosts with the byte-first source of their worktree, and the OAuth clients bound to a source
 * that no longer exists. Each ran through executeRaw; the text is the one the caller sent, byte for byte, once for both
 * SQL engines.
 *
 * The Rust engine answers from the store's journal, topology, worktree and client records
 * (rust/crates/gbrain-store/src/persistence/graduation_blockers.rs). Failback (`gbrain engine swap --to postgres`) drains
 * a Rust primary through graduation custody, so these reads are part of swap safety.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** A request still queued, deferred, running or recovering, or one that holds a recovery record, with its worktree's owner. */
export interface GraduationPendingRequest {
  request_id: string; source_id: string; operation: string; state: string; recovering: boolean; blocked_reason: string | null; owner_host_id: string | null;
}

/** A topology change that is recovering or holds a recovery record; `admission` and `automatic` as the drain classifies it. */
export interface GraduationTopologyRecovery { id: string; operation: string; source_id: string; request_id: string; admission: boolean; automatic: boolean }

/** An effect that holds a recovery record, with its source (the request's when the effect names none) and request id. */
export interface GraduationEffectRecovery { id: string; kind: string; state: string; error_code: string | null; source_id: string | null; request_id: string }

/** A host binding of another host, with the byte-first source bound to its worktree (null when none is). */
export interface ForeignHostBinding { worktree_id: string; host_id: string; source_id: string | null }

/** An OAuth client bound to a source that no longer exists. */
export interface DanglingOAuthClient { client_id: string; client_name: string; bound_source_id: string }

export const GRADUATION_PENDING_REQUESTS_SQL = `SELECT r.request_id::text AS request_id, r.source_id, r.operation, r.state,
    r.recovery IS NOT NULL AS recovering, r.blocked_reason, w.owner_host_id::text AS owner_host_id
  FROM persistence_requests r LEFT JOIN persistence_worktrees w ON w.id = r.worktree_id
  WHERE r.state IN ('queued', 'deferred', 'running', 'recovering') OR r.recovery IS NOT NULL
  ORDER BY r.sequence`;

/** The requests in flight or under recovery, in admission order (`sequence`). */
export async function listGraduationPendingRequests(raw: EngineRawRead): Promise<GraduationPendingRequest[]> {
  return raw<GraduationPendingRequest>(GRADUATION_PENDING_REQUESTS_SQL);
}

/** The topology changes that are recovering or hold a recovery record, oldest first. */
export async function listGraduationTopologyRecoveries(raw: EngineRawRead): Promise<GraduationTopologyRecovery[]> {
  return raw<GraduationTopologyRecovery>(
    "SELECT id::text AS id, operation, source_id, request_id::text AS request_id, (state = 'recovering' AND recovery IS NULL) AS admission, COALESCE(outcome->>'expired_only', 'false') = 'true' AS automatic FROM persistence_topology_changes WHERE state = 'recovering' OR recovery IS NOT NULL ORDER BY created_at");
}

/** The effects that hold a recovery record, by effect id. */
export async function listGraduationEffectRecoveries(raw: EngineRawRead): Promise<GraduationEffectRecovery[]> {
  return raw<GraduationEffectRecovery>(
    `SELECT e.id::text AS id, e.kind, e.state, e.error_code, COALESCE(e.source_id, r.source_id) AS source_id, r.request_id::text AS request_id
     FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id WHERE e.recovery IS NOT NULL ORDER BY e.id`);
}

/** The host bindings of every host other than `hostId`, by worktree then host, each with its worktree's byte-first source. */
export async function listForeignHostBindings(raw: EngineRawRead, hostId: string): Promise<ForeignHostBinding[]> {
  return raw<ForeignHostBinding>(
    `SELECT b.worktree_id::text AS worktree_id, b.host_id::text AS host_id,
       (SELECT s.source_id FROM persistence_source_bindings s WHERE s.worktree_id = b.worktree_id ORDER BY s.source_id COLLATE "C" LIMIT 1) AS source_id
     FROM persistence_host_bindings b WHERE b.host_id <> $1::uuid ORDER BY b.worktree_id, b.host_id`, [hostId]);
}

/** Whether `oauth_clients` has the `bound_source_id` column (an older schema has none, and then no client can dangle). */
export async function hasOAuthBoundSourceColumn(raw: EngineRawRead): Promise<boolean> {
  const [boundColumn] = await raw<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'oauth_clients' AND column_name = 'bound_source_id') AS present`);
  return boundColumn?.present === true;
}

/** The OAuth clients bound to a source that does not exist, by client id in byte order. */
export async function listDanglingOAuthClients(raw: EngineRawRead): Promise<DanglingOAuthClient[]> {
  return raw<DanglingOAuthClient>(`SELECT c.client_id, c.client_name, c.bound_source_id
      FROM oauth_clients c WHERE c.bound_source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = c.bound_source_id) ORDER BY c.client_id COLLATE "C"`);
}
