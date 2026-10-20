/**
 * #6712 PR 1: one managed cursor per source incarnation (and company approval), whoever runs the sync.
 *
 * The key used to digest the writer principal, its authority and the run's cursor-selecting options, so a CLI run, a
 * sync job, `sync --all` and a serve-delegated run of one source each held their own unfinished cursor and none could
 * resume another's (#5632, #6696). It is now `managedCursorKey(incarnation, company)`.
 *
 * `resolveManagedCursor` folds in the cursors written under an older key (a digest of the writer, its authority and the
 * options, before #6712 PR 1). It runs under the
 * drain lease, before the pass reads its cursor, and every write it makes checks the lease's fence:
 * - The incarnation's unfinished cursor under the current key wins; otherwise the newest unfinished one under an older
 *   key is adopted and finished in place, under its own key and frozen manifest. The requests it admitted name that
 *   key (`intent.cursorKey`) and the publication fence reads the row by it, so the row never moves and no admitted
 *   payload is rewritten. The next run after it finishes discovers under the current key.
 * - Every other unfinished cursor is superseded: its still-queued requests are cancelled (never one that started
 *   publishing or carries recovery), then it is retired through the orphan repair path (`retireManagedSyncOrphan`,
 *   reason `superseded_by_adoption`) with its failure row, and its manifest when no cursor shares it. A cursor with a
 *   running or recovering request, or a recovery row, under its key is left in place and the pass waits for it
 *   (`writer_pending`, `waitFor`) before it drains anything: recovery is never suppressed, and the adopted run never
 *   publishes a page beside a superseded run's in-flight write.
 * - A finished cursor under an older key is retired (a company brain keeps its finished cursors: each records the
 *   approval it synced).
 * Each step commits on its own and repeats safely. Only the lease holder writes cursors, so the newest unfinished cursor
 * stays the newest and a crash anywhere in the fan-in leaves a state the next pass folds the same way.
 */
import type { BrainEngine } from '../engine.ts';
import type { currentCompanyBrainSync } from '../company-brain/profile.ts';
import { digest } from './digest.ts';
import { completeWrite, lockCounters } from './journal.ts';
import { retireManagedSyncOrphan } from './managed-sync-orphans.ts';
import { isTerminal, principalKey, requestPrincipal, type WriteRequest } from './model.ts';
import { clearManagedSyncFailureAfterSuccess } from './sync-failures.ts';
import { assertDrainLease } from './sync-lease.ts';
import { faultPoint } from './fault-points.ts';
import { SYNC_SLICE_OP } from './sync-slices.ts';
import { passFingerprint } from './sync-pass-row.ts';

type CompanySync = ReturnType<typeof currentCompanyBrainSync>;

const companyPart = (company: CompanySync) => company ? { company: { receiptId: company.receiptId, planDigest: company.plan.plan_digest } } : {};

let keyForTests: ((incarnation: string) => string) | null = null;
/** Tests only: the key fresh cursors are written under, to build a cursor an older binary keyed differently. */
export function __setManagedCursorKeyForTests(key: ((incarnation: string) => string) | null): void { keyForTests = key; }

/** The key of the source incarnation's managed cursor (and of its company approval, on a company brain). */
export function managedCursorKey(incarnation: string, company: CompanySync): string {
  return keyForTests?.(incarnation) ?? digest({ source: incarnation, ...companyPart(company) });
}

/** #6712 PR 4b: where a pass records its stops (the pass row's key, and the incarnation's cursor key for discovery); a converged or idle pass clears both. */
export const passFailureKeys = (sourceId: string, incarnation: string) => [passFingerprint(sourceId, incarnation), managedCursorKey(incarnation, undefined)];

export const SUPERSEDED_BY_ADOPTION_MESSAGE = 'Another unfinished sync run of this source was adopted; this queued page of a superseded run was not published, and the adopted run (or the next sync) imports it.';

export interface CursorResolution {
  /** The key of the cursor this pass reads, resumes or creates. */
  key: string;
  /** Set when the pass finishes a cursor written under an older key, in place. */
  adoptedLegacyKey?: string;
  /** Older-key cursors retired by this pass, and those left for later because a request under them is still open. */
  superseded: string[];
  retained: string[];
  /** The first open request under a retained cursor: the pass waits for it to settle. */
  waitFor?: { request_id: string; kind: string | null; slug: string; state: string; recovery: boolean };
}

