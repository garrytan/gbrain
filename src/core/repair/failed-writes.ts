/**
 * `gbrain repair failed-writes` (#5983): resubmits caller writes that the
 * managed writer guard refused while it misread page children's source
 * (`writer_coordinator_required`, stored before #5982 as `storage_error`
 * "Publication failed (P0001)"). The failed receipt keeps its full intent until
 * receipt compaction (`persistence.receipt_retention_days`), so the write can
 * be submitted again once the guard is fixed.
 *
 * Only writes a caller made directly are replayed: `put_page` without an
 * owner-internal `kind`, `add_timeline_entry` and `remember`. Writes an owner
 * process produced (sync and file imports, reconcile, relink, maintenance
 * pages, jobs) are counted as residuals with the command that produces them
 * again, because re-running the producer uses current content.
 *
 * A candidate is kept, never replayed, when:
 *   - `already_written`: a later committed request carries the same intent, or
 *     an earlier apply's replay committed;
 *   - `duplicate`: a later failed or pending request carries the same intent
 *     (that one is the candidate);
 *   - `superseded`: a later request wrote or deleted the page (committed or
 *     still pending; for `put_page`, also a later failed `put_page`, which is
 *     the newer content), or the page changed after the revision the caller
 *     read;
 *   - `unpinned_target`: a `remember` whose original target was inferred as
 *     unattributed; replaying would infer again and could pick another page.
 *
 * Explicit-only and preview-bound: the preview lists every candidate with its
 * class and saves the replay set, with each target page's revision, under its
 * hash; `--apply --expect <hash>` replays exactly that set. Each item is
 * reclassified (`changed_since_preview`) and its original authority re-checked
 * (`authority_revoked`), then submitted through the operation's normal path on
 * the original trust lane (a remote caller's write is prepared as a remote
 * write, with its take-holder and delegated-namespace limits), bound to the
 * previewed page revision (`force` is dropped), under a request id derived
 * from the failed request id. The failed receipt stays as history.
 */
import { OperationError } from '../ops/contract.ts';
import type { OperationContext } from '../ops/contract.ts';
import type { BrainEngine } from '../engine.ts';
import { digest } from '../persistence/digest.ts';
import { isTerminal, principalKey, type WriteAuthority, type WriteRequest } from '../persistence/model.ts';
import { authorizeStoredRequest } from '../persistence/authority.ts';
import { initializeLocalPersistence, requestPrincipalForContext, submitPageMutation } from '../persistence/page-mutations.ts';
import { submitRememberMutation } from '../persistence/memory-mutations.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { resolveEntitySlugWithSource } from '../entities/resolve.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

const REPLAYABLE = ['put_page', 'add_timeline_entry', 'remember'];
const REMEMBER_PREPARED_KEYS = ['entity_slug', 'fence', 'valid_from', 'valid_until', 'entity_inferred', 'entity_warning'];
const REMOTE_PREPARED_KEYS = ['source_kind', 'source_uri', 'ingested_via'];
const PAGE_REMOVALS = ['delete_page', 'purge_page'];
const GUARD_REFUSAL = `(r.error_code='writer_coordinator_required'
  OR (r.error_code='storage_error' AND r.error_message LIKE 'Publication failed (P0001)%'))`;

interface FailedWrite {
  id: string; sequence: string; operation: string; source_id: string; slug: string; digest: string;
  intent: Record<string, unknown>; authority: WriteAuthority; created_at: string; producer: string | null;
}
type Disposition = 'replay' | 'already_written' | 'duplicate' | 'superseded' | 'unpinned_target';
/** A replay bound to the page revision the preview saw (null: no live page). */
interface ApprovedWrite extends FailedWrite { revision: string | null; selection: string[] }
interface FailedWriteItem extends RepairItem { failed: ApprovedWrite; hash: string; last: boolean }

