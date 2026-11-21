/**
 * owner_identity doctor check (GST-3216): who gbrain takes the brain's owner to be. Warns when an identifier is claimed
 * by two members (it then counts for neither), when several person pages carry an owner email (none is used), or when a
 * Google source on a brain with several people is bound to no member (its account is not counted), or when the schema
 * pack's person types cannot be loaded (no person page was searched). Details carry counts
 * and kinds only; the identifiers themselves are printed by `gbrain identity` on the local CLI.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { ownerIdentity } from '../../../core/identity/owner.ts';

export async function ownerIdentityCheck(engine: BrainEngine): Promise<Check> {
  try {
    const id = await ownerIdentity(engine);
    const kinds = [...new Set(id.identifiers.map(i => i.kind))].sort();
    const shared = id.conflicts.filter(c => c.kind === 'identifier_shared').length;
    const severalPages = id.conflicts.some(c => c.kind === 'several_pages');
    const unbound = id.skipped_sources.filter(s => s.reason === 'unbound_on_shared_brain').length;
    const details = { owner_member_set: id.member !== null, identifiers: id.identifiers.length, identifier_kinds: kinds,
      entity_basis: id.entity.basis, identifier_shared: shared, several_pages: severalPages, unbound_google_sources: unbound,
      person_types_unavailable: id.degraded === 'person_types_unavailable' };
    const where = `The owner page is ${id.entity.slug}.`;
    const noTypes = id.degraded === 'person_types_unavailable';
    if (shared === 0 && !severalPages && unbound === 0 && !noTypes) {
      return { name: 'owner_identity', status: 'ok', details,
        message: id.identifiers.length
          ? `gbrain knows the owner by ${id.identifiers.length} identifier(s) (${kinds.join(', ')}). ${where}`
          : `No owner identifier yet: set the owner member's email (gbrain access member set <id> --email <addr>) or connect a Google source. ${where}` };
    }
    const problems = [
      shared ? `${shared} identifier(s) are claimed by two members and count for neither` : '',
      severalPages ? 'several person pages carry an owner email, so none is used as the owner page' : '',
      unbound ? `${unbound} Google source(s) are bound to no member on a brain with several people, so their accounts are not counted` : '',
      noTypes ? 'the schema pack\'s person types could not be loaded, so no person page was searched for an owner email' : '',
    ].filter(Boolean);
    return { name: 'owner_identity', status: 'warn', details,
      message: `Owner identity is ambiguous: ${problems.join('; ')}. ${where} Run gbrain identity to see each one.`,
      fix: agentFix(['gbrain', 'identity', '--json'],
        'Lists every owner identifier, the member that claims it, the pages that carry it and the sources left out, so the conflict can be resolved by hand.',
        'owner_identity') };
  } catch (error) {
    return { name: 'owner_identity', status: 'warn', message: `Owner identity could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown' }, fix_unavailable_reason: 'check_errored' };
  }
}

async function runOwnerIdentity(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({ ...(await ownerIdentityCheck(connectedEngine(ctx))), name: 'owner_identity' });
  return checks;
}

export const ownerIdentityEntry: DoctorEntry = {
  name: 'owner_identity',
  emits: ['owner_identity'],
  run: runOwnerIdentity,
};