interface CursorRow { key: string; done: boolean; company_receipt_id: string | null; run_id: string | null }

/**
 * Picks the cursor a pass uses and folds in the others (module header). `readOnly` (a dry run) only picks; `foldIn: false`
 * (a remote caller) picks and finds what to wait for, but cancels and retires nothing.
 */
export async function resolveManagedCursor(engine: BrainEngine, input: { sourceId: string; incarnation: string; company: CompanySync; assertActive: () => void;
  readOnly?: boolean; foldIn?: boolean }): Promise<CursorResolution> {
  const { sourceId, incarnation, company, assertActive } = input;
  const canonical = managedCursorKey(incarnation, company);
  const rows = (await engine.executeRaw<CursorRow>(`SELECT fingerprint AS key, COALESCE(completed_keys->0->>'done','false')='true' AS done,
      completed_keys->0->>'companyReceiptId' AS company_receipt_id, completed_keys->0->>'runId' AS run_id
    FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'=$2
    ORDER BY updated_at DESC, fingerprint COLLATE "C"`, [sourceId, incarnation])).filter(row => (row.company_receipt_id ?? null) === (company?.receiptId ?? null));
  assertActive();
  const unfinished = rows.filter(row => !row.done);
  const winner = unfinished.find(row => row.key === canonical) ?? unfinished[0] ?? (company ? rows.find(row => row.key === canonical) ?? rows[0] : undefined);
  const key = winner?.key ?? canonical;
  const resolution: CursorResolution = { key, ...(key !== canonical ? { adoptedLegacyKey: key } : {}), superseded: [], retained: [] };
  const fence = (tx: BrainEngine) => assertDrainLease(tx, sourceId);
  for (const row of input.readOnly ? [] : rows) {
    if (row.key === key || row.key === canonical && row.done) continue;
    if (input.foldIn === false) {
      if (row.done) continue;
      const busy = await busyRequest(engine, input.sourceId, row.key);
      resolution.retained.push(row.key);
      if (busy) resolution.waitFor ??= waitOn(busy);
    } else if (row.done) {
      if (company) continue;
      await engine.transaction(async tx => {
        await fence(tx);
        await deleteFinishedCursor(tx, row.key);
      });
      await clearManagedSyncFailureAfterSuccess(engine, row.key);
    } else {
      const open = await supersede(engine, row, { sourceId, incarnation, fence });
      if (open === null) {
        resolution.superseded.push(row.key);
        await faultPoint('sync:cursor_adopted', { sourceId });
      } else {
        resolution.retained.push(row.key);
        // `kept`: a consumer claimed a request between the read and the retirement; wait for whatever is open now.
        const busy = open === 'kept' ? await busyRequest(engine, input.sourceId, row.key) : open;
        if (busy) resolution.waitFor ??= waitOn(busy);
      }
    }
    assertActive();
  }
  return resolution;
}

const waitOn = (request: WriteRequest): NonNullable<CursorResolution['waitFor']> => ({ request_id: request.request_id,
  kind: (request.intent as { kind?: string } | null)?.kind ?? null, slug: request.slug, state: request.state, recovery: !!request.recovery });

/** The first request under a cursor key that is not merely queued: running, recovering, publishing or carrying recovery. */
/**
 * #6712 PR 4b (design v3.2 §3.5): the live pass retires the incarnation's chosen cursor too (`resolveManagedCursor` keeps it
 * for a cursor pass): a finished one is deleted; an unfinished one is superseded like the others. Returns the open request
 * to wait for, or null once it is gone (or a consumer kept it with nothing open: the next pass retries).
 */
