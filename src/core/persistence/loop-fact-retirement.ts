/**
 * Loop fact retirement (#5869): when a commitment loop closes, its projected
 * commitment fact is expired and its `## Facts` fence row struck, as one
 * coordinated publication on every brain (managed or not).
 *
 * `loops_close` used to expire the fact with raw SQL that `managed_writer_guard`
 * refuses on managed brains; the error was swallowed and the receipt said
 * `fact_expired: true`. It also never struck the fence row, so the database
 * row and the page diverged on unmanaged brains too. The retirement here is a
 * coordinator mutation (operation `loops_close`, intent `retire_loop_fact`),
 * following the `decide_proposal` and `relink_facts` precedent: the fact's
 * `expired_at`/`valid_until` and the struck fence row (a page publication of
 * the entity page) commit together or not at all. It is not a withdrawal: no
 * `fact_withdrawals` tombstone is written, so the same promise made again
 * later is stored normally.
 *
 * One rule, shared by `loops_close`, `gbrain repair loop-facts` and the doctor
 * check `loop_facts_drift`: a commitment fact is retired only when it belongs
 * to the loop's source (E26) and no other open loop references it (E8);
 * otherwise the loop closes and the fact stays active with the reason
 * `shared_with_open_loop`. Both conditions are re-checked under row locks in
 * the publication transaction.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { formatFenceDate, type ParsedFact } from '../facts-fence.ts';
import { strikeFenceRow } from '../facts/forget.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';

/** The coordinator operation: the MCP op the caller was granted, so remote grants authorize it unchanged. */
export const LOOP_FACT_RETIREMENT_OPERATION = 'loops_close';
export const LOOP_FACT_RETIREMENT_KIND = 'retire_loop_fact';

export interface LoopFactRetirement {
  fact_expired: boolean;
  retryable: boolean;
  reason?: string;
  fence_struck?: boolean;
}

interface LoopFactState {
  loop: { id: number; source_id: string; status: string; fact_id: number | null } | null;
  fact: { id: number; source_id: string; expired_at: string | null; row_num: number | null; source_markdown_slug: string | null; fact: string } | null;
  shared: boolean;
}

/** The loop, its fact and whether another open loop references that fact; `lock` takes row locks for the publication. */
export async function loopFactState(db: BrainEngine, loopId: number, lock = false): Promise<LoopFactState> {
  const suffix = lock ? ' FOR UPDATE' : '';
  const [loop] = await db.executeRaw<{ id: number; source_id: string; status: string; fact_id: number | null }>(
    `SELECT id, source_id, status, fact_id FROM open_loops WHERE id=$1${suffix}`, [loopId]);
  if (!loop || loop.fact_id === null) return { loop: loop ? { ...loop, id: Number(loop.id), fact_id: null } : null, fact: null, shared: false };
  const [fact] = await db.executeRaw<{ id: number; source_id: string; expired_at: string | null; row_num: number | null; source_markdown_slug: string | null; fact: string }>(
    `SELECT id, source_id, expired_at, row_num, source_markdown_slug, fact FROM facts WHERE id=$1${suffix}`, [loop.fact_id]);
  const others = await db.executeRaw(`SELECT 1 FROM open_loops WHERE fact_id=$1 AND id<>$2 AND status='open' LIMIT 1`, [loop.fact_id, loop.id]);
  return {
    loop: { ...loop, id: Number(loop.id), fact_id: Number(loop.fact_id) },
    fact: fact ? { ...fact, id: Number(fact.id), row_num: fact.row_num === null ? null : Number(fact.row_num),
      expired_at: fact.expired_at === null ? null : new Date(fact.expired_at).toISOString() } : null,
    shared: others.length > 0,
  };
}

/** Why the loop's fact is not retired now, or null when it should be. */
function heldReason(state: LoopFactState): 'loop_not_found' | 'no_fact' | 'fact_missing' | 'source_mismatch' | 'already_expired' | 'shared_with_open_loop' | 'loop_open' | null {
  if (!state.loop) return 'loop_not_found';
  if (state.loop.status !== 'done' && state.loop.status !== 'dropped') return 'loop_open';
  if (state.loop.fact_id === null) return 'no_fact';
  if (!state.fact) return 'fact_missing';
  if (state.fact.source_id !== state.loop.source_id) return 'source_mismatch';
  if (state.fact.expired_at !== null) return 'already_expired';
  if (state.shared) return 'shared_with_open_loop';
  return null;
}

const stateKey = (s: LoopFactState) => JSON.stringify([s.loop?.status, s.loop?.fact_id, s.fact?.source_id, s.fact?.expired_at, s.fact?.row_num, s.fact?.source_markdown_slug, s.shared]);

