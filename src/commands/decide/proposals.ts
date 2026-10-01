/**
 * `gbrain decide sweep --slot conflict` and `gbrain decide proposals` (S9).
 *
 * sweep: runs the conflict sweep on demand for one source (--source) or every
 * active source, and prints duplicates, proposals written, independents and
 * skipped facts. proposals: list shows both facts' text (local only; receipts
 * never carry text); accept / reject take one id or --all-from <sweep id>;
 * undo reverses an accepted proposal with a revision check. Local CLI only
 * (the decide command table refuses thin clients; decide is not an MCP op).
 */
import type { BrainEngine } from '../../core/engine.ts';
import { refusalLine } from '../../core/ai/decide/outcomes.ts';
import { PROPOSAL_STATUSES, listProposals, proposalIdsFromSweep, type ProposalStatus } from '../../core/ai/decide/proposals-store.ts';
import { runConflictSweep, type ConflictSweepResult } from '../../core/ai/decide/sweep.ts';
import { applyProposalAction, rejectProposal, type ProposalActionResult } from '../../core/facts/proposal-supersede.ts';
import { flagValue } from '../decide.ts';

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
  for (const sourceId of sources) results.push(await runConflictSweep(engine, { sourceId, ...(sinceRaw !== undefined ? { since: Number(sinceRaw) } : {}) }));
  if (json) { console.log(JSON.stringify({ sweeps: results }, null, 2)); return 0; }
  for (const r of results) console.log(sweepLine(r));
  if (results.some((r) => r.proposals > 0)) console.log('Review: gbrain decide proposals list');
  return results.every((r) => r.effective === 'off') ? 1 : 0;
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
  if (args.includes('--json')) {
    console.log(JSON.stringify({ status, proposals: rows.map(({ before_state: _b, after_state: _a, ...r }) => r) }, null, 2));
    return 0;
  }
  if (rows.length === 0) { console.log(`No ${status === 'all' ? '' : `${status} `}proposals.`); return 0; }
  for (const r of rows) {
    console.log(`#${r.id} [${r.status}] ${r.entity_slug ?? '(no entity)'} sweep ${r.sweep_id} p(supersede) ${r.p_supersede.toFixed(3)} (floor ${r.proposal_floor.toFixed(2)}, ${r.direction})`);
    console.log(`  new #${r.new_fact_id}: ${r.new_fact ?? '(fact missing)'}`);
    console.log(`  old #${r.old_fact_id}: ${r.old_fact ?? '(fact missing)'}`);
  }
  if (status === 'pending') console.log('Accept: gbrain decide proposals accept <id> | reject: gbrain decide proposals reject <id> | undo after accept: gbrain decide proposals undo <id>');
  return 0;
}

async function actionCommand(engine: BrainEngine, action: 'accept' | 'reject' | 'undo', args: string[]): Promise<number> {
  const json = args.includes('--json');
  const sweep = flagValue(args, '--all-from');
  const idArg = args.find((a) => /^\d+$/.test(a));
  if (action === 'undo' && sweep) { console.error('undo takes one proposal id'); return 1; }
  if (!sweep && !idArg) { console.error(`Usage: gbrain decide proposals ${action} <id>${action === 'undo' ? '' : ' | --all-from <sweep id>'}`); return 1; }
  const ids = sweep ? await proposalIdsFromSweep(engine, sweep, 'pending') : [Number(idArg)];
  const results: ProposalActionResult[] = [];
  for (const id of ids) {
    try {
      results.push(action === 'reject' ? await rejectProposal(engine, id) : await applyProposalAction(engine, id, action));
    } catch (err) {
      results.push({ id, action, status: 'refused', reason: `write_failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  if (json) console.log(JSON.stringify({ action, results }, null, 2));
  else if (results.length === 0) console.log(`No pending proposals in sweep ${sweep}.`);
  else for (const r of results) console.log(resultLine(r));
  const ok = { accept: 'accepted', reject: 'rejected', undo: 'undone' }[action];
  return results.every((r) => r.status === ok || r.status === 'stale') ? 0 : 1;
}

export async function runProposalsCommand(engine: BrainEngine, args: string[]): Promise<number> {
  const sub = args[0] ?? 'list';
  if (sub === 'list') return listCommand(engine, args.slice(1));
  if (sub === 'accept' || sub === 'reject' || sub === 'undo') return actionCommand(engine, sub, args.slice(1));
  console.error('Usage: gbrain decide proposals list [--status <status>|all] [--json] | accept <id>|--all-from <sweep id> | reject <id>|--all-from <sweep id> | undo <id>');
  return 1;
}
