/**
 * trust_sources_unclaimed (#5575, legacy content): warns while live,
 * non-connector sources the owner has not claimed hold rows still at
 * `unknown` (written before trust tiers, so they have no provenance), and
 * while a claim's lift has not finished. The fix is `fix.next:
 * tell_user_to_run`: relay what claiming means; only the owner can claim, at a terminal
 * (`gbrain trust claim-sources`, trust/claim.ts). A fresh or empty brain, or a
 * brain before the trust migration, is ok. #6533: once claims finished, it also
 * warns while claim-lifted rows rank above their own signals (legacy
 * extract_atoms atoms) and names the lower-only `claim-sources --relower`.
 * Read-only.
 */
import type { Check } from '../../doctor.ts';
import { checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { claimSourcesFix, readUnclaimedLegacySources } from '../../../core/trust/claim.ts';
import { TRUST_CLAIM_RESUME_COMMAND } from '../../../core/trust/claim-state.ts';
import { relowerClaimedRows, TRUST_RELOWER_COMMAND, type TrustRelowerReport } from '../../../core/trust/backfill.ts';
import { isMissingSchemaObject } from '../../../core/utils.ts';

const VERIFY = { argv: ['gbrain', 'doctor', '--only', 'trust_sources_unclaimed', '--json'] };

async function runTrustSourcesUnclaimed(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  try {
    const { unclaimed, pending } = await readUnclaimedLegacySources(engine);
    const rows = unclaimed.reduce((n, s) => n + s.legacy_unknown, 0);
    const details = { unclaimed, pending, legacy_unknown: rows };
    let relower: TrustRelowerReport;
    if (pending.length) {
      checks.push({ name: 'trust_sources_unclaimed', status: 'warn', details,
        message: `A claim did not finish lifting ${pending.join(', ')}. Run ${TRUST_CLAIM_RESUME_COMMAND.join(' ')} on the brain host; it continues the confirmed claim and asks nothing.`,
        fix: { argv: [...TRUST_CLAIM_RESUME_COMMAND], consent: [], actor: 'agent', requires_exclusive: false, verify: VERIFY,
          why: 'Finishes the backfill of sources the owner already claimed, in resumable batches; nothing goes above "your notes".' } });
    } else if ((relower = await relowerClaimedRows(engine, { dryRun: true })).rows > 0) {
      checks.push({ name: 'trust_sources_unclaimed', status: 'warn', details: { ...details, relower: { rows: relower.rows, sample: relower.sample.slice(0, 5) } },
        message: `${relower.rows} row(s) a claim lifted to "your notes" say they were written by an agent (atoms extracted before gbrain recorded that). `
          + `Preview with ${[...TRUST_RELOWER_COMMAND, '--dry-run'].join(' ')}, then run ${TRUST_RELOWER_COMMAND.join(' ')}; it only lowers.`,
        fix: { argv: [...TRUST_RELOWER_COMMAND], consent: [], actor: 'agent', requires_exclusive: false, verify: VERIFY,
          preview_argv: [...TRUST_RELOWER_COMMAND, '--dry-run', '--json'],
          why: 'Lowers claim-lifted rows to the tier their own signals name (lower only; nothing is raised or confirmed).' } });
    } else if (unclaimed.length === 0) {
      checks.push({ name: 'trust_sources_unclaimed', status: 'ok', details, message: 'No unclaimed source holds rows from before trust tiers.' });
    } else {
      checks.push({ name: 'trust_sources_unclaimed', status: 'warn', details,
        message: `${rows} row(s) from before trust tiers in ${unclaimed.length} unclaimed source(s) (${unclaimed.map(s => s.id).join(', ')}) read as "unverified origin". `
          + 'Tell the user: if these are their own notes, they run gbrain trust claim-sources in a terminal on the brain host (gbrain trust claim-sources --dry-run --json previews it).',
        fix: claimSourcesFix('trust_sources_unclaimed') });
    }
  } catch (err) {
    if (isMissingSchemaObject(err, 'column', 'trust_tier')) {
      checks.push({ name: 'trust_sources_unclaimed', status: 'ok', details: { schema: 'pre_trust' }, message: 'This schema predates trust tiers; claiming arrives with the migration that adds them.' });
    } else {
      checks.push(checkError('trust_sources_unclaimed', 'read unclaimed sources', err));
    }
  }
  return checks;
}

export const trustSourcesUnclaimedEntry: DoctorEntry = { name: 'trust_sources_unclaimed', emits: ['trust_sources_unclaimed'], run: runTrustSourcesUnclaimed };