function retirementRefusal(code: 'invalid_params' | 'revision_conflict', message: string, row: WriteRequest, what: string): OperationError {
  return opError(code, message,
    `${what} Request ${row.request_id} on ${row.slug} in source ${row.source_id} did not retire the loop's commitment fact; nothing was published. Preview the remaining loop-fact drift; applying that preview (--apply --expect with its hash) is a separate step the user approves.`,
    { fix: readFix('Previews commitment facts still active for closed loops, without changing anything.', { argv: ['gbrain', 'repair', 'loop-facts', '--source', row.source_id, '--json'] }) });
}

/** A closed loop's fence row: struck, valid until today, with the close recorded in its context. */
function closedLoopRow(fact: ParsedFact, today: string, status: string): ParsedFact {
  const context = [`loop closed: ${status}`, fact.context?.trim()].filter(Boolean).join(' | ');
  const validUntil = fact.validUntil && /^\d{4}-\d{2}-\d{2}$/.test(fact.validUntil) && fact.validUntil < today ? fact.validUntil : today;
  return { ...fact, active: false, validUntil, context };
}

/** Coordinator preparer for intent `retire_loop_fact`. */
export async function prepareLoopFactRetirement(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const intent = row.intent as { kind?: string; loop_id?: number } | null;
  const loopId = Number(intent?.loop_id);
  if (row.operation !== LOOP_FACT_RETIREMENT_OPERATION || intent?.kind !== LOOP_FACT_RETIREMENT_KIND || !Number.isSafeInteger(loopId)) {
    throw retirementRefusal('invalid_params', 'Unsupported loop fact retirement intent.', row, 'The request does not carry a loop fact retirement intent.');
  }
  const state = await loopFactState(engine, loopId);
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  const observedRevision = snapshot?.revision ?? null;
  const held = state.loop && state.loop.source_id !== row.source_id ? 'loop_not_found' : heldReason(state);
  if (held) return { observedRevision, noop: true, apply: async () => ({ fact_expired: held === 'already_expired', retryable: false, reason: held }) };
  const fact = state.fact!;
  const struck = fact.row_num !== null && fact.source_markdown_slug === row.slug && snapshot
    ? strikeFenceRow(snapshot.page.compiled_truth, fact.row_num, f => closedLoopRow(f, formatFenceDate(new Date()), state.loop!.status)) : null;
  const page = struck !== null ? await (await import('./page-prepare.ts')).preparePageMutation(engine, { ...row, intent: {
    content: serializePageToMarkdown({ ...snapshot!.page, compiled_truth: struck }, snapshot!.tags), expected_revision: observedRevision, force: false,
  } }, config) : undefined;
  if (page && page.observedRevision !== observedRevision) throw retirementRefusal('revision_conflict', 'The fact page changed during preparation.', row, 'The entity page changed while the retirement was prepared.');
  const validate = async (tx: BrainEngine) => {
    if (stateKey(await loopFactState(tx, loopId, true)) !== stateKey(state)) {
      throw retirementRefusal('revision_conflict', 'The loop or its commitment fact changed during preparation.', row, `Loop ${loopId} or its commitment fact changed while the retirement was prepared.`);
    }
    await page?.validate?.(tx);
  };
  const apply = async (tx: BrainEngine): Promise<Record<string, unknown>> => {
    const expired = await tx.executeRaw(`UPDATE facts SET expired_at=now(), valid_until=LEAST(COALESCE(valid_until, now()), now())
      WHERE id=$1 AND source_id=$2 AND expired_at IS NULL RETURNING id`, [fact.id, fact.source_id]);
    if (expired.length !== 1) throw retirementRefusal('revision_conflict', 'The commitment fact changed during publication.', row, `Fact ${fact.id} changed during publication, so the transaction rolled back.`);
    const published = page ? await page.apply(tx) : {};
    return { ...published, fact_expired: true, retryable: false, fence_struck: page !== undefined, fact_id: fact.id, loop_id: loopId };
  };
  return page ? { ...page, validate, apply } : { observedRevision, validate, apply };
}

/**
 * Admit and wait for one loop's fact retirement. `ctx` is the caller's
 * context (its grant is the publication's authority). A refusal or a write
 * still pending returns `fact_expired: false, retryable: true` with the code.
 */
