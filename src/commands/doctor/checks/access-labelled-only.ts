/**
 * GBRA-108 design 1 doctor check (an operator setting, off by default).
 *
 *  - access_labelled_only_members: every enabled member that carries the labelled-only grant (access_members.labelled_only).
 *    Every credential bound to such a member reads only pages that name it (readable_by or a rule listing it or its
 *    groups), so it is listed with its bound credentials so a group or audience credential kept to labelled pages is easy
 *    to audit. A warn when the brain owner carries it (only a hand edit gets there; the owner reads past it anyway, and
 *    the grant should be cleared).
 *
 * With no labelled-only member, the check is not applicable.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { labelledOnlyMembers } from '../../../core/access/labelled-only.ts';
import { ownerMemberId } from '../../../core/access/owner.ts';

const name = 'access_labelled_only_members';

async function verdict(ctx: DoctorContext): Promise<Check> {
  const engine = connectedEngine(ctx);
  try {
    const members = await labelledOnlyMembers(engine);
    const ids = members.map(m => m.id);
    if (!ids.length) return infoCheck(name, 'Not applicable: no member is labelled-only (gbrain access member labelled-only <id> on).', 'not_applicable');
    const owner = await ownerMemberId(engine);
    if (owner && ids.includes(owner)) {
      return { name, status: 'warn', details: { members, owner },
        message: `The brain owner (${owner}) is marked labelled-only. The owner reads the whole brain, so the grant does not apply to it; clear it with gbrain access member labelled-only ${owner} off.`,
        fix: agentFix(['gbrain', 'access', 'member', 'labelled-only', owner, 'off'], 'Clears the grant on the owner; no read changes, because the owner never reads under it.', name, { ask_user: true }) };
    }
    return infoCheck(name, `${ids.length} labelled-only member(s): every credential bound to each reads only pages that name it (readable_by or a rule listing it or its groups), never an unlabelled page its grant would otherwise open: ${members.map(m => `${m.id} (${m.credentials} credential(s))`).join(', ')}. Clear one with gbrain access member labelled-only <id> off.`,
      'ok', undefined, { members });
  } catch (error) {
    return checkError(name, `run ${name}`, error);
  }
}

async function runAccessLabelledOnly(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const { name: _name, ...check } = await verdict(ctx);
  checks.push({ name: 'access_labelled_only_members', ...check });
  return checks;
}

export const accessLabelledOnlyEntry: DoctorEntry = {
  name: 'access_labelled_only_members',
  emits: ['access_labelled_only_members'],
  run: runAccessLabelledOnly,
};
