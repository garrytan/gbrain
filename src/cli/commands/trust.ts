/**
 * `gbrain trust`: the memory-trust noun (#5575, DX-7). This module dispatches
 * `backfill` (A8, DX-5), `scan` (DX-6) and `claim-sources` (legacy content, trust/claim.ts),
 * and hands the owner subcommands (review, confirm,
 * release, drop, revert, explain, allow, disable) to src/commands/trust.ts.
 * The record is startup: 'observational', so `backfill --dry-run` and `claim-sources --dry-run` run on a
 * probe-only engine with no migrations and no writes; every other subcommand
 * completes startup first. While a resident serve holds a PGLite brain,
 * src/cli.ts routes the owner subcommands to it before any engine opens.
 */
import { jsonRequested, writeStdoutFinal } from '../../core/cli-force-exit.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { TRUST_TIERS, trustLabel } from '../../core/trust/tier.ts';
import type { TrustBackfillReport } from '../../core/trust/backfill.ts';
import type { CliDispatchContext } from '../command-table.ts';
import { TRUST_OWNER_USAGE, isTrustOwnerSubcommand, localTrustBackend, reportTrustCliError, runTrustOwnerCommand } from '../../commands/trust.ts';
import { TRUST_CLAIM_USAGE } from '../../commands/trust-claim.ts';

export const TRUST_BACKFILL_USAGE = [
  'Usage: gbrain trust backfill [--dry-run] [--resume] [--batch-size N] [--json]',
  '  Classifies rows written before trust tiers (facts, takes, timeline entries, pages) from deterministic signals:',
  '  connector sources, page source_kind, transcript/extraction/dream provenance, facts and takes source tags, and',
  '  the journaled request that wrote the row. Rows with no signal stay "unverified origin"; nothing becomes',
  '  "confirmed by you". --dry-run is read-only (no migrations, no writes) and works before the trust migration;',
  '  it reports the projected count per table and tier. --resume continues an interrupted run.',
  '',
  'Usage: gbrain trust scan [--batch-size N] [--json]',
  '  Runs the write gate\'s deterministic detector over agent-written and lower rows written before the gate,',
  '  recording a receipt for each instruction-like row, so it reads as flagged (and, under trust.agent_activation',
  '  suppress, stays out of proactive context) until you confirm it (gbrain trust review). Changes no row;',
  '  resumable (rerun to continue); a detector upgrade rescans.',
  '  Nothing runs it for you: an agent asks you first. Claim your own sources first (gbrain trust claim-sources)',
  '  so your older notes are not treated as unverified.',
].join('\n');
export const TRUST_USAGE = `${TRUST_OWNER_USAGE}\n\n${TRUST_BACKFILL_USAGE}\n\n${TRUST_CLAIM_USAGE}`;

function render(report: TrustBackfillReport): string {
  const lines = [`Trust backfill (${report.mode === 'dry_run' ? 'dry run, nothing written' : 'applied'}; schema: ${report.schema}):`];
  for (const t of report.tables) {
    const parts = TRUST_TIERS.filter(tier => t.projected[tier] > 0).map(tier => `${trustLabel(tier)} ${t.projected[tier]}`);
    lines.push(`  ${t.table}: ${t.rows} row(s)${t.updated !== undefined ? `, ${t.updated} classified now` : ''}${parts.length ? ` -> ${parts.join(', ')}` : ''}`);
  }
  lines.push(`  ${report.at_or_below_agent_written_pct}% of ${report.rows} row(s) at "written by an agent" or below; ${report.unknown_pct}% "unverified origin".`);
  if (report.resume_command) lines.push(`  Resume with: ${report.resume_command}`);
  return lines.join('\n');
}

/** A typed usage refusal (exit 2): the error envelope under --json, `Error [invalid_params]` text otherwise. */
async function refuse(args: string[], message: string, suggestion: string): Promise<void> {
  const { opError } = await import('../../core/ops/contract.ts');
  await reportTrustCliError(opError('invalid_params', message, suggestion), jsonRequested(args));
}

