/**
 * trust_sources_unclaimed (#5575, legacy content): warns while live,
 * non-connector sources the owner has not claimed hold rows still at
 * `unknown` (written before trust tiers, so they have no provenance), and
 * while a claim's lift has not finished. The fix is `fix.next:
 * tell_user_to_run`: relay what claiming means; only the owner can claim, at a terminal
 * (`gbrain trust claim-sources`, trust/claim.ts). A fresh or empty brain, or a
 * brain before the trust migration, is ok. #6533: once claims finished, it also
 * warns while claim-lifted rows rank above their own signals (legacy
 * extract_atoms atoms, #9284 legacy Life Chronicle events) and names the
 * lower-only `claim-sources --relower`, with `--source` flags when a source
 * whose claim has since ended holds such rows. Read-only.
 */
import type { Check } from '../../doctor.ts';
import { checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { claimSourcesFix, readUnclaimedLegacySources } from '../../../core/trust/claim.ts';
import { TRUST_CLAIM_RESUME_COMMAND, claimedSourceSql, notConnectorSourceSql } from '../../../core/trust/claim-state.ts';
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
    let owned: Array<{ id: string; claimed: boolean }>;
    if (pending.length) {
      checks.push({ name: 'trust_sources_unclaimed', status: 'warn', details,
        message: `A claim did not finish lifting ${pending.join(', ')}. Run ${TRUST_CLAIM_RESUME_COMMAND.join(' ')} on the brain host; it continues the confirmed claim and asks nothing.`,
        fix: { argv: [...TRUST_CLAIM_RESUME_COMMAND], consent: [], actor: 'agent', requires_exclusive: false, verify: VERIFY,
          why: 'Finishes the backfill of sources the owner already claimed, in resumable batches; nothing goes above "your notes".' } });
    } else if ((relower = await relowerClaimedRows(engine, { dryRun: true, sources: (owned = await engine.executeRaw<{ id: string; claimed: boolean }>(
      `SELECT s.id, ${claimedSourceSql('s')} AS claimed FROM sources s WHERE ${notConnectorSourceSql('s')}`)).map(s => s.id) })).rows > 0) {
      const ended = relower.sources.filter(id => !owned.find(s => s.id === id)?.claimed);
      const named = ended.length ? relower.sources.flatMap(id => ['--source', id]) : [];
      checks.push({ name: 'trust_sources_unclaimed', status: 'warn', details: { ...details, relower: { rows: relower.rows, sources: relower.sources, sample: relower.sample.slice(0, 5) } },
        message: `${relower.rows} row(s) a claim lifted to "your notes" say they were written by an agent (atoms extracted, or Life Chronicle events, from before gbrain recorded that). `
          + `Preview with ${[...TRUST_RELOWER_COMMAND, '--dry-run', ...named].join(' ')}, then run ${[...TRUST_RELOWER_COMMAND, ...named].join(' ')}; it only lowers.`,
        fix: { argv: [...TRUST_RELOWER_COMMAND, ...named], consent: [], actor: 'agent', requires_exclusive: false, verify: VERIFY,
          preview_argv: [...TRUST_RELOWER_COMMAND, '--dry-run', '--json', ...named],
          why: 'Lowers claim-lifted rows to the tier their own signals name (lower only; nothing is raised or confirmed).' } });
    } else if (unclaimed.length === 0) {
      checks.push({ name: 'trust_sources_unclaimed', status: 'ok', details, message: 'No unclaimed source holds rows from before trust tiers.' });
    } else {
      checks.push({ name: 'trust_sources_unclaimed', status: 'warn', details,
        message: `${rows} row(s) from before trust tiers in ${unclaimed.length} unclaimed source(s) (${unclaimed.map(s => s.id).join(', ')}) read as "unverified origin", so remote MCP readers see them quoted as source material. `
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