function previewCommand(scope: RepairScope): string {
  return `gbrain repair failed-writes${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;
}

/** The command that produces an owner-internal write again, from current content. */
function producerCommand(producer: string, sourceId: string): string {
  const parts = producer.split(':');
  if (parts.some(part => part.startsWith('managed_sync') || part === 'managed_file_import')) return `gbrain sync --source ${sourceId} --no-pull --retry-failed --json`;
  if (parts.includes('canonical_reconcile')) return `gbrain sources reconcile ${sourceId} --audit`;
  if (parts.includes('managed_file_repair')) return `gbrain repair frontmatter --source ${sourceId} (a frontmatter repair) or gbrain repair fences --source ${sourceId} (a fence repair)`;
  if (parts.includes('relink_facts')) return `gbrain facts relink --source ${sourceId} --dry-run`;
  if (parts.some(part => part.includes('facts'))) return `gbrain extract --stale --source-id ${sourceId} --json`;
  return 'the next `gbrain dream` cycle (or autopilot) produces it again';
}

async function failedWrites(engine: BrainEngine, sourceIds: string[], id?: string): Promise<FailedWrite[]> {
  return engine.executeRaw<FailedWrite>(`SELECT r.id::text, r.sequence::text, r.operation, r.source_id, r.slug, r.digest, r.intent, r.authority,
      to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
      CASE WHEN r.operation = ANY($2::text[]) AND NOT (r.operation='put_page' AND r.intent ? 'kind') THEN NULL
        ELSE r.operation || COALESCE(':' || (r.intent->>'kind'), '') END AS producer
    FROM persistence_requests r
    WHERE r.source_id = ANY($1::text[]) AND r.state='failed' AND NOT r.compacted AND r.intent IS NOT NULL AND ${GUARD_REFUSAL}
      ${id ? 'AND r.id=$3::uuid' : ''}
    ORDER BY r.sequence`, id ? [sourceIds, REPLAYABLE, id] : [sourceIds, REPLAYABLE]);
}

async function pageRevision(engine: BrainEngine, sourceId: string, slug: string): Promise<string | null> {
  const [page] = await engine.executeRaw<{ revision: string | null }>(
    'SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
  return page?.revision ?? null;
}

function replayId(failedId: string, attempt: number): string {
  const h = digest(['failed-writes-replay-v1', failedId, attempt]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The replay's request id: one per failed request and attempt, so a rerun after
 * a crash resumes the same admission and a terminal failure gets a new id.
 * `prior` is that attempt's request when it was already admitted.
 */
async function replayAttempt(engine: BrainEngine, failedId: string): Promise<{ id: string; prior: WriteRequest | null }> {
  for (let attempt = 0; ; attempt++) {
    const id = replayId(failedId, attempt);
    const [prior] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [id]);
    if (!prior || prior.state === 'committed' || !isTerminal(prior)) return { id, prior: prior ?? null };
  }
}

/** Why a caller write must not be replayed now, or `replay`. */
async function disposition(engine: BrainEngine, write: FailedWrite): Promise<{ class: Disposition; detail?: string }> {
  if ((await replayAttempt(engine, write.id)).prior?.state === 'committed') return { class: 'already_written', detail: 'replayed by gbrain repair failed-writes' };
  const replace = write.operation === 'put_page';
  const [later] = await engine.executeRaw<{ state: string; operation: string; same_intent: boolean }>(
    `SELECT state, operation, digest=$3 AS same_intent FROM persistence_requests
      WHERE source_id=$1 AND slug=$2 AND sequence > $4::bigint AND (
        (digest=$3 AND state IN ('committed','failed','queued','running','recovering'))
        OR (state IN ('committed','queued','running','recovering') AND (operation = ANY($6::text[]) OR $5::boolean))
        OR ($5::boolean AND state='failed' AND operation='put_page' AND NOT (intent ? 'kind')))
      ORDER BY (digest=$3 AND state='committed') DESC, (digest=$3) DESC, sequence LIMIT 1`,
    [write.source_id, write.slug, write.digest, write.sequence, replace, PAGE_REMOVALS]);
  if (later?.same_intent && later.state === 'committed') return { class: 'already_written' };
  if (later?.same_intent) return { class: 'duplicate', detail: `a later request with the same intent is ${later.state}` };
  if (later) return { class: 'superseded', detail: `a later ${later.operation} of this page is ${later.state}` };
  const read = write.intent.expected_revision;
  if (replace && typeof read === 'string' && read !== await pageRevision(engine, write.source_id, write.slug)) {
    return { class: 'superseded', detail: 'the page changed after the revision the caller read' };
  }
  if (write.operation === 'remember' && typeof write.intent.entity_slug !== 'string') {
    return { class: 'unpinned_target', detail: 'the fact was saved unattributed; replaying would infer its subject again' };
  }
  return { class: 'replay' };
}

function item(write: ApprovedWrite, hash: string, last: boolean): FailedWriteItem {
  return { cursor: { phase: 1, id: Number(write.sequence) }, source_id: write.source_id, slug: write.slug,
    chars: typeof write.intent.content === 'string' ? write.intent.content.length : 0, action: `replay:${write.operation}`, failed: write, hash, last };
}

export const failedWritesRepair: RepairHandler = {
  kind: 'failed-writes',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope);
    if (!opts?.apply) {
      const rows = await failedWrites(engine, scope.source_ids);
      const residuals: Record<string, number> = {};
      const listing: NonNullable<RepairPlan['listing']> = [];
      const producers = new Map<string, string>();
      const replay: ApprovedWrite[] = [];
      for (const write of rows) {
        const label = `${write.source_id}:${write.slug} ${write.operation} (failed ${write.created_at}, request ${write.id})`;
        if (write.producer) {
          residuals[`producer_owned:${write.producer}`] = (residuals[`producer_owned:${write.producer}`] ?? 0) + 1;
          producers.set(`${write.producer} in ${write.source_id}`, producerCommand(write.producer, write.source_id));
          listing.push({ item: label, class: 'producer_owned', detail: `re-run: ${producerCommand(write.producer, write.source_id)}` });
          continue;
        }
        const verdict = await disposition(engine, write);
        if (verdict.class === 'replay') replay.push({ ...write, revision: await pageRevision(engine, write.source_id, write.slug), selection: scope.source_ids });
        else residuals[verdict.class] = (residuals[verdict.class] ?? 0) + 1;
        listing.push({ item: label, class: verdict.class, ...(verdict.detail ? { detail: verdict.detail } : {}) });
      }
      const sources = await engine.executeRaw<{ id: string; incarnation: string }>(
        'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
      const hash = previewHash({ kind: 'failed-writes-v1', brain_id: scope.brain_id, sources, selection: { source_ids: scope.source_ids },
        replay: replay.map(write => ({ id: write.id, digest: write.digest, revision: write.revision })) });
      if (replay.length) await saveApprovedSet<ApprovedWrite>(engine, { command: 'failed-writes', hash }, replay);
      return { items: replay.map((write, index) => item(write, hash, index === replay.length - 1)), preview_hash: hash, residuals, listing,
        warnings: [...producers].map(([what, run]) => `${what}: produced by gbrain itself, not replayed here; ${run}`) };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair failed-writes --apply replays only the set a preview printed.',
        `Preview first: ${command} — show the user the listing, then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        'docs/guides/repair.md#failed-writes');
    }
    const approved = await loadApprovedSet<ApprovedWrite>(engine, { command: 'failed-writes', hash: opts.expect, previewCommand: command });
    if (approved.items.some(write => JSON.stringify(write.selection) !== JSON.stringify(scope.source_ids))) throw previewChangedError(opts.expect, command);
    const items = approved.items.map((write, index) => item(write, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { failed, hash, last } = entry as FailedWriteItem;
    const outcome = await replay(ctx, failed);
    if (last) await clearApprovedSet(ctx.engine, { command: 'failed-writes', hash });
    return outcome;
  },
};

