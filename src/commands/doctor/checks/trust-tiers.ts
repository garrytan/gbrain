/**
 * trust_tiers (#5575, A8/DX-5): stored trust tier counts per table (facts,
 * takes, timeline entries, pages) and the share still `unknown`. Warns while
 * the deterministic backfill has never completed (or was interrupted) and
 * unknown rows remain, with `fix.next: run` naming `gbrain trust backfill`.
 * After a complete backfill, rows no signal could classify stay `unknown`
 * and the check is ok with the percentage. A brain before the trust
 * migration is ok (tiers arrive with it). Read-only.
 *
 * CEO-24 diagnostic (never changes the status): the share of derived rows
 * (`write_origin` carries `taint_inputs`) stamped external_untrusted.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { readTrustBackfillState, readTrustTierCounts } from '../../../core/trust/backfill.ts';
import { TRUST_TIERS } from '../../../core/trust/tier.ts';
import { readDerivedTaintShare } from '../../../core/trust/taint.ts';
import { isUndefinedColumnError } from '../../../core/utils.ts';


async function runTrustTiers(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  try {
    const tables = await readTrustTierCounts(engine);
    const totals = Object.fromEntries(TRUST_TIERS.map(tier => [tier, tables.reduce((n, t) => n + t.counts[tier], 0)]));
    const rows = tables.reduce((n, t) => n + t.rows, 0);
    const unknownPct = rows === 0 ? 0 : Math.round((totals.unknown / rows) * 10_000) / 100;
    const state = await readTrustBackfillState(engine);
    const derived = await readDerivedTaintShare(engine);
    const details = { rows, by_tier: totals, unknown_pct: unknownPct, tables: tables.map(t => ({ table: t.table, rows: t.rows, by_tier: t.counts })),
      backfill: { interrupted: state.interrupted, completed_at: state.completedAt }, derived };
    const derivedNote = derived.rows ? ` Derived rows: ${derived.external_pct}% of ${derived.rows} carry an external, untrusted tier (diagnostic).` : '';
    const needsBackfill = totals.unknown > 0 && (state.interrupted || !state.completedAt);
    if (!needsBackfill) {
      checks.push({ name: 'trust_tiers', status: 'ok', details,
        message: rows === 0 ? 'No facts, takes, timeline entries or pages yet.'
          : `${unknownPct}% of ${rows} row(s) have an unverified origin (unknown tier)${state.completedAt ? '; the backfill has classified every row it has a signal for' : ''}.${derivedNote}` });
      return checks;
    }
    const argv = state.interrupted ? ['gbrain', 'trust', 'backfill', '--resume'] : ['gbrain', 'trust', 'backfill'];
    checks.push({ name: 'trust_tiers', status: 'warn', details,
      message: `${totals.unknown} of ${rows} row(s) (${unknownPct}%) have an unverified origin and the trust backfill has ${state.interrupted ? 'not finished' : 'not run'}. `
        + `Run ${argv.join(' ')} on the brain host (gbrain trust backfill --dry-run previews it); it classifies rows from deterministic signals only and never marks anything confirmed.${derivedNote}`,
      fix: agentFix(argv, 'Classifies legacy rows from deterministic signals in resumable batches; it never raises a row to confirmed and changes no content.', 'trust_tiers',
        { preview_argv: ['gbrain', 'trust', 'backfill', '--dry-run', '--json'] }) });
  } catch (err) {
    if (isUndefinedColumnError(err, 'trust_tier')) {
      checks.push({ name: 'trust_tiers', status: 'ok', details: { schema: 'pre_trust' }, message: 'This schema predates trust tiers; they arrive with the migration that adds them.' });
    } else {
      checks.push(checkError('trust_tiers', 'read trust tier counts', err));
    }
  }
  return checks;
}

export const trustTiersEntry: DoctorEntry = { name: 'trust_tiers', emits: ['trust_tiers'], run: runTrustTiers };
