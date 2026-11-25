/**
 * GBRA-108 design 1: the labelled-only grant. A member that carries access_members.labelled_only (the labelled-only migration; false by default
 * and unchanged on upgrade) reads only pages that name it: its member id or one of its groups in readable_by, or a folder
 * or page rule that lists it. Unlabelled pages its source grant would otherwise open are hidden, and so is every derived
 * page and fact with no readers or rule of its own, except under access.members_read_lineage where every origin names it
 * (CallerAccess.labelledOnly, search/private-visibility.ts). For group and audience credentials that should see only what
 * was deliberately labelled for them.
 *
 * The flag lives on the member, so every token, OAuth client and stdio binding of that member inherits it, and a second
 * credential cannot forget it. It never applies to the owner: setting it on the owner, or naming a labelled-only member
 * the owner, is refused (access_labelled_only_owner, exit 3). Only the trusted local operator sets it; a remote caller is
 * refused before anything is written, and no MCP operation or HTTP route reaches it. Everything lives in the database, so
 * a repo-less brain gets it unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { hostOnlyError } from '../ops/op-fix.ts';
import { ACCESS_ID_RE } from './principals.ts';
import { assertAccessId, boundCredentials, existingMember, getMember, type MemberRecord } from './members.ts';
import { labelledOnlyOwnerError, ownerMemberId } from './owner.ts';
import { isEngineCapabilityRefusal } from '../engine-capability-refusal.ts';

/**
 * Marks a member labelled-only or clears it. Only the trusted local operator may (remote strictly false), and never on the
 * owner; both refusals come before anything is written.
 */
export async function setMemberLabelledOnly(engine: BrainEngine, rawId: unknown, on: boolean, ctx: { remote?: boolean }): Promise<{ member: MemberRecord; changed: boolean }> {
  const id = assertAccessId(rawId);
  if (ctx.remote !== false) {
    throw hostOnlyError({ remote: true, transport: 'http' }, 'permission_denied',
      'Only the brain operator on the brain host sets or clears a labelled-only grant, so nothing was changed.',
      ['gbrain', 'access', 'member', 'labelled-only', id, on ? 'on' : 'off'],
      'Decides which pages every credential of that member reads. Who reads what is the brain operator\'s decision, never an agent\'s.');
  }
  const member = await existingMember(engine, id, 'changed');
  if (member.status === 'removed') {
    throw opError('access_member_id_retired', `Member id "${member.id}" was removed and can never be reused.`, 'Add a new member id instead.', { why: 'A removed member stays removed.' });
  }
  if (on && await ownerMemberId(engine) === member.id) throw labelledOnlyOwnerError(member.id, 'grant');
  if (member.labelled_only === on) return { member, changed: false };
  await engine.setAccessMemberLabelledOnly(member.id, on);
  return { member: (await getMember(engine, member.id))!, changed: true };
}

/** The enabled labelled-only members, sorted; empty when none. */
export async function labelledOnlyMemberIds(engine: Pick<BrainEngine, 'listEnabledLabelledOnlyMemberIds'>): Promise<string[]> {
  return engine.listEnabledLabelledOnlyMemberIds();
}

/** The enabled labelled-only members, sorted, each with how many credentials are bound to it (doctor's audit list). */
export async function labelledOnlyMembers(engine: BrainEngine): Promise<Array<{ id: string; credentials: number }>> {
  return Promise.all((await engine.listLabelledOnlyMemberIds()).map(async id => ({ id, credentials: (await boundCredentials(engine, id)).length })));
}

/** Whether any member carries the grant: the one cheap test a write runs before resolving its writer. Unreadable counts as yes. */
export async function anyLabelledOnlyMember(engine: Pick<BrainEngine, 'hasLabelledOnlyMember'>): Promise<boolean> {
  try {
    return await engine.hasLabelledOnlyMember();
  } catch {
    return true;
  }
}

/**
 * Whether a read or write by these identities is labelled-only: one of their members carries the grant. A table that
 * cannot be read counts as yes (fail closed: it only narrows). Identities without a member (unbound, a group, a guest)
 * are never labelled-only, and neither is the configured owner (access.owner_member), whichever door the call came in by.
 */
export async function labelledOnlyFor(engine: Pick<BrainEngine, 'hasLabelledOnlyMemberAmong'>, identities: readonly (readonly string[])[]): Promise<boolean> {
  const members = [...new Set(identities.flat().filter(p => p.startsWith('member:')).map(p => p.slice('member:'.length)).filter(id => ACCESS_ID_RE.test(id)))];
  if (!members.length) return false;
  try {
    return await engine.hasLabelledOnlyMemberAmong(members);
  } catch (e) {
    // An engine that refuses the read is reported, never read as labelled-only for every member.
    if (isEngineCapabilityRefusal(e)) throw e;
    return true;
  }
}