/** The original caller's trust lane: a remote caller's write is prepared as a remote write, within its holder and namespace limits. */
function laneContext(ctx: OperationContext, authority: WriteAuthority): OperationContext {
  if (!authority.remote) return { ...ctx, remote: false };
  return { ...ctx, remote: true, takesHoldersAllowList: authority.takesHolders ? [...authority.takesHolders] : ['world'],
    ...(authority.restrictedNamespace ? { viaSubagent: true, allowedSlugPrefixes: [...(authority.delegatedPrefixes ?? [])] } : {}) };
}

/** The caller's params, without what preparation added, bound to the previewed page revision. */
async function replayParams(ctx: OperationContext, write: ApprovedWrite, requestId: string): Promise<{ params: Record<string, unknown> } | { refused: RepairItemOutcome }> {
  const params: Record<string, unknown> = { ...write.intent, request_id: requestId };
  if (write.authority.remote) for (const key of REMOTE_PREPARED_KEYS) delete params[key];
  if (write.operation === 'remember') {
    const target = String(write.intent.entity_slug);
    for (const key of REMEMBER_PREPARED_KEYS) delete params[key];
    if ((await resolveEntitySlugWithSource(ctx.engine, write.source_id, target))?.slug !== target) {
      return { refused: { applied: false, outcome: 'changed_since_preview', reason: `the fact's subject ${target} no longer resolves to itself` } };
    }
    params.entity = target;
    return { params };
  }
  if (write.operation === 'put_page') {
    delete params.force;
    delete params.expected_revision;
    if (write.revision) params.expected_revision = write.revision;
  }
  return { params };
}

