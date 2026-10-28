/**
 * gbrain decide sweep --claims: the keyless claim-conflict lane on demand
 * (facts/claim-conflicts.ts). Its own lane: no --slot, no TypeSafe key, and it runs
 * whether or not dream.claim_conflicts.mode is on. --dry-run previews the pairs and
 * writes nothing; --source sweeps one active source (an unknown or archived
 * one is refused before anything runs). Text and --json carry the same
 * completion status; exit 0 when the run completed or was partial.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { opError } from '../../core/ops/contract.ts';
import { runClaimConflicts, type ClaimConflictPair } from '../../core/facts/claim-conflicts.ts';
import { writeCliError } from '../../cli/cli-error.ts';
import { flagValue } from '../decide.ts';

const USAGE = 'Usage: gbrain decide sweep --claims [--source <id>] [--dry-run] [--json]';

function pairLine(sourceId: string, p: ClaimConflictPair, dryRun: boolean): string {
  const slot = [p.claim_metric, p.claim_unit, p.claim_period].filter(Boolean).join(' ');
  return '  ' + sourceId + ' ' + p.entity_slug + ' ' + slot + ' (' + p.bucket + '): f' + p.new_fact_id + ' = ' + p.new_value
    + (dryRun ? ' would supersede ' : ' proposed to supersede ') + 'f' + p.old_fact_id + ' = ' + p.old_value;
}

export async function runClaimsSweepCommand(engine: BrainEngine, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const source = flagValue(args, '--source');
  if (args.includes('--slot') || args.includes('--since') || (args.includes('--source') && !source)) { console.error(USAGE); return 1; }
  if (source) {
    const [row] = await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id = $1', [source]);
    if (!row || row.archived) {
      return writeCliError(opError('unknown_source', 'Source ' + source + ' is ' + (row ? 'archived' : 'not registered') + '; nothing was swept and nothing was written.',
        'Pass an active source id, or omit --source to sweep every active source.',
        { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', why: 'Lists the source ids, read-only.', requires_exclusive: false } }), 'decide', { json });
    }
  }
  const run = await runClaimConflicts(engine, { ...(source ? { sourceIds: [source] } : {}), dryRun });
  if (json) {
    console.log(JSON.stringify({ lane: 'claims', ...run }, null, 2));
  } else {
    console.log('claim conflicts ' + run.sweep_id + ': ' + run.status + ' (' + run.detail + ')');
    for (const s of run.sources) for (const p of s.pairs) console.log(pairLine(s.source_id, p, run.dry_run));
    for (const w of run.warnings) console.log('warning: ' + w);
    if (run.proposals_written > 0) console.log('Review: gbrain trust review --kind contradiction');
  }
  return run.status === 'failed' ? 1 : 0;
}
