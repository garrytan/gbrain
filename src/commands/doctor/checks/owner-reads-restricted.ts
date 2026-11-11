/**
 * GST-2490 owner opt-in doctor check.
 *
 *  - access_owner_reads_restricted: config access.owner_reads_restricted is on, so credentials bound to the brain owner
 *    read pages that readers lists and folder or page rules keep to other members (and their derived pages and facts),
 *    except another member's own member page. Reported so nobody on a shared brain reads under it unknowingly; a warn
 *    when it is on but names no enabled owner (no credential reads under it).
 *
 * Off, the check is not applicable.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { ownerReadsRestrictedOn, ownerView } from '../../../core/access/owner.ts';

const name = 'access_owner_reads_restricted';

async function verdict(ctx: DoctorContext): Promise<Check> {
  const engine = connectedEngine(ctx);
  try {
    if (!(await ownerReadsRestrictedOn(engine))) {
      return infoCheck(name, 'Not applicable: the owner opt-in (access.owner_reads_restricted) is off; the owner reads a page that names readers or sits under a rule only when listed.', 'not_applicable');
    }
    const view = await ownerView(engine);
    const details = { owner: view.owner, bound_credentials: view.bound_credentials.length };
    if (!view.owner) {
      return { name, status: 'warn', details,
        message: 'access.owner_reads_restricted is on, but no enabled member is named as the owner, so no credential reads under it. Name the owner or turn the opt-in off.',
        fix: agentFix(['gbrain', 'access', 'owner', '--json'], 'Read-only: shows the configured owner and why it is not in effect.', name, { ask_user: true }) };
    }
    return { name, status: 'ok', details,
      message: `The owner opt-in is on: the ${view.bound_credentials.length} credential(s) bound to owner ${view.owner} read pages that readers lists and folder or page rules keep to other members, and their derived pages and facts, except another member's own member page. Every member's whoami reports it. Turn it off with gbrain access owner reads-restricted off.` };
  } catch (error) {
    return checkError(name, `run ${name}`, error);
  }
}

async function runOwnerReadsRestricted(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const { name: _name, ...check } = await verdict(ctx);
  checks.push({ name: 'access_owner_reads_restricted', ...check });
  return checks;
}

export const ownerReadsRestrictedEntry: DoctorEntry = {
  name: 'access_owner_reads_restricted',
  emits: ['access_owner_reads_restricted'],
  run: runOwnerReadsRestricted,
};
