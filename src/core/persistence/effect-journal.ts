import { randomUUID } from 'node:crypto';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { PreparedMutation } from './coordinator.ts';
import { fileContentHash } from './large-file.ts';
import { PARK_AFTER_FAILURES, REMOTE_AUTO_LINKS_KEY, REMOTE_MENTION_OPERATIONS, WITHHELD_BY_MIRROR, type EffectKind, type PersistenceEffect, type EffectRequest } from './effect-model.ts';
import type { SqlEngine, WriteRequest } from './model.ts';
import { recordChronicleDecision } from '../chronicle/ledger.ts';
import { isFactsExtractionEnabled } from '../facts/extract.ts';
import { loadConfig } from '../config.ts';
import { resolveDefaultVisibility } from '../facts/visibility.ts';
import { declarePersistenceProtocol, PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import { EXPIRED_PREPARING_CHARGE_SQL } from './claim-phase.ts';
import { refreshFenceClear } from './worktree-refresh-schema.ts';
import { pageBatchChildRequestIds } from './page-batch-id.ts';
import { EFFECT_FAULT_POINTS, faultPoint } from './fault-points.ts';

/**
 * `snapshot` is the publication's final read of the page, including deleted rows, in this transaction.
 * A remote put_page/capture/edit_page also queues a `links` effect, in one statement that inserts
 * nothing while `auto_link` or `mcp.remote_auto_links` is off (unset is on).
 */
export async function queuePublicationEffects(tx: BrainEngine, row: EffectRequest & Partial<Pick<WriteRequest, 'operation' | 'intent' | 'authority' | 'principal_kind' | 'principal_id'>>, snapshot: PageSnapshot | null,
  outcome: Record<string, unknown>, prepared?: PreparedMutation,
  /** A grouped publication completes its members after queueing all of them, then calls `reconcileFinishedBatch` itself. */
  opts: { deferBatchReconcile?: boolean } = {}): Promise<void> {
  if (prepared?.noop || prepared?.target === 'skill_bundle') return;
  await declarePersistenceProtocol(tx);
  const revision = snapshot?.revision;
  const data = { slug: row.slug, page_id: snapshot?.page.id };
  // #6007: the effects are inserted together, in queue order, by one statement at the end.
  const queued: { kind: EffectKind; data: Record<string, unknown>; gated?: boolean }[] = [];
  const queue = (kind: EffectKind, extra: Record<string, unknown> = {}) => { queued.push({ kind, data: { ...data, ...extra } }); };
  if (prepared?.file && row.worktree_id) {
    const [binding] = await tx.executeRaw<{ local_path: string }>(`SELECT h.local_path FROM persistence_host_bindings h
      JOIN persistence_worktrees w ON w.id=h.worktree_id AND w.owner_host_id=h.host_id WHERE w.id=$1::uuid`, [row.worktree_id]);
    if (!binding?.local_path) throw opError('owner_unavailable', 'Cannot record the canonical Git target without its owner binding.',
      `Worktree ${row.worktree_id} of source ${row.source_id} has no host binding for its owner, so request ${row.id} could not record its Git target. Read the request's receipt; the owner host's binding is restored by its claim or transfer.`,
      row.principal_kind === 'local_cli' ? { fix: readFix(`Reads request ${row.id}'s durable receipt, read-only.`, { argv: ['gbrain', 'write-request', '--', row.id] }) } : {});
    const commit = prepared.file.commit;
    queue('git', { relative_path: relative(binding.local_path, prepared.file.path).split(sep).join('/'),
      expected_hash: prepared.file.content === null ? null : fileContentHash(prepared.file.content),
      ...(commit ? { commit_subject: commit.subject, commit_line: commit.line, ...(commit.trailer ? { commit_trailer: commit.trailer } : {}) } : {}) });
    if (outcome.persistence && typeof outcome.persistence === 'object') Object.assign(outcome.persistence, { git_state: 'queued' });
  }
  if (snapshot && !snapshot.page.deleted_at) {
    if (!prepared?.deferEmbedding) queue('embedding');
    outcome.embedding_state = await embeddingDisabled(tx) ? 'disabled' : prepared?.deferEmbedding ? 'deferred' : 'queued';
    if ((outcome.facts_backstop as { queued?: boolean } | undefined)?.queued) {
      if (!(await isFactsExtractionEnabled(tx))) outcome.facts_backstop = { skipped: 'extraction_disabled' };
      else queue('facts-backstop', { visibility: await resolveDefaultVisibility(tx) });
    }
    // The links effect is inserted with the others, gated in SQL on auto_link and mcp.remote_auto_links.
    if (queuesMentionLinks(row)) queued.push({ kind: 'links', data: { ...data }, gated: true });
    // #5876: the Life Chronicle decision is a ledger row, not an effect; the `chronicle` cycle phase executes it.
    await recordChronicleDecision(tx, row, snapshot, outcome);
  }
  const inserted = queued.length ? await tx.executeRaw<{ kind: string }>(`INSERT INTO persistence_effects (request_id,kind,revision,data,source_id,source_incarnation,worktree_id)
    SELECT $1::uuid,t.e->>'kind',$2::uuid,t.e->'data',$3,$4::uuid,$5::uuid FROM jsonb_array_elements($6::text::jsonb) WITH ORDINALITY AS t(e,n)
    WHERE NOT (COALESCE((t.e->>'gated')::boolean,false) AND EXISTS (SELECT 1 FROM config
      WHERE key IN ('auto_link',$7) AND lower(btrim(value,E' \\t\\r\\n')) IN ('false','0','no','off')))
    ORDER BY t.n ON CONFLICT(request_id,kind) DO NOTHING RETURNING kind`,
  [row.id, revision ?? null, row.source_id, row.source_incarnation, row.worktree_id, JSON.stringify(queued), REMOTE_AUTO_LINKS_KEY]) : [];
  if (queued.some(effect => effect.kind === 'links')) {
    if (inserted.some(effect => effect.kind === 'links')) outcome.auto_links = { ...(outcome.auto_links as Record<string, unknown> | undefined), mention_links: 'queued' };
    if (!opts.deferBatchReconcile) await reconcileFinishedBatch(tx, row);
  }
}

/** Whether a publication of this request queues a mention `links` effect: a remote page write without trusted auto-linking. */
export function queuesMentionLinks(row: Partial<Pick<WriteRequest, 'operation' | 'authority'>>): boolean {
  return !!row.authority && !!row.operation && REMOTE_MENTION_OPERATIONS.includes(row.operation)
    && !(row.authority.autoLinkTrusted ?? !row.authority.remote);
}

/**
 * #6007: when the last unfinished page of a `put_pages` batch publishes, its
 * earlier pages' links effects may have run before this page existed; re-arm
 * them once so forward references inside the batch resolve, with no client poll.
 */
export async function reconcileFinishedBatch(tx: BrainEngine, row: EffectRequest & Partial<Pick<WriteRequest, 'intent' | 'principal_kind' | 'principal_id'>>): Promise<void> {
  const batch = row.intent?.page_batch as { id?: unknown; size?: unknown } | undefined;
  if (!batch || typeof batch.id !== 'string' || typeof batch.size !== 'number' || batch.size < 2 || !row.principal_kind || !row.principal_id) return;
  const siblings = await tx.executeRaw<{ id: string; state: string }>(`SELECT id,state FROM persistence_requests
    WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[]) AND id<>$4::uuid AND intent->'page_batch'->>'id'=$5`,
  [row.principal_kind, row.principal_id, pageBatchChildRequestIds(batch.id, batch.size), row.id, batch.id]);
  if (siblings.some(sibling => !['committed', 'conflict', 'failed', 'cancelled'].includes(sibling.state))) return;
  await queueLinksReconcile(tx, { sourceId: row.source_id, requestIds: [row.id, ...siblings.filter(sibling => sibling.state === 'committed').map(sibling => sibling.id)] });
}

/**
 * Re-arm the `links` effects of requests published together (a batch), so each
 * page's mention links resolve against every page the batch created. Call it
 * in the transaction that commits the batch's last page, or after it. An effect
 * whose page changed since finishes as superseded; a claimed effect loses its
 * claim and runs again. `slugs` narrows the re-armed effects to those pages.
 * Each effect is re-armed at most once (`data.batch_reconciled`), so repeated
 * status reads of a finished batch do not redo the work. Returns how many were re-armed.
 */
export async function queueLinksReconcile(tx: SqlEngine, opts: { sourceId: string; requestIds: readonly string[]; slugs?: readonly string[] }): Promise<number> {
  if (!opts.requestIds.length) return 0;
  const rows = await tx.executeRaw(`UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,
    next_attempt_at=now(),error_code=NULL,outcome=NULL,updated_at=now(),data=data||'{"batch_reconciled":true}'::jsonb
    WHERE kind='links' AND source_id=$1 AND request_id=ANY($2::uuid[]) AND ($3::text[] IS NULL OR data->>'slug'=ANY($3::text[]))
    AND NOT (data ? 'batch_reconciled') AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`, [opts.sourceId, [...opts.requestIds], opts.slugs ? [...opts.slugs] : null]);
  return rows.length;
}

/**
 * A keyless brain (`init --no-embedding`: `embedding_disabled` on the file or
 * DB plane, the same pair the embedding effect refuses on) reports
 * `embedding_state: "disabled"` (agent-first operator wave E5): its
 * embedding effect settles as skipped, so "queued" would promise vectors that
 * never arrive.
 */
async function embeddingDisabled(tx: BrainEngine): Promise<boolean> {
  if (loadConfig()?.embedding_disabled === true) return true;
  return (await tx.getConfig('embedding_disabled')) === 'true';
}

/** Claims release their database connection before waiting for a filesystem lock/provider. Nothing on a refresh-fenced worktree is claimed. */
export async function claimPersistenceEffect(engine: BrainEngine, hostId: string): Promise<PersistenceEffect | null> {
  return engine.transactionDirect(async tx => {
    await declarePersistenceProtocol(tx);
    const [candidate] = await tx.executeRaw<PersistenceEffect>(`SELECT e.* FROM persistence_effects e
      LEFT JOIN persistence_worktrees w ON w.id=e.worktree_id
      WHERE (e.state='queued' OR e.state='running' AND e.claim_expires_at<now()) AND e.next_attempt_at<=now()
      AND (e.worktree_id IS NULL OR w.owner_host_id=$1::uuid) AND (e.worktree_id IS NULL OR ${refreshFenceClear('e')})
      AND e.recovery IS NULL AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND (e.kind='withdrawal-mirror' OR NOT EXISTS (SELECT 1 FROM persistence_effects mirror
        WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running')))
      ORDER BY e.next_attempt_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`, [hostId]);
    if (!candidate) return null;
    const [claimed] = await tx.executeRaw<PersistenceEffect>(`UPDATE persistence_effects SET state='running',execution_token=$2::uuid,
      claim_expires_at=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *`, [candidate.id, randomUUID()]);
    return claimed;
  });
}

/** #5530: an effect that commits exactly one recorded file (not a withdrawal walk or a source scan). */
export function singleFileGitEffect(effect: PersistenceEffect): boolean {
  return effect.kind === 'git' && typeof effect.data.relative_path === 'string' && effect.data.version === undefined
    && !effect.data.source_scan && effect.data.targets === undefined;
}

/**
 * GBRA-130 A-12: what a request's withdrawal mirror proves about its pages, read
 * when a Git or embedding attempt executes. `pending`: the mirror is queued or
 * running (a retry-effects requeue lands between the claim and the attempt), so
 * the attempt waits. `published`: pages whose file the mirror rewrote (its
 * recovery records each one, `data.published`); a cursor position is no proof,
 * since the mirror also passes pages it skipped or found without a file.
 * `passed`: pages the mirror moved past without parking or awaiting a retry; it
 * never revisits them. `files`: the hash of the bytes the mirror wrote to each
 * published page's file and the revision it rendered (`data.published_files`).
 */
export interface MirrorGate { state: 'pending' | 'failed' | 'committed'; published: Set<string>; passed: Set<string>; files: Map<string, { hash: string; revision: string }> }

/**
 * Per request id, the gate of its withdrawal mirror: every mirror that has not
 * committed, and a committed one that recorded its publications. A request
 * without such a mirror is absent and its work is unrestricted.
 */
export async function mirrorGates(engine: SqlEngine, requestIds: readonly string[]): Promise<Map<string, MirrorGate>> {
  if (!requestIds.length) return new Map();
  const rows = await engine.executeRaw<{ request_id: string; state: PersistenceEffect['state']; data: PersistenceEffect['data'] }>(
    `SELECT request_id::text AS request_id,state,data FROM persistence_effects WHERE kind='withdrawal-mirror' AND (state<>'committed' OR data ? 'published')
      AND request_id=ANY($1::uuid[])`, [[...new Set(requestIds)]]);
  return new Map(rows.map(({ request_id, state, data }) => {
    const after = data.after_slug;
    const unfinished = new Set([...(data.parked ?? []).flatMap(entry => entry.slug ? [entry.slug] : []), ...(data.retry_slugs ?? [])]);
    const passed = (data.targets ?? []).filter(target => after !== undefined && target.slug <= after && !unfinished.has(target.slug)).map(target => target.slug);
    return [request_id, { state: state === 'queued' || state === 'running' ? 'pending' : state, published: new Set(data.published ?? []), passed: new Set(passed),
      files: new Map(Object.entries(data.published_files ?? {})) }];
  }));
}

/**
 * GBRA-130 A-12: once a request's withdrawal mirror has committed, the Git and
 * embedding targets parked behind it (`withdrawal_mirror_failed`) get another
 * attempt with no operator retry: a scan revisits them first
 * (`data.retry_slugs`), a single-target effect runs again. Other parked targets
 * stay parked, and a claimed effect is left to its claim. The mirror's commit
 * calls this in its own transaction; each effect pass calls it again for the
 * requests it touched, for a park that settled after a concurrent mirror commit.
 */
const REARMABLE = `e.request_id=ANY($1::uuid[])
    AND e.kind IN ('git','embedding') AND e.state IN ('queued','failed') AND e.execution_token IS NULL AND e.recovery IS NULL
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) AS p(target) WHERE p.target->>'error_code'=$2)
    AND EXISTS (SELECT 1 FROM persistence_effects m WHERE m.request_id=e.request_id AND m.kind='withdrawal-mirror' AND m.state='committed')`;

/** Whether any of these requests has a target rearmWithheldTargets would re-arm; a pass opens its re-arm transaction only then. */
export async function hasRearmableTargets(engine: SqlEngine, requestIds: readonly string[]): Promise<boolean> {
  if (!requestIds.length) return false;
  return (await engine.executeRaw(`SELECT 1 FROM persistence_effects e WHERE ${REARMABLE} LIMIT 1`, [[...new Set(requestIds)], WITHHELD_BY_MIRROR])).length > 0;
}

export async function rearmWithheldTargets(engine: SqlEngine, requestIds: readonly string[]): Promise<number> {
  if (!requestIds.length) return 0;
  const rows = await engine.executeRaw<PersistenceEffect>(`SELECT e.* FROM persistence_effects e WHERE ${REARMABLE}
    ORDER BY e.id FOR UPDATE OF e SKIP LOCKED`, [[...new Set(requestIds)], WITHHELD_BY_MIRROR]);
  for (const effect of rows) {
    const { parked = [], ...data } = effect.data;
    const kept = parked.filter(entry => entry.error_code !== WITHHELD_BY_MIRROR);
    const scanning = data.targets !== undefined || data.source_scan === true;
    const slugs = scanning ? parked.flatMap(entry => entry.error_code === WITHHELD_BY_MIRROR && entry.slug ? [entry.slug] : []) : [];
    const retrying = [...new Set([...(data.retry_slugs ?? []), ...slugs])];
    await engine.executeRaw(`UPDATE persistence_effects SET state='queued',data=$2::text::jsonb,error_code=NULL,claim_expires_at=NULL,
      next_attempt_at=now(),updated_at=now() WHERE id=$1 AND execution_token IS NULL AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}`,
    [effect.id, JSON.stringify({ ...data, ...(kept.length ? { parked: kept } : {}), ...(retrying.length ? { retry_slugs: retrying } : {}),
      ...(effect.kind === 'embedding' ? { embedding_attempt_base: effect.attempts } : {}) })]);
  }
  return rows.length;
}

/**
 * #5530: claim up to `limit` more ready single-file Git effects for one
 * worktree, under the same readiness, recovery and withdrawal-mirror ordering
 * rules as claimPersistenceEffect, so the runner commits them together.
 */
export async function claimCoalescedGitEffects(engine: BrainEngine, hostId: string, worktreeId: string, limit: number): Promise<PersistenceEffect[]> {
  if (limit <= 0) return [];
  const rows = await engine.transactionDirect(async tx => {
    await declarePersistenceProtocol(tx);
    // The worktree-wide conditions (owner, refresh fence, recovery blocks) are one
    // InitPlan, so the claim walks persistence_effects_pending in order and stops at
    // $3 rows instead of probing every ready effect of the worktree.
    return tx.executeRaw<PersistenceEffect>(`WITH ready AS (SELECT e.id FROM persistence_effects e
      WHERE EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=$2::uuid AND w.owner_host_id=$1::uuid
        AND ${refreshFenceClear('w', 'id')}
        AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=w.id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=w.id AND blocked.recovery IS NOT NULL))
      AND e.worktree_id=$2::uuid AND e.kind='git' AND e.data ? 'relative_path'
      AND NOT (e.data ? 'targets') AND NOT (e.data ? 'source_scan') AND NOT (e.data ? 'version')
      AND (e.state='queued' OR e.state='running' AND e.claim_expires_at<now()) AND e.next_attempt_at<=now()
      AND e.recovery IS NULL
      AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror
        WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running'))
      ORDER BY e.next_attempt_at,e.id LIMIT $3 FOR UPDATE OF e SKIP LOCKED)
      UPDATE persistence_effects p SET state='running',execution_token=gen_random_uuid(),
      claim_expires_at=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
      FROM ready WHERE p.id=ready.id RETURNING p.*`, [hostId, worktreeId, limit]);
  });
  return rows.sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * PGLite only: the datastore admits one process, and this one opened it at
 * `processStartedAt`, so a claim last written before then was held by an owner
 * that has exited (a crash or SIGKILL). Release those claims now instead of
 * waiting out their leases (effects 2 minutes, requests 30 s); a withdrawal
 * mirror left running would otherwise also hold back writes to its pages.
 * Claims with a recovery record stay with the recovery path.
 */
/**
 * `chargePreparing` (#6278, the `preparation_deadlines` switch): a request whose
 * dead owner stamped the reclaimed claim `preparing` is charged one preparation
 * attempt, the same rule as the Postgres expired-claim sweep (consumer.ts), so a
 * kill loop reaches `persistence.max_preparation_attempts`.
 */
export async function releaseAbandonedClaims(engine: BrainEngine, processStartedAt: Date, chargePreparing = false): Promise<number> {
  if (engine.kind !== 'pglite') return 0;
  const effects = await engine.executeRaw(`UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,
    next_attempt_at=LEAST(next_attempt_at,now()) WHERE state='running' AND recovery IS NULL AND updated_at<$1::timestamptz
    AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`, [processStartedAt.toISOString()]);
  const requests = await engine.executeRaw(`UPDATE persistence_requests r SET state='queued',execution_token=NULL,claim_expires_at=NULL,
    preparation_attempts=preparation_attempts+CASE WHEN $2::boolean THEN ${EXPIRED_PREPARING_CHARGE_SQL('r')} ELSE 0 END
    WHERE state='running' AND recovery IS NULL AND publication_started=false AND updated_at<$1::timestamptz
    AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`, [processStartedAt.toISOString(), chargePreparing]);
  return effects.length + requests.length;
}

/** @internal Claim renewals made between the pieces of a segmented page's file (effectClaimKeeper), by effect kind, for the bounded-work test. Counts, not time. */
export const effectClaimWork: Record<string, number> = {};

/**
 * Called between the pieces of a long read or write under a withdrawal-mirror or Git claim (a segmented page's file
 * rendered, staged or compared): renews the 2-minute claim once `intervalMs` has passed since the last renewal, also
 * while the mirror holds its recovery record, and refuses with `write_claim_lost` once the claim moved.
 */
export function effectClaimKeeper(engine: BrainEngine, effect: PersistenceEffect, intervalMs: number): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < intervalMs) return;
    last = performance.now();
    effectClaimWork[effect.kind] = (effectClaimWork[effect.kind] ?? 0) + 1;
    const rows = await engine.executeRawDirect(`UPDATE persistence_effects SET claim_expires_at=now()+interval '2 minutes',updated_at=now()
      WHERE id=$1 AND execution_token=$2::uuid AND state='running' AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`, [effect.id, effect.execution_token]);
    if (rows.length !== 1) throw opError('write_claim_lost', 'The effect claim changed.',
      `Another worker took over this ${effect.kind} effect of source ${effect.source_id} (its claim expired or was reassigned), so this attempt stopped; the current holder finishes it. Inspect the owner's effects rather than retrying by hand.`,
      { fix: readFix(`Shows source ${effect.source_id}'s canonical owner with its blocking, retrying and parked effects, read-only.`,
        { argv: ['gbrain', 'sources', 'writer', 'status', '--source', effect.source_id, '--json'] }) });
  };
}

