/**
 * `gbrain trust claim-sources` (#5575, legacy content; trust/claim.ts): lists
 * each source (id, local path or remote, page count, the tier mix now and
 * after a claim) and asks the owner, per claimable source, to type its id.
 * Claimed sources get the per-source default operator_curated and their
 * legacy unverified rows are lifted (never above "your notes"; rows with a
 * lowering signal keep it). Trusted local CLI only; `--yes` never claims.
 *
 *   --dry-run [--json]     the listing, read-only
 *   --source <id>          ask only about this source (repeatable)
 *   --resume               finish the lift of sources already claimed (asks nothing)
 *   --batch-size N         lift batch size
 */
import type { BrainEngine } from '../core/engine.ts';
import { jsonRequested, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { opError } from '../core/ops/contract.ts';
import {
  claimSourcesFix, connectorRefusal, liftClaimedSources, listClaimSources, recordSourceClaims,
  type ClaimLiftReport, type ClaimSource,
} from '../core/trust/claim.ts';
import { promptTypedConfirmation } from '../core/trust/confirm.ts';
import { TRUST_TIERS, trustLabel } from '../core/trust/tier.ts';
import type { TierCounts } from '../core/trust/backfill.ts';
import { reportTrustCliError } from './trust.ts';

export const TRUST_CLAIM_USAGE = [
  'Usage: gbrain trust claim-sources [--dry-run] [--source <id>]... [--resume] [--batch-size N] [--json]',
  '  Claim your own sources once, after upgrading: each source shows its local path or remote, page count and',
  '  the trust mix now and after claiming, and you type its id to claim it. A claimed source syncs as "your notes"',
  '  and its rows from before trust tiers move from "unverified origin" to "your notes", except rows that say',
  '  they were captured, clipped, imported, extracted or written by an agent (they keep their lower tier).',
  '  Nothing becomes "confirmed by you". Connector sources (Google, GitHub) cannot be claimed. --dry-run lists',
  '  without writing; --resume finishes an interrupted claim. Needs you at a terminal; --yes never claims.',
].join('\n');

const mix = (counts: TierCounts | undefined) =>
  counts ? TRUST_TIERS.filter(t => counts[t] > 0).map(t => `${trustLabel(t)} ${counts[t]}`).join(', ') || 'no rows' : 'not yet classified';

function describe(s: ClaimSource): string[] {
  const where = s.local_path ?? s.remote_url ?? 'no local path';
  const state = s.blocker === 'connector' ? `${s.kind} connector: cannot be claimed`
    : s.blocker === 'archived' ? 'archived' : s.pending ? 'claimed; lift not finished (gbrain trust claim-sources --resume)'
      : s.claimed ? 'claimed' : s.blocker === 'no_legacy_rows' ? 'nothing to lift' : `${s.legacy_unknown} legacy row(s) with unverified origin`;
  return [
    `  ${s.id} (${where}): ${s.pages} page(s); ${state}`,
    `    now: ${mix(s.current)}`,
    ...(s.claimable ? [`    if claimed: ${mix(s.projected_if_claimed)}`] : []),
  ];
}

function renderLift(lift: ClaimLiftReport): string[] {
  if (!lift.sources.length) return [];
  const moved = Object.values(lift.updated).reduce((n, v) => n + v, 0);
  return [
    `Lifted ${moved} legacy row(s) in ${lift.sources.map(s => s.id).join(', ')}; ${lift.kept_lower} row(s) kept a lower tier from their own signals.`,
    ...lift.sources.map(s => `  ${s.id}: ${mix(s.tiers)}`),
  ];
}

function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === flag && args[i + 1]) out.push(args[i + 1]!); else if (a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1)); });
  return out;
}

