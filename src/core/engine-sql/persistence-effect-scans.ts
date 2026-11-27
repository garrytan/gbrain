/**
 * Effect scans: one SQL implementation for both engines (Rust engine persistence, write journal lane).
 *
 * The reads the effect worker's pass (persistence/effects.ts `runEffectPass`) sent through `executeRaw` before it claims
 * effects: the requests whose parked mirror targets only wait on the segmented writer gate
 * (persistence/segmented-mirror-gate.ts `resumeGatedMirrors`), and the effects with a recovery due
 * (persistence/effect-recovery-scan.ts `selectEffectRecoveries`), and the claim's candidate read
 * (persistence/effect-journal.ts `claimPersistenceEffect`), a write receipt's read of its effects (`readRequestEffects`), and the
 * stale and failed embedding effects `gbrain repair embedding-effects` settles (`listEmbeddingCandidates`). Each text is the one its caller has always sent, byte
 * for byte, written out in full so this module imports no persistence code; the codes it matches arrive as arguments.
 * Decisions stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
/**
 * `selectClaimableEffect`: $1 host id, $2 the owner keys proved dead (`pid:nonce:start`). The text
 * `claimPersistenceEffect` (persistence/effect-journal.ts) has always sent, with `DEAD_OWNER_EFFECT_SQL('e', '$2')` and
 * `refreshFenceClear('e')` written out; test/persistence-journal-statements.test.ts checks it against those fragments.
 */
export const CLAIMABLE_EFFECT_SQL = `SELECT e.* FROM persistence_effects e
      LEFT JOIN persistence_worktrees w ON w.id=e.worktree_id
      WHERE (e.state='queued' OR e.state='running' AND e.claim_expires_at<now() OR e.state='running' AND e.recovery IS NULL
  AND e.claim_owner->>'token'=e.execution_token::text AND concat_ws(':',e.claim_owner->'owner'->>'pid',e.claim_owner->'owner'->>'nonce',e.claim_owner->'owner'->>'start')=ANY($2::text[])) AND e.next_attempt_at<=now()
      AND (e.worktree_id IS NULL OR w.owner_host_id=$1::uuid) AND (e.worktree_id IS NULL OR NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes fence WHERE fence.worktree_id=e.worktree_id
        AND fence.state IN ('fenced','merged','recovery_required')))
      AND e.recovery IS NULL AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND (e.kind='withdrawal-mirror' OR NOT EXISTS (SELECT 1 FROM persistence_effects mirror
        WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running')))
      ORDER BY e.next_attempt_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`;

/** `listEffectRecoveries`: $1 host id, $2 the id to scan after (null from the start), $3 the row limit. */
export const EFFECT_RECOVERIES_SQL = `SELECT e.* FROM persistence_effects e
    JOIN persistence_worktrees w ON w.id=e.worktree_id
    WHERE e.recovery IS NOT NULL AND w.owner_host_id=$1::uuid AND e.next_attempt_at<=now()
      AND ($2::bigint IS NULL OR e.id>$2::bigint) ORDER BY e.id LIMIT $3`;

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
 * `readRequestEffects`, every kind: $1 request id. The text `publicEffectsForRequest` (persistence/effect-journal.ts) has always
 * sent, with the kind order pinned to `COLLATE "C"` so it never follows the database's locale.
 */
export const REQUEST_EFFECTS_SQL = 'SELECT kind,state,error_code,outcome,recovery IS NOT NULL AS recovering FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind COLLATE "C"';

/** `readRequestEffects`, the Git effect: $1 request id. The text `gitReceiptState` (persistence/effect-journal.ts) has always sent. */
export const REQUEST_GIT_EFFECT_SQL = `SELECT state,error_code,outcome,recovery IS NOT NULL AS recovering FROM persistence_effects WHERE request_id=$1::uuid AND kind='git' ORDER BY id DESC LIMIT 1`;

/** One effect of a request as its receipt reads it: the stored state, error code and outcome, and whether a recovery is open. */
export interface RequestEffectState { kind: string; state: string; error_code: string | null; outcome: Record<string, unknown> | null; recovering: boolean }

/**
 * The effects of journal request `requestId` as its receipt reads them, in kind order, or only its Git effect when
 * `kind` is `'git'` (`gitReceiptState`). A request id that is not a uuid refuses, as `::uuid` does.
 */
export async function readRequestEffects(exec: LegacyUnscopedRead, requestId: string, kind?: 'git'): Promise<RequestEffectState[]> {
  if (kind === 'git') {
    const rows = await exec.executeRaw<Omit<RequestEffectState, 'kind'>>(REQUEST_GIT_EFFECT_SQL, [requestId]);
    return rows.map(row => ({ kind: 'git', ...row }));
  }
  return exec.executeRaw<RequestEffectState>(REQUEST_EFFECTS_SQL, [requestId]);
}

/** The predicate up to the failed effect's error code, which `embeddingCandidateWhere` and `embeddingCandidateFragment` close with the never-retried list. */
const EMBEDDING_CANDIDATE_HEAD = `e.kind='embedding' AND r.state='committed' AND e.recovery IS NULL AND e.execution_token IS NULL
  AND (e.state='failed' OR e.state='queued' AND (e.updated_at < now() - interval '1 hour' OR e.data ? 'repair_requeued_at'))
  AND NOT (e.state='failed' AND e.error_code`;