export async function retireLoopFact(ctx: OperationContext, loopId: number): Promise<LoopFactRetirement> {
  const engine = ctx.engine;
  const state = await loopFactState(engine, loopId);
  const held = heldReason(state);
  if (held) return { fact_expired: held === 'already_expired', retryable: false, reason: held };
  const fact = state.fact!;
  const sourceId = state.loop!.source_id;
  const { initializeLocalPersistence, requestPrincipalForContext } = await import('./page-mutations.ts');
  const { submissionAuthority } = await import('./authority.ts');
  const { admitWrite } = await import('./journal.ts');
  const { assertPersistenceAccepting, waitForWrite, writeResponse } = await import('./service.ts');
  const { resolveFactWriteTarget } = await import('./fact-write-target.ts');
  const config = ctx.config ?? ({ engine: engine.kind } as GBrainConfig);
  try {
    assertPersistenceAccepting(engine);
    const scoped = { ...ctx, sourceId } as OperationContext;
    await initializeLocalPersistence(scoped);
    const principal = await requestPrincipalForContext(scoped);
    const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; kind: string | null }>(
      "SELECT incarnation, archived, local_path, config->>'kind' AS kind FROM sources WHERE id=$1", [sourceId]);
    if (!source || source.archived) return { fact_expired: false, retryable: false, reason: 'source_changed' };
    const slug = fact.source_markdown_slug ?? 'memory/unattributed';
    const target = await resolveFactWriteTarget(engine, sourceId, source);
    if (target.kind === 'unbound') return { fact_expired: false, retryable: true, reason: 'owner_unavailable' };
    const authority = await submissionAuthority(scoped, LOOP_FACT_RETIREMENT_OPERATION, sourceId, source.incarnation, slug);
    if (target.databaseOnlyReason) authority.databaseOnlyReason = target.databaseOnlyReason;
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    const intent = { kind: LOOP_FACT_RETIREMENT_KIND, loop_id: loopId };
    const row = await admitWrite(engine, {
      principal, operation: LOOP_FACT_RETIREMENT_OPERATION, sourceId, sourceIncarnation: source.incarnation, slug, pageId: snapshot?.page.id ?? null,
      requestId: randomUUID(), callerIntent: intent, intent, authority,
      worktreeId: target.binding?.worktree_id ?? null, topologyGeneration: target.binding?.topology_generation ?? null,
    });
    const finished = await waitForWrite(engine, row, config, 30_000);
    writeResponse(finished);
    const out = finished.outcome as unknown as LoopFactRetirement;
    return { fact_expired: out.fact_expired === true, retryable: false, ...(out.reason ? { reason: out.reason } : {}),
      ...(out.fence_struck !== undefined ? { fence_struck: out.fence_struck } : {}) };
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return { fact_expired: false, retryable: true, reason: error.code };
  }
}

/**
 * Closed loops whose commitment fact is still active and retirable under the
 * shared rule (same source, no other open loop references it): what
 * `loop_facts_drift` counts and `repair loop-facts` retires, in id order.
 */
export async function loopFactDrift(db: BrainEngine, sourceIds: string[], loopId?: number): Promise<Array<{ loop_id: number; source_id: string; fact_id: number; status: string; slug: string | null }>> {
  const rows = await db.executeRaw<{ loop_id: number; source_id: string; fact_id: number; status: string; slug: string | null }>(
    `SELECT l.id AS loop_id, l.source_id, l.fact_id, l.status, f.source_markdown_slug AS slug
       FROM open_loops l JOIN facts f ON f.id=l.fact_id AND f.source_id=l.source_id
      WHERE l.source_id=ANY($1::text[]) AND l.status IN ('done','dropped') AND f.expired_at IS NULL
        AND ($2::bigint IS NULL OR l.id=$2::bigint)
        AND NOT EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=l.fact_id AND o.status='open')
      ORDER BY l.id`, [sourceIds, loopId ?? null]);
  return rows.map(r => ({ ...r, loop_id: Number(r.loop_id), fact_id: Number(r.fact_id) }));
}

/** A loop already closed whose commitment fact is still active (the retry path of `loops_close`); `sourceId` null is unscoped. */
export async function closedLoopWithActiveFact(db: BrainEngine, sourceId: string | null, loopId: number): Promise<{ id: number; status: string; fact_id: number } | null> {
  const [row] = await db.executeRaw<{ id: number; status: string; fact_id: number }>(
    `SELECT l.id, l.status, l.fact_id FROM open_loops l JOIN facts f ON f.id=l.fact_id
      WHERE l.id=$1 AND ($2::text IS NULL OR l.source_id=$2) AND l.status IN ('done','dropped') AND f.expired_at IS NULL`, [loopId, sourceId]);
  return row ? { id: Number(row.id), status: row.status, fact_id: Number(row.fact_id) } : null;
}
