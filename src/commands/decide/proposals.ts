/**
 * `gbrain decide sweep --slot conflict` and `gbrain decide proposals` (S9).
 *
 * sweep: runs the conflict sweep on demand for one source (--source) or every
 * active source, and prints duplicates, proposals written, independents and
 * skipped facts. proposals: list shows both facts' text (local only; receipts
 * never carry text); accept / reject take one id or --all-from <sweep id>;
 * undo reverses an accepted proposal with a revision check. Review-lane
 * proposals (ids `r<n>`: withdraw, duplicate_page, duplicate_entity) list and
 * act here too; accepting a withdraw is permanent, so it needs --yes, and
 * --all-from includes withdraws only with --include-withdrawals. Local CLI only
 * (the decide command table refuses thin clients; decide is not an MCP op).
 */
import type { BrainEngine } from '../../core/engine.ts';
import { refusalLine } from '../../core/ai/decide/outcomes.ts';
import { PROPOSAL_STATUSES, listProposals, proposalIdsFromSweep, type ProposalStatus } from '../../core/ai/decide/proposals-store.ts';
import { runConflictSweep, type ConflictSweepResult } from '../../core/ai/decide/sweep.ts';
import { applyProposalAction, rejectProposal, type ProposalActionResult } from '../../core/facts/proposal-supersede.ts';
import { listReviewProposals, reviewProposalIdsFromSweep, runReviewLanes, REVIEW_PROPOSAL_STATUSES, type ReviewLaneResult, type ReviewProposalRow } from '../../core/ai/decide/review-lane.ts';
import { acceptReviewProposal, rejectReviewProposal, undoReviewProposal, type ReviewActionResult } from '../../core/facts/proposal-review.ts';
import { flagValue } from '../decide.ts';
import { isConsentRefusal, printConsentRefusal, requireConsent } from '../../core/consent.ts';

function sweepLine(r: ConflictSweepResult): string {
  if (r.mode === 'off') return `${r.source_id}: the contradiction slot is off; nothing was swept (turn it on: gbrain decide enable conflict).`;
  if (r.effective === 'off') return `${r.source_id}: conflict sweep did not run. ${refusalLine(r.inactive ?? 'no_provider', 'conflict')}`;
  if (r.first_run) return `${r.source_id}: first sweep; watermark set to fact ${r.watermark.to}. Facts written from now on are swept (use --since <fact id> to sweep earlier facts).`;
  const shadow = r.effective === 'shadow' ? ` (shadow: ${r.shadow_proposals} would-be proposals, none written)` : '';
  return `${r.source_id}: swept ${r.facts} fact(s) in sweep ${r.sweep_id}: ${r.duplicates} duplicate(s), ${r.proposals} proposal(s) written, `
    + `${r.independents} independent, ${r.skipped} skipped (${r.deferred} deferred for retry)${shadow}; watermark ${r.watermark.from ?? '-'} -> ${r.watermark.to ?? '-'}`
    + `${r.stopped ? `; stopped early: ${r.stopped}` : ''}`;
}

