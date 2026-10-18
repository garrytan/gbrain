/**
 * #6729 `rename_identity_downgrades`: inexact Git renames a sync split into a delete plus an add because their identity
 * could not be confirmed (sync-rename-identity.ts). Each old page keeps its facts, links and aliases on its soft-deleted
 * slug, and the purge leaves it alone until the pair gets a disposition (restored, remedied or closed without merging);
 * there is no time window. The finding names every open pair with its remedy; its fix is the first pair's
 * `gbrain repair rename-identity` apply (preview first, bound to the plan hash, destructive consent, behind ask_user;
 * `--close` on a managed brain). Restoring the old page is the alternative its text names wherever the source admits a
 * restore (`restore_available`); details list the sources that do not. With no open record the check is ok.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { identityDowngradeReasonText, identityRestoreArgv, identityStatusArgv, listIdentityDowngrades, withIdentityRemedies } from '../../../core/sync-identity-downgrades.ts';

const DOCS = 'docs/guides/live-sync.md#renaming-a-page';
const SAMPLE = 5;

async function runRenameIdentityDowngrades(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const open = await listIdentityDowngrades(engine);
    const bySource = [...new Set(open.map(record => record.source_id))].map(source_id => ({ source_id, count: open.filter(record => record.source_id === source_id).length }));
    const sampled = await withIdentityRemedies(engine, open.slice(0, SAMPLE));
    const samples = sampled.map(record => ({ source_id: record.source_id, from: record.from, to: record.to, old_slug: record.old_slug, new_slug: record.new_slug,
      reason: record.reason, facts: record.facts, links: record.links, aliases: record.aliases, recorded_at: record.recorded_at, remedy: record.remedy }));
    const details = { count: open.length, by_source: bySource, samples, docs: DOCS };
    if (!open.length) {
      checks.push({ name: 'rename_identity_downgrades', status: 'ok', details, message: 'No rename that lost its page identity is waiting for a disposition.' });
      return checks;
    }
    const first = sampled[0]!;
    const unrestorable = [...new Set(open.filter(record => record.restore_available === false).map(record => record.source_id))];
    const restore = first.restore_available === false ? null : identityRestoreArgv(first).join(' ');
    const carry = first.remedy.disposition === 'carry';
    const route = carry
      ? `To carry an old page's identity onto its new page, preview ${first.remedy.preview_argv.join(' ')} and, after the user agrees, apply it. `
      : first.remedy.carry_unavailable
        ? `Carrying identity is unavailable on a managed source (${first.remedy.carry_unavailable}); to release the purge hold without carrying it, preview ${first.remedy.preview_argv.join(' ')} and, after the user agrees, apply it. `
        : `The new file did not import; to release the purge hold, preview ${first.remedy.preview_argv.join(' ')} and, after the user agrees, apply it. `;
    checks.push({ name: 'rename_identity_downgrades', status: 'warn', details: { ...details, restore_unavailable_sources: unrestorable },
      message: `${open.length} rename(s) did not keep their page identity, so each old page's facts, links and aliases stay on its soft-deleted slug, held from the purge until the pair is settled `
        + `(e.g. ${samples.map(record => `${record.source_id}:${record.from} -> ${record.to}, ${record.facts} fact(s) and ${record.links} link(s) on ${record.old_slug}`).join('; ')}; `
        + `first: ${identityDowngradeReasonText(first.reason)}). ${identityStatusArgv(first.source_id).join(' ')} lists every pair with its remedy. ${route}`
        + (restore ? `To keep the old page as its own page instead: ${restore}. ` : '')
        + (unrestorable.length ? `A restore is not offered on ${unrestorable.join(', ')} (an unbound Postgres source refuses page writes outside its checkout). ` : '')
        + `The purge holds each old page until ${first.remedy.hold_releases}.`,
      fix: agentFix(first.remedy.argv,
        (carry
          ? `Carries ${first.old_slug}'s page identity (version history, timeline, links, facts and aliases) onto ${first.new_slug}, applies the new file as an edit and retires the provisional page; the pair settles. Preview first.`
          : `Closes the pair of ${first.old_slug} without carrying its identity${first.remedy.carry_unavailable ? ` (carrying is unavailable on a managed source: ${first.remedy.carry_unavailable})` : ''}, so the purge no longer waits for it; nothing moves. Preview first.`)
          + (restore ? ` The alternative is ${restore}.` : ''),
        'rename_identity_downgrades', { docs: DOCS, ask_user: true, consent: ['destructive'], preview_argv: first.remedy.preview_argv, plan_hash: first.remedy.plan_hash,
          user_message: (carry
            ? `Sync did not keep the identity of ${first.old_slug} when ${first.from} became ${first.to}. Carry its history, ${first.facts} fact(s) and ${first.links} link(s) onto ${first.new_slug}`
            : `Sync did not keep the identity of ${first.old_slug} when ${first.from} became ${first.to}${first.remedy.carry_unavailable ? ', and carrying it is unavailable on a managed source' : ', and the new file did not import'}. Release the purge hold so ${first.old_slug} is purged`)
            + (restore ? ` (or restore it as its own page with ${restore})?` : '?') }) });
  } catch (error) {
    checks.push(checkError('rename_identity_downgrades', 'read the renames whose identity was not kept', error, { details: { count: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const renameIdentityDowngradesEntry: DoctorEntry = { name: 'rename_identity_downgrades', emits: ['rename_identity_downgrades'], run: runRenameIdentityDowngrades };
