/**
 * Effect scans: one SQL implementation for both engines (Rust engine persistence, write journal lane).
 *
 * The reads the effect worker's pass (persistence/effects.ts `runEffectPass`) sent through `executeRaw` before it claims
 * effects: the requests whose parked mirror targets only wait on the segmented writer gate
 * (persistence/segmented-mirror-gate.ts `resumeGatedMirrors`). The text is the one that caller has always sent, byte for
 * byte, written out in full so this module imports no persistence code; the codes it matches arrive as arguments.
 * Decisions stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';

/** `listGatedMirrorRequests`: $1 host id, $2 the gate's parked-target filter (JSON text), $3 the parked codes that may stay. */
export const GATED_MIRROR_REQUESTS_SQL = `SELECT DISTINCT r.id::text AS id,r.source_id,r.request_id::text AS request_id FROM persistence_effects e
       JOIN persistence_requests r ON r.id=e.request_id JOIN persistence_worktrees w ON w.id=e.worktree_id
       WHERE e.kind='withdrawal-mirror' AND e.state='failed' AND e.error_code='targets_parked' AND w.owner_host_id=$1::uuid
       AND e.data->'parked' @> $2::text::jsonb
       AND NOT EXISTS (SELECT 1 FROM persistence_effects o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.data->'parked','[]'::jsonb)) AS p(target)
         WHERE o.request_id=e.request_id AND o.state<>'committed' AND COALESCE(p.target->>'error_code','')<>ALL($3::text[]))
       LIMIT 100`;

/** One request whose failed withdrawal mirror is parked only by the segmented writer gate: journal id, source and request id. */
export interface GatedMirrorRequest { id: string; source_id: string; request_id: string }

/**
 * Up to 100 requests on worktrees host `hostId` owns with a failed withdrawal mirror parked by `gateCode`, whose every
 * other unsettled effect is parked only with a code in `allowedCodes`. An id that is not a uuid refuses, as `::uuid` does.
 */
export function listGatedMirrorRequests(exec: LegacyUnscopedRead, hostId: string, gateCode: string, allowedCodes: readonly string[]): Promise<GatedMirrorRequest[]> {
  return exec.executeRaw<GatedMirrorRequest>(GATED_MIRROR_REQUESTS_SQL, [hostId, JSON.stringify([{ error_code: gateCode }]), [...allowedCodes]]);
}