export async function renewPersistenceEffectClaim(engine: SqlEngine, effect: PersistenceEffect): Promise<boolean> {
  const rows = await engine.executeRaw(`UPDATE persistence_effects SET claim_expires_at=now()+interval '2 minutes',updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND state='running' AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`, [effect.id, effect.execution_token]);
  return rows.length === 1;
}

export async function advanceEffectCursor(engine: SqlEngine, effect: PersistenceEffect, slug: string): Promise<void> {
  const retrying = effect.data.retry_slugs ?? [];
  if (retrying.includes(slug)) {
    // A retried parked target finishes without moving the scan cursor. Each
    // remaining retried target keeps a single authorized attempt.
    const { retry_slugs: _retry, target_failures: _failures, failing_target: _target, ...data } = effect.data;
    const remaining = retrying.filter(candidate => candidate !== slug);
    await requeueEffect(engine, effect, remaining.length ? { ...data, retry_slugs: remaining, target_failures: PARK_AFTER_FAILURES - 1 } : data, null, 0);
    return;
  }
  await engine.executeRaw(`UPDATE persistence_effects SET state='queued',data=jsonb_set(
    CASE WHEN kind='embedding' THEN jsonb_set(data,'{embedding_attempt_base}',to_jsonb(attempts)) ELSE data-'target_failures'-'failing_target' END,'{after_slug}',to_jsonb($3::text)),
    execution_token=NULL,claim_expires_at=NULL,next_attempt_at=now(),error_code=NULL,
    updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}`, [effect.id, effect.execution_token, slug]);
}