export async function run(engine: BrainEngine, args: string[], ctx: CliDispatchContext): Promise<void> {
  const [sub, ...rest] = args;
  const known = sub === 'backfill' || sub === 'scan' || sub === 'claim-sources' || isTrustOwnerSubcommand(sub);
  if (args.includes('--help') || args.includes('-h') || (!sub && !jsonRequested(args))) {
    console.log(sub === 'backfill' || sub === 'scan' ? TRUST_BACKFILL_USAGE : sub === 'claim-sources' ? TRUST_CLAIM_USAGE : TRUST_USAGE);
    return;
  }
  if (!known) {
    if (!jsonRequested(args)) console.log(TRUST_USAGE);
    await refuse(args, !sub || sub.startsWith('-') ? 'gbrain trust needs a subcommand.' : `Unknown trust subcommand '${sub}'.`,
      'gbrain trust --help lists the subcommands (review, confirm, explain, backfill, scan, claim-sources and the rest).');
    return;
  }
  if (sub === 'claim-sources') {
    const { runTrustClaimSources } = await import('../../commands/trust-claim.ts');
    await runTrustClaimSources(engine, rest, { completeStartup: ctx.completeStartup ? e => ctx.completeStartup!(e) : undefined });
    return;
  }
  if (sub !== 'backfill' && sub !== 'scan') {
    await ctx.completeStartup?.(engine);
    await runTrustOwnerCommand(localTrustBackend(engine, ctx.SELECTED_CONFIG_BY_ENGINE.get(engine)), sub, rest);
    // `explain` also shows each proactive surface's decision for a typed ref (eligibility/explain.ts).
    const ref = sub === 'explain' && !jsonRequested(args) ? rest.find(a => !a.startsWith('--')) : undefined;
    const { explainTrust } = await import('../../core/eligibility/explain.ts');
    const why = ref ? await explainTrust(engine, ref).catch(() => null) : null;
    if (why?.found) console.log(['Per surface:', ...Object.entries(why.activation).map(([surface, decision]) => `  ${surface}: ${decision}`)].join('\n'));
    return;
  }
  const dryRun = rest.includes('--dry-run');
  const sizeAt = rest.indexOf('--batch-size');
  const batchSize = sizeAt >= 0 ? Number(rest[sizeAt + 1]) : undefined;
  if (batchSize !== undefined && (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100_000)) {
    await refuse(args, '--batch-size must be an integer from 1 to 100000.', `Run gbrain trust ${sub} --batch-size 500, or omit --batch-size for the default.`);
    return;
  }
  if (sub === 'scan') {
    await ctx.completeStartup?.(engine);
    const { runTrustScan } = await import('../../core/eligibility/scan.ts');
    let scan;
    try { scan = await runTrustScan(engine, batchSize ? { batchSize } : {}); }
    catch (error) { if (await reportTrustCliError(error, jsonRequested(args))) return; throw error; }
    if (jsonRequested(args)) await writeStdoutFinal(`${JSON.stringify(scan, null, 2)}\n`);
    else console.log([`Trust scan (detector v${scan.detector_version}):`,
      ...scan.tables.map(t => `  ${t.table}: ${t.scanned} row(s) scanned, ${t.flagged} flagged${t.done ? '' : ' (more to scan)'}`),
      scan.complete ? '  Complete. Flagged rows carry their flag wherever they are read (and stay out of proactive context under trust.agent_activation suppress) until confirmed (gbrain trust review).' : `  Continue with: ${scan.resume_command}`].join('\n'));
    return;
  }
  if (!dryRun) await ctx.completeStartup?.(engine);
  const { runTrustBackfill } = await import('../../core/trust/backfill.ts');
  const report = await runTrustBackfill(engine, { dryRun, resume: rest.includes('--resume'), ...(batchSize ? { batchSize } : {}) });
  if (jsonRequested(args)) await writeStdoutFinal(`${JSON.stringify(report, null, 2)}\n`);
  else console.log(render(report));
}