export async function retireManagedCursor(engine: BrainEngine, input: { sourceId: string; incarnation: string; key: string; runId: string | null; done: boolean }):
  Promise<NonNullable<CursorResolution['waitFor']> | null> {
  const fence = (tx: BrainEngine) => assertDrainLease(tx, input.sourceId);
  if (input.done) {
    await engine.transaction(async tx => {
      await fence(tx);
      await deleteFinishedCursor(tx, input.key);
      await deleteSliceRecords(tx, input.sourceId, input.incarnation);
    });
    await clearManagedSyncFailureAfterSuccess(engine, input.key);
    return null;
  }
  const open = await supersede(engine, { key: input.key, done: false, company_receipt_id: null, run_id: input.runId }, { sourceId: input.sourceId, incarnation: input.incarnation, fence });
  if (open === 'kept') {
    const busy = await busyRequest(engine, input.sourceId, input.key);
    return busy ? waitOn(busy) : null;
  }
  if (open) return waitOn(open);
  await engine.transaction(async tx => { await fence(tx); await deleteSliceRecords(tx, input.sourceId, input.incarnation); });
  return null;
}

/** #6712 PR 4b: an orphaned path-slice record, left with no cursor row beside it, goes on the incarnation's first pass too. */
export async function retireOrphanSliceRecords(engine: BrainEngine, sourceId: string, incarnation: string): Promise<void> {
  await engine.transaction(async tx => { await assertDrainLease(tx, sourceId); await deleteSliceRecords(tx, sourceId, incarnation); });
}

/** A finished cursor row and its frozen manifest, unless another cursor still names that run. */
async function deleteFinishedCursor(tx: BrainEngine, key: string): Promise<void> {
  const [row] = await tx.executeRaw<{ run_id: string | null }>(`DELETE FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1
    AND COALESCE(completed_keys->0->>'done','false')='true' RETURNING completed_keys->0->>'runId' AS run_id`, [key]);
  if (row?.run_id) await tx.executeRaw(`DELETE FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1
    AND NOT EXISTS (SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.completed_keys->0->>'runId'=$1)`, [row.run_id]);
}

/** The incarnation's path-slice records (sync-slices.ts): only a non-company cursor run cuts its target into slices. */
async function deleteSliceRecords(tx: BrainEngine, sourceId: string, incarnation: string): Promise<void> {
  const prefix = `${sourceId}:${incarnation}:`;
  await tx.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND left(fingerprint, length($2))=$2', [SYNC_SLICE_OP, prefix]);
}
async function busyRequest(engine: BrainEngine, sourceId: string, key: string): Promise<WriteRequest | null> {
  const open = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'cursorKey'=$2
    AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) ORDER BY sequence`, [sourceId, key]);
  return open.find(request => request.state !== 'queued' || request.recovery || request.publication_started) ?? null;
}

/**
 * Cancels the queued requests of a passed-over cursor, then retires it (null). While a request under it is running,
 * recovering or publishing, nothing is touched and that request is returned; `kept` when the retirement found it no
 * longer qualifies.
 */
async function supersede(engine: BrainEngine, row: CursorRow, input: { sourceId: string; incarnation: string; fence: (tx: BrainEngine) => Promise<void> }): Promise<WriteRequest | 'kept' | null> {
  const open = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'cursorKey'=$2
    AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) ORDER BY sequence`, [input.sourceId, row.key]);
  const busy = open.find(request => request.state !== 'queued' || request.recovery || request.publication_started);
  if (busy) return busy;
  // One row per transaction, as `cancelRows` does: holding several request rows at once deadlocks against claim renewals.
  for (const request of open) {
    await engine.transaction(async tx => {
      await lockCounters(tx, ['brain', principalKey(requestPrincipal(request)), ...(request.worktree_id ? [`worktree:${request.worktree_id}`] : [])]);
      await input.fence(tx);
      const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [request.id]);
      if (!current || isTerminal(current) || current.execution_token !== request.execution_token || current.publication_started || current.recovery) return;
      await completeWrite(tx, current, 'cancelled', {}, { code: 'cancelled', message: SUPERSEDED_BY_ADOPTION_MESSAGE, detail: { superseded_cursor: row.key } });
    });
  }
  const retired = await retireManagedSyncOrphan(engine, { kind: 'unfinished_cursor', cursor_key: row.key, run_id: row.run_id, source_id: input.sourceId,
    source_incarnation: input.incarnation, reason: 'superseded_by_adoption' }, input.fence);
  return retired.cursor ? null : 'kept';
}
