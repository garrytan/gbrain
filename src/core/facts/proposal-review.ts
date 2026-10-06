/**
 * Owner actions on ambiguous-band review proposals (`gbrain decide proposals`).
 *
 * withdraw: accepting re-checks that the anchor is still withdrawn and the
 * candidate is still active with unchanged text, then withdraws the candidate
 * through the ordinary `forget` operation (same fence strike, ledger row and
 * page invalidation as a manual forget) with a request id derived from the
 * proposal, so a crash between the forget and the status change replays the
 * same withdrawal instead of making a second one. The withdrawal ledger is
 * durable, so there is no undo. duplicate kinds: accepting runs the handler the
 * owning subsystem registered, or records the owner's verdict when none is.
 * Accept claims the proposal (`pending` -> `accepting`) before acting, so a
 * concurrent reject refuses; an `accepting` proposal (a concurrent or crashed
 * accept) resumes, and only one accept records the outcome.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { loadConfig } from '../config.ts';
import {
  getReviewProposal, reviewAcceptHandler, transitionReviewProposal, type ReviewProposalRow,
} from '../ai/decide/review-lane.ts';

export interface ReviewActionResult {
  id: string;
  action: 'accept' | 'reject' | 'undo';
  status: 'accepted' | 'accepted_no_action' | 'rejected' | 'stale' | 'refused' | 'not_found';
  reason?: string;
  fix?: string;
}

/** Deterministic UUID (v4 layout) for the forget a withdraw proposal performs. */
export function reviewRequestId(id: number): string {
  const h = createHash('sha256').update(`decide-review:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function staleReason(engine: BrainEngine, p: ReviewProposalRow): Promise<string | null> {
  if (p.kind !== 'withdraw') return null;
  const [anchor] = await engine.executeRaw<{ withdrawn: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = f.source_id AND w.visibility = f.visibility
        AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact))
        AND (w.subject = '*' OR w.subject = COALESCE(f.entity_slug, '*'))) AS withdrawn
       FROM facts f WHERE f.id = $1 AND f.source_id = $2`, [Number(p.a_ref), p.source_id]);
  if (!anchor?.withdrawn) return 'the withdrawn claim is no longer withdrawn';
  const [candidate] = await engine.executeRaw<{ active: boolean; text_hash: string }>(
    `SELECT (expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())) AS active, md5(fact) AS text_hash
       FROM facts WHERE id = $1 AND source_id = $2`, [Number(p.b_ref), p.source_id]);
  if (!candidate?.active) return 'the affected fact is no longer active';
  let expected: string | null = null;
  try { expected = (JSON.parse(p.receipt ?? '{}') as { candidate_hash?: string | null }).candidate_hash ?? null; } catch { expected = null; }
  if (expected && expected !== candidate.text_hash) return 'the affected fact changed since it was reviewed';
  return null;
}

export async function acceptReviewProposal(engine: BrainEngine, id: number): Promise<ReviewActionResult> {
  const ref = `r${id}`;
  let p = await getReviewProposal(engine, id);
  if (!p) return { id: ref, action: 'accept', status: 'not_found' };
  // Claim first so a concurrent reject loses cleanly; an 'accepting' row (a concurrent or crashed accept) resumes.
  if (p.status === 'pending' && !(await transitionReviewProposal(engine, id, 'pending', 'accepting'))) p = (await getReviewProposal(engine, id))!;
  else if (p.status === 'pending') p = { ...p, status: 'accepting' };
  if (p.status !== 'accepting') return { id: ref, action: 'accept', status: 'refused', reason: `proposal is ${p.status}` };
  const finish = async (status: 'accepted' | 'accepted_no_action' | 'stale', reason?: string): Promise<ReviewActionResult> => {
    if (!(await transitionReviewProposal(engine, id, 'accepting', status))) {
      const now = await getReviewProposal(engine, id);
      return { id: ref, action: 'accept', status: 'refused', reason: `proposal is ${now?.status ?? 'gone'}` };
    }
    return { id: ref, action: 'accept', status, ...(reason ? { reason } : {}) };
  };
  if (p.kind !== 'withdraw') {
    const handler = reviewAcceptHandler(p.kind);
    if (!handler) return finish('accepted_no_action', 'verdict recorded; no merge or link handler is registered in this build');
    const out = await handler(engine, p);
    return finish(out.status, out.detail);
  }
  // A previous accept that withdrew the fact but stopped before the status change: finish it.
  const [done] = await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE id = $1 AND source_id = $2 AND expired_at IS NOT NULL
      AND strpos(COALESCE(context, ''), $3) > 0`, [Number(p.b_ref), p.source_id, `(review r${id})`]);
  if (done) return finish('accepted');
  const stale = await staleReason(engine, p);
  if (stale) return finish('stale', stale);
  const { submitForgetMutation } = await import('../persistence/memory-mutations.ts');
  const { runMemoryWrite } = await import('../persistence/verb-errors.ts');
  await runMemoryWrite(() => submitForgetMutation({
    engine, config: loadConfig() ?? { engine: 'pglite' }, remote: false, dryRun: false, sourceId: p.source_id,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never, 'forget', { id: p.b_ref, request_id: reviewRequestId(id), semantic_review: false,
    reason: `paraphrase of withdrawn fact #${p.a_ref} (review r${id})` }));
  return finish('accepted');
}

export async function rejectReviewProposal(engine: BrainEngine, id: number): Promise<ReviewActionResult> {
  const ref = `r${id}`;
  const p = await getReviewProposal(engine, id);
  if (!p) return { id: ref, action: 'reject', status: 'not_found' };
  if (!(await transitionReviewProposal(engine, id, 'pending', 'rejected'))) return { id: ref, action: 'reject', status: 'refused', reason: `proposal is ${p.status}` };
  return { id: ref, action: 'reject', status: 'rejected' };
}

export async function undoReviewProposal(engine: BrainEngine, id: number): Promise<ReviewActionResult> {
  const ref = `r${id}`;
  const p = await getReviewProposal(engine, id);
  if (!p) return { id: ref, action: 'undo', status: 'not_found' };
  if (p.kind === 'withdraw') {
    return { id: ref, action: 'undo', status: 'refused', reason: 'withdrawal_is_durable',
      fix: 'The withdrawal ledger is durable by design. To state the claim again, remember a corrected wording with new provenance (gbrain remember "<corrected claim>" --provenance "<source>").' };
  }
  return { id: ref, action: 'undo', status: 'refused', reason: 'undo_unsupported', fix: 'Duplicate verdicts have no undo here; reverse the merge or link with the subsystem that applied it.' };
}