/** An effect with parked targets finishes as failed (`targets_parked`), never as committed. */
export async function completeEffect(engine: SqlEngine, effect: PersistenceEffect, outcome: Record<string, unknown> = {}): Promise<void> {
  await faultPoint(EFFECT_FAULT_POINTS[effect.kind], { effectId: effect.id, requestId: effect.request_id, sourceId: effect.source_id });
  await engine.executeRaw(`UPDATE persistence_effects SET
    state=CASE WHEN jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 THEN 'failed' ELSE 'committed' END,
    error_code=CASE WHEN jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 THEN 'targets_parked' END,
    data=data-'retry_slugs'-'target_failures'-'failing_target',execution_token=NULL,claim_expires_at=NULL,
    outcome=$3::text::jsonb,updated_at=now() WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}`,
  [effect.id, effect.execution_token, JSON.stringify(outcome)]);
}
export async function retryEffect(engine: SqlEngine, effect: PersistenceEffect, reason: string, delayMs = 1000): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,error_code=$3,
    next_attempt_at=now()+($4::double precision*interval '1 millisecond'),updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND ${PERSISTENCE_PROTOCOL_PREDICATE}`, [effect.id, effect.execution_token, reason, delayMs]);
}
/** Release a claim with replacement bookkeeping; parking never applies while recovery is recorded. */
export async function requeueEffect(engine: SqlEngine, effect: PersistenceEffect, data: PersistenceEffect['data'], reason: string | null, delayMs: number): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET state='queued',data=$3::text::jsonb,execution_token=NULL,claim_expires_at=NULL,error_code=$4,
    next_attempt_at=now()+($5::double precision*interval '1 millisecond'),updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}`,
  [effect.id, effect.execution_token, JSON.stringify(data), reason, delayMs]);
}
export async function parkEffect(engine: SqlEngine, effect: PersistenceEffect, data: PersistenceEffect['data']): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET state='failed',data=$3::text::jsonb,execution_token=NULL,claim_expires_at=NULL,
    error_code='targets_parked',updated_at=now() WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}`,
  [effect.id, effect.execution_token, JSON.stringify(data)]);
}
export async function failEffect(engine: SqlEngine, effect: PersistenceEffect, reason: string): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET state='failed',execution_token=NULL,claim_expires_at=NULL,error_code=$3,updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}`, [effect.id, effect.execution_token, reason]);
}