async function replay(ctx: OperationContext, failed: ApprovedWrite): Promise<RepairItemOutcome> {
  const [live] = await failedWrites(ctx.engine, [failed.source_id], failed.id);
  if (!live || live.digest !== failed.digest) return { applied: false, outcome: 'changed_since_preview', reason: 'the failed request was compacted or changed' };
  const lane = laneContext(ctx, live.authority);
  await initializeLocalPersistence(lane);
  const attempt = await replayAttempt(ctx.engine, failed.id);
  if (attempt.prior?.state === 'committed') return { applied: false, outcome: 'already_written' };
  if (attempt.prior && principalKey({ kind: attempt.prior.principal_kind, id: attempt.prior.principal_id }) !== principalKey(await requestPrincipalForContext(lane))) {
    return { applied: false, outcome: 'pending_elsewhere', reason: `replay request ${attempt.id} is ${attempt.prior.state} under another writer` };
  }
  if (!attempt.prior) {
    const verdict = await disposition(ctx.engine, live);
    if (verdict.class !== 'replay') return { applied: false, outcome: 'changed_since_preview', reason: verdict.detail ?? verdict.class };
    if (live.operation === 'put_page' && await pageRevision(ctx.engine, failed.source_id, failed.slug) !== failed.revision) {
      return { applied: false, outcome: 'changed_since_preview', reason: 'the page changed since the preview' };
    }
  }
  const [stored] = await ctx.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [failed.id]);
  try { await authorizeStoredRequest(ctx.engine, stored); } catch (error) {
    if (error instanceof OperationError) return { applied: false, outcome: 'authority_revoked', reason: `${error.code}: ${error.message}` };
    throw error;
  }
  const prepared = await replayParams(lane, failed, attempt.id);
  if ('refused' in prepared) return prepared.refused;
  const { params } = prepared;
  try {
    if (live.operation === 'remember') await submitRememberMutation(lane, params);
    else await submitPageMutation(lane, { operation: live.operation, params });
  } catch (error) {
    if (error instanceof OperationError && !['write_pending', 'owner_unavailable', 'writer_lock_unavailable', 'writer_busy'].includes(error.code)) {
      return { applied: false, outcome: ['revision_conflict', 'revision_required'].includes(error.code) ? 'conflict' : 'refused', reason: `${error.code}: ${error.message}` };
    }
    throw error;
  }
  return { applied: true, outcome: 'replayed' };
}