export async function runTrustClaimSources(engine: BrainEngine, args: string[], opts: { completeStartup?: (e: BrainEngine) => Promise<void> } = {}): Promise<void> {
  const json = jsonRequested(args);
  try {
    const sizeAt = args.indexOf('--batch-size');
    const batchSize = sizeAt >= 0 ? Number(args[sizeAt + 1]) : undefined;
    if (batchSize !== undefined && (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100_000)) {
      throw opError('invalid_params', '--batch-size must be an integer from 1 to 100000.', 'Run gbrain trust claim-sources --batch-size 500, or omit --batch-size.');
    }
    const sized = batchSize ? { batchSize } : {};
    if (args.includes('--dry-run')) {
      const listing = await listClaimSources(engine, sized);
      if (json) await writeStdoutFinal(`${JSON.stringify({ mode: 'dry_run', ...listing }, null, 2)}\n`);
      else console.log([`Claim sources (dry run, nothing written; schema: ${listing.schema}):`, ...listing.sources.flatMap(describe)].join('\n'));
      return;
    }
    await opts.completeStartup?.(engine);
    if (args.includes('--resume')) {
      const lift = await liftClaimedSources(engine, { ...sized, log: line => process.stderr.write(`${line}\n`) });
      if (json) await writeStdoutFinal(`${JSON.stringify({ mode: 'resume', claimed: [], lift }, null, 2)}\n`);
      else console.log(lift.sources.length ? renderLift(lift).join('\n') : 'No claimed source is waiting for its lift.');
      return;
    }
    const listing = await listClaimSources(engine, sized);
    if (listing.schema === 'pre_trust') {
      throw opError('migrations_pending', 'This brain has no trust tier columns yet, so there is nothing to claim.', 'Run gbrain apply-migrations --yes on the brain host, then gbrain trust claim-sources.');
    }
    const named = flagValues(args, '--source');
    for (const id of named) {
      const s = listing.sources.find(x => x.id === id);
      if (!s) throw opError('unknown_source', `Source "${id}" does not exist.`, 'List sources with gbrain trust claim-sources --dry-run.');
      if (s.blocker === 'connector') throw connectorRefusal(id, s.kind ?? 'connector');
    }
    const asked = listing.sources.filter(s => s.claimable && (named.length === 0 || named.includes(s.id)));
    if (!json) console.log(['Your sources:', ...listing.sources.filter(s => named.length === 0 || named.includes(s.id)).flatMap(describe)].join('\n'));
    if (args.includes('--yes') && !json) console.log('Note: --yes never claims a source; type each id to claim it.');
    const claimed: string[] = [];
    for (const s of asked) {
      const answer = await promptTypedConfirmation({
        ref: s.id, command: ['gbrain', 'trust', 'claim-sources', '--source', s.id],
        summary: `Claim source "${s.id}" as your own notes? Its ${s.legacy_unknown} legacy row(s) become "your notes" unless they say they were captured, clipped, imported or agent-written.`,
      });
      if (answer === 'non_interactive') {
        throw opError('confirmation_required', 'Claiming sources needs the owner at a terminal; nothing was changed.',
          'Relay user_message to the user and stop. Only they can claim, by running the command in fix in a terminal on the brain host.',
          { why: 'Claiming raises legacy rows to "your notes"; that is the owner\'s decision, so it needs a person typing each source id. Piped input, agents and --yes cannot claim.', fix: claimSourcesFix() });
      }
      if (answer === 'confirmed') claimed.push(s.id);
      else if (!json) console.log(`  ${s.id}: not claimed.`);
    }
    await recordSourceClaims(engine, claimed);
    const lift = await liftClaimedSources(engine, { ...sized, log: line => process.stderr.write(`${line}\n`) });
    if (json) { await writeStdoutFinal(`${JSON.stringify({ mode: 'apply', claimed, lift }, null, 2)}\n`); return; }
    console.log([
      asked.length === 0 ? 'No source needs claiming.' : claimed.length ? `Claimed: ${claimed.join(', ')}.` : 'No source was claimed.',
      ...renderLift(lift),
    ].join('\n'));
  } catch (error) {
    if (!(await reportTrustCliError(error, json))) throw error;
  }
}