/**
 * Stale queued (over an hour, or re-queued by a repair and not yet settled) and failed embedding effects of committed
 * writes, leaving out a failed effect whose code is one of `neverRetried` (parked targets, a zero-norm refusal). The
 * predicate `gbrain repair embedding-effects` and doctor's `stale_embedding_effects` share; codes are plain identifiers.
 */
export function embeddingCandidateWhere(neverRetried: readonly string[]): string {
  assertCandidateCodes(neverRetried);
  return `${EMBEDDING_CANDIDATE_HEAD} = ANY('{${neverRetried.join(',')}}'::text[]))`;
}

/** The same predicate with the codes bound as one text[] parameter (`listEmbeddingCandidates`). */
export function embeddingCandidateFragment(neverRetried: readonly string[]): SqlFragment {
  assertCandidateCodes(neverRetried);
  return sqlFragment`${trustedSql(EMBEDDING_CANDIDATE_HEAD)} = ANY(${[...neverRetried]}::text[]))`;
}

function assertCandidateCodes(neverRetried: readonly string[]): void {
  for (const code of neverRetried) if (!/^[a-z0-9_]+$/.test(code)) throw new Error(`embedding candidate code must be an identifier: ${code}`);
}

/** One embedding effect `gbrain repair embedding-effects` may settle, with the characters its retry would embed. */
export interface EmbeddingCandidate {
  effect_id: string; source_id: string; slug: string; request_id: string; state: 'queued' | 'failed'; attempts: number; chars: number;
}

/**
 * The embedding candidates of `sourceIds`, plus those of a removed or replaced source incarnation, in effect id order.
 * `chars` is the page's `compiled_truth` plus `timeline` length (a page effect), the sum over its targets (a targeted
 * effect) or over the source's live pages (a source scan); 0 when no page matches.
 */
export async function listEmbeddingCandidates(exec: LegacyUnscopedRead, sourceIds: readonly string[], neverRetried: readonly string[]): Promise<EmbeddingCandidate[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT e.id::text AS effect_id, r.source_id, r.slug, r.request_id::text AS request_id,
      e.state, e.attempts, COALESCE(CASE
        WHEN e.data ? 'page_id' THEN (SELECT length(p.compiled_truth) + length(COALESCE(p.timeline,'')) FROM pages p WHERE p.id = (e.data->>'page_id')::int)
        WHEN e.data ? 'targets' THEN (SELECT SUM(length(p.compiled_truth) + length(COALESCE(p.timeline,''))) FROM pages p
          JOIN jsonb_array_elements(e.data->'targets') t ON p.id = (t->>'page_id')::int)
        ELSE (SELECT SUM(length(p.compiled_truth) + length(COALESCE(p.timeline,''))) FROM pages p WHERE p.source_id = e.source_id AND p.deleted_at IS NULL)
      END, 0)::bigint AS chars
    FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
    WHERE ${embeddingCandidateFragment(neverRetried)} AND (r.source_id = ANY(${[...sourceIds]}::text[])
      OR NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = r.source_id AND s.incarnation = r.source_incarnation)) ORDER BY e.id`);
  const rows = await exec.executeRaw<EmbeddingCandidate>(text, params);
  return rows.map(row => ({ ...row, attempts: Number(row.attempts), chars: Number(row.chars) }));
}

/**
 * Up to `limit` effects on worktrees host `hostId` owns that carry a recovery due now, in id order, after effect id
 * `after` (from the start when null). An id that is not a uuid, an `after` that is not a bigint and a negative limit
 * refuse, as their casts and LIMIT do.
 */
export function listEffectRecoveries<R = Record<string, unknown>>(exec: LegacyUnscopedRead, hostId: string, after: string | null, limit: number): Promise<R[]> {
  return exec.executeRaw<R>(EFFECT_RECOVERIES_SQL, [hostId, after, limit]);
}

/**
 * Up to 100 requests on worktrees host `hostId` owns with a failed withdrawal mirror parked by `gateCode`, whose every
 * other unsettled effect is parked only with a code in `allowedCodes`. An id that is not a uuid refuses, as `::uuid` does.
 */
export function listGatedMirrorRequests(exec: LegacyUnscopedRead, hostId: string, gateCode: string, allowedCodes: readonly string[]): Promise<GatedMirrorRequest[]> {
  return exec.executeRaw<GatedMirrorRequest>(GATED_MIRROR_REQUESTS_SQL, [hostId, JSON.stringify([{ error_code: gateCode }]), [...allowedCodes]]);
}

/**
 * The next effect host `hostId` may claim, row-locked for the caller's transaction (skipping rows another transaction
 * holds), or null: a queued effect, or a running one whose lease ran out or whose owner is in `deadOwners`, due now,
 * on no worktree or on one this host owns with no refresh fence, with no recovery on it or its worktree, and not behind
 * an unsettled withdrawal mirror of its request. Oldest due first. A host id that is not a uuid refuses, as `::uuid` does.
 */
export async function selectClaimableEffect<R = Record<string, unknown>>(exec: LegacyUnscopedRead, hostId: string, deadOwners: readonly string[]): Promise<R | null> {
  const [row] = await exec.executeRaw<R>(CLAIMABLE_EFFECT_SQL, [hostId, [...deadOwners]]);
  return row ?? null;
}