export async function runSweepCommand(engine: BrainEngine, args: string[]): Promise<number> {
  const json = args.includes('--json');
  if (flagValue(args, '--slot') !== 'conflict') { console.error('Usage: gbrain decide sweep --slot conflict [--since <fact id>] [--source <id>] [--json]'); return 1; }
  const sinceRaw = flagValue(args, '--since');
  if (sinceRaw !== undefined && !/^\d+$/.test(sinceRaw)) { console.error('--since takes a fact id (a non-negative integer)'); return 1; }
  const source = flagValue(args, '--source');
  const sources = source ? [source] : (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE NOT archived ORDER BY id')).map((r) => r.id);
  const results: ConflictSweepResult[] = [];
  const reviews: ReviewLaneResult[] = [];
  for (const sourceId of sources) {
    const r = await runConflictSweep(engine, { sourceId, ...(sinceRaw !== undefined ? { since: Number(sinceRaw) } : {}) });
    results.push(r);
    if (r.effective !== 'off') reviews.push(...(await runReviewLanes(engine, sourceId) ?? []));
  }
  if (json) { console.log(JSON.stringify({ sweeps: results, reviews }, null, 2)); return 0; }
  for (const r of results) console.log(sweepLine(r));
  for (const r of reviews) console.log(reviewLine(r));
  if (results.some((r) => r.proposals > 0) || reviews.some((r) => r.proposals > 0)) console.log('Review: gbrain decide proposals list');
  return results.every((r) => r.effective === 'off') ? 1 : 0;
}

function reviewLine(r: ReviewLaneResult): string {
  if (r.effective === 'off') return `${r.source_id}: ${r.kind} review did not run (${r.inactive ?? 'off'}).${r.inactive === 'no_qualification' ? ` Qualify it: gbrain decide calibrate --slot conflict --call-site review_${r.kind} --dataset <jsonl>, then gbrain decide qualify --slot conflict --call-site review_${r.kind} --dataset <jsonl>` : ''}`;
  const shadow = r.effective === 'shadow' ? ` (shadow: ${r.shadow_proposals} would-be proposals, none written)` : '';
  return `${r.source_id}: ${r.kind} review ${r.sweep_id}: ${r.anchors} item(s), ${r.pairs} pair(s) judged, ${r.proposals} proposal(s) written, `
    + `${r.independents} not the same, ${r.skipped} skipped (${r.deferred} deferred)${shadow}${r.stopped ? `; stopped early: ${r.stopped}` : ''}`;
}

function reviewRowLines(r: ReviewProposalRow, text: Map<string, string>): string[] {
  if (r.kind === 'withdraw') {
    return [`r${r.id} [${r.status}] WITHDRAW ${r.subject === '*' ? '(no entity)' : r.subject} review ${r.sweep_id} p(same claim) ${r.p_action.toFixed(3)} DURABLE: cannot be undone`,
      `  withdrawn #${r.a_ref}: ${text.get(r.a_ref) ?? '(fact missing)'}`,
      `  would also withdraw #${r.b_ref}: ${text.get(r.b_ref) ?? '(fact missing)'}`];
  }
  return [`r${r.id} [${r.status}] ${r.kind.toUpperCase()} review ${r.sweep_id} p(same) ${r.p_action.toFixed(3)}`, `  ${r.a_ref}  <->  ${r.b_ref}`];
}

function reviewResultLine(r: ReviewActionResult): string {
  if (r.status === 'not_found') return `proposal ${r.id}: not found`;
  if (r.status === 'refused') return `proposal ${r.id}: ${r.action} refused (${r.reason})${r.fix ? `. ${r.fix}` : ''}`;
  if (r.status === 'stale') return `proposal ${r.id}: stale (${r.reason}); nothing was changed`;
  if (r.status === 'accepted') return `proposal ${r.id}: accepted`;
  if (r.status === 'accepted_no_action') return `proposal ${r.id}: accepted (${r.reason})`;
  return `proposal ${r.id}: rejected`;
}

function resultLine(r: ProposalActionResult): string {
  if (r.status === 'not_found') return `proposal ${r.id}: not found`;
  if (r.status === 'refused') return `proposal ${r.id}: ${r.action} refused (${r.reason})`;
  if (r.status === 'stale') return `proposal ${r.id}: stale (${r.reason}); nothing was changed`;
  if (r.status === 'accepted') return `proposal ${r.id}: accepted; the old fact is superseded. Reverse with: gbrain decide proposals undo ${r.id}`;
  if (r.status === 'undone') return `proposal ${r.id}: undone; the old fact and its fence row are restored`;
  return `proposal ${r.id}: rejected`;
}

async function listCommand(engine: BrainEngine, args: string[]): Promise<number> {
  const status = (flagValue(args, '--status') ?? 'pending') as ProposalStatus | 'all';
  if (status !== 'all' && !(PROPOSAL_STATUSES as readonly string[]).includes(status)) { console.error(`--status must be one of ${PROPOSAL_STATUSES.join(', ')}, all`); return 1; }
  const rows = await listProposals(engine, { status });
  const review = (REVIEW_PROPOSAL_STATUSES as readonly string[]).includes(status) || status === 'all' ? await listReviewProposals(engine, { status }) : [];
  if (args.includes('--json')) {
    console.log(JSON.stringify({ status, proposals: rows.map(({ before_state: _b, after_state: _a, ...r }) => r),
      review_proposals: review.map(r => ({ ...r, id: `r${r.id}`, reversible: r.kind !== 'withdraw' })) }, null, 2));
    return 0;
  }
  if (rows.length === 0 && review.length === 0) { console.log(`No ${status === 'all' ? '' : `${status} `}proposals.`); return 0; }
  const factIds = [...new Set(review.filter(r => r.kind === 'withdraw').flatMap(r => [Number(r.a_ref), Number(r.b_ref)]))];
  const text = new Map((factIds.length ? await engine.executeRaw<{ id: number | string; fact: string }>('SELECT id, fact FROM facts WHERE id = ANY($1::bigint[])', [factIds]) : [])
    .map(f => [String(Number(f.id)), f.fact] as [string, string]));
  for (const r of review) for (const line of reviewRowLines(r, text)) console.log(line);
  for (const r of rows) {
    console.log(`#${r.id} [${r.status}] ${r.entity_slug ?? '(no entity)'} sweep ${r.sweep_id} p(supersede) ${r.p_supersede.toFixed(3)} (floor ${r.proposal_floor.toFixed(2)}, ${r.direction})`);
    console.log(`  new #${r.new_fact_id}: ${r.new_fact ?? '(fact missing)'}`);
    console.log(`  old #${r.old_fact_id}: ${r.old_fact ?? '(fact missing)'}`);
  }
  if (status === 'pending') console.log('Accept: gbrain decide proposals accept <id> | reject: gbrain decide proposals reject <id> | undo after accept: gbrain decide proposals undo <id>');
  if (status === 'pending' && review.some(r => r.kind === 'withdraw')) {
    console.log('WITHDRAW rows are permanent once accepted (the withdrawal ledger has no undo). These are owner decisions: an agent shows them to the user and accepts only what the user confirms. Accept: gbrain decide proposals accept r<id> --yes');
  }
  return 0;
}

async function reviewActionCommand(engine: BrainEngine, action: 'accept' | 'reject' | 'undo', ids: number[], args: string[], bulk: boolean): Promise<{ results: ReviewActionResult[]; refusedForConfirmation: boolean }> {
  const results: ReviewActionResult[] = [];
  if (action === 'accept') {
    const rows = (await listReviewProposals(engine, { status: 'all' })).filter(r => ids.includes(r.id) && r.kind === 'withdraw' && r.status === 'pending');
    if (rows.length) {
      const facts = rows.map(r => `#${r.b_ref}`).join(', ');
      try {
        await requireConsent({
          command: 'decide proposals accept', effects: ['destructive'], actor: 'user',
          what: `Permanently withdraw ${rows.length} fact(s) (${facts})`,
          why: 'The overnight review judged each to restate a claim the user already forgot.',
          risk: 'The withdrawal ledger has no undo; a wrong acceptance hides a true fact until the user remembers a corrected wording.',
          user_message: `Withdraw ${facts} as rewordings of claims you already forgot? This cannot be undone.`,
          argv: ['gbrain', 'decide', 'proposals', 'accept', ...(bulk ? ['--all-from', flagValue(args, '--all-from') ?? '', '--include-withdrawals'] : [`r${rows[0]!.id}`]), '--yes'],
          args,
        });
      } catch (e) {
        if (!isConsentRefusal(e)) throw e;
        printConsentRefusal(e, { json: args.includes('--json') });
        return { results, refusedForConfirmation: true };
      }
    }
  }
  for (const id of ids) {
    try {
      results.push(action === 'accept' ? await acceptReviewProposal(engine, id) : action === 'reject' ? await rejectReviewProposal(engine, id) : await undoReviewProposal(engine, id));
    } catch (err) {
      results.push({ id: `r${id}`, action, status: 'refused', reason: `write_failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { results, refusedForConfirmation: false };
}

async function actionCommand(engine: BrainEngine, action: 'accept' | 'reject' | 'undo', args: string[]): Promise<number> {
  const json = args.includes('--json');
  const sweep = flagValue(args, '--all-from');
  const reviewArg = args.find((a) => /^r\d+$/i.test(a));
  if (reviewArg && !sweep) {
    const { results, refusedForConfirmation } = await reviewActionCommand(engine, action, [Number(reviewArg.slice(1))], args, false);
    if (refusedForConfirmation) return 1;
    if (json) console.log(JSON.stringify({ action, results }, null, 2)); else for (const r of results) console.log(reviewResultLine(r));
    return results.every((r) => ['accepted', 'accepted_no_action', 'rejected', 'stale'].includes(r.status)) ? 0 : 1;
  }
  const idArg = args.find((a) => /^\d+$/.test(a));
  if (action === 'undo' && sweep) { console.error('undo takes one proposal id'); return 1; }
  if (!sweep && !idArg) { console.error(`Usage: gbrain decide proposals ${action} <id>${action === 'undo' ? '' : ' | --all-from <sweep id>'}`); return 1; }
  const ids = sweep ? await proposalIdsFromSweep(engine, sweep, 'pending') : [Number(idArg)];
  const reviewIds = sweep && action !== 'undo' ? await reviewProposalIdsFromSweep(engine, sweep, { includeWithdrawals: args.includes('--include-withdrawals') }) : [];
  const review = reviewIds.length ? await reviewActionCommand(engine, action, reviewIds, args, true) : { results: [], refusedForConfirmation: false };
  if (review.refusedForConfirmation) return 1;
  const results: ProposalActionResult[] = [];
  for (const id of ids) {
    try {
      results.push(action === 'reject' ? await rejectProposal(engine, id) : await applyProposalAction(engine, id, action));
    } catch (err) {
      results.push({ id, action, status: 'refused', reason: `write_failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  if (json) console.log(JSON.stringify({ action, results, review_results: review.results }, null, 2));
  else if (results.length === 0 && review.results.length === 0) console.log(`No pending proposals in sweep ${sweep}.`);
  else { for (const r of results) console.log(resultLine(r)); for (const r of review.results) console.log(reviewResultLine(r)); }
  const ok = { accept: 'accepted', reject: 'rejected', undo: 'undone' }[action];
  return results.every((r) => r.status === ok || r.status === 'stale')
    && review.results.every((r) => ['accepted', 'accepted_no_action', 'rejected', 'stale'].includes(r.status)) ? 0 : 1;
}

export async function runProposalsCommand(engine: BrainEngine, args: string[]): Promise<number> {
  const sub = args[0] ?? 'list';
  if (sub === 'list') return listCommand(engine, args.slice(1));
  if (sub === 'accept' || sub === 'reject' || sub === 'undo') return actionCommand(engine, sub, args.slice(1));
  console.error('Usage: gbrain decide proposals list [--status <status>|all] [--json] | accept <id>|r<id> [--yes]|--all-from <sweep id> [--include-withdrawals --yes] | reject <id>|r<id>|--all-from <sweep id> | undo <id>|r<id>');
  return 1;
}