/** Only public kind/state/reason, aggregated so withdrawal page counts cannot leak. */
export async function publicEffectsForRequest(engine: SqlEngine, requestId: string): Promise<Array<{ kind: EffectKind; state: string; reason?: string; push?: string; added?: number; removed?: number }>> {
  const rows = await engine.executeRaw<{ kind: EffectKind; state: string; error_code: string | null; recovering: boolean; outcome: Record<string, unknown> | null }>(
    'SELECT kind,state,error_code,outcome,recovery IS NOT NULL AS recovering FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind', [requestId]);
  return rows.filter(row => ['git', 'embedding', 'withdrawal-mirror', 'facts-backstop', 'links'].includes(row.kind)).map(row => {
    const reason = row.error_code ?? row.outcome?.reason;
    const push = row.outcome?.push;
    return { kind: row.kind, state: row.recovering ? 'recovering' : row.outcome?.git === 'skipped' || row.outcome?.facts === 'skipped' || row.outcome?.embedding === 'skipped' || row.outcome?.links === 'skipped' ? 'skipped'
      : row.outcome?.facts === 'queued' ? 'dispatched' : row.state,
      ...(typeof reason === 'string' && /^[a-z_]{1,80}$/.test(reason) ? { reason } : {}),
      ...(row.kind === 'git' && (push === 'committed' || push === 'skipped') ? { push } : {}),
      ...(row.kind === 'links' && row.outcome?.links === 'committed' ? { added: Number(row.outcome.added), removed: Number(row.outcome.removed) } : {}),
    };
  });
}
