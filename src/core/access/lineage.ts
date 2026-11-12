/**
 * GBRA-108 design 3: listed members read lineage. With config access.members_read_lineage on ('1'; off by default and
 * unchanged on upgrade), a read by a credential bound to one member speaking for itself (or for an audience of exactly
 * that member) passes a derived page (an atom, a synthesized concept or question, a Life Chronicle event, a
 * derived_from page) or a fact when that member reads every origin of it, as an owner read does (CallerAccess.lineage,
 * search/private-visibility.ts). Never an audience of several, an unbound credential or an attested call, and never a
 * write. The owner opt-in (access.owner_reads_restricted) stays the owner's alone. Everything lives in the database, so
 * a repo-less brain gets it unchanged. Only the trusted local operator sets it.
 */
import type { BrainEngine } from '../engine.ts';
import { MEMBERS_READ_LINEAGE_KEY } from '../search/private-visibility.ts';
import { hostOnlyError } from '../ops/op-fix.ts';

export const MEMBERS_READ_LINEAGE_NOTE = 'Members read derived pages and facts of the pages listed to them: access.members_read_lineage is on, so a summary, atom, chronicle event or fact made from a page reaches every member that page lists. The brain operator set this.';

/** Is access.members_read_lineage on? Unset, anything but '1', or unreadable is off (nothing widens). */
export async function membersReadLineageOn(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  try {
    return (await engine.getConfig(MEMBERS_READ_LINEAGE_KEY))?.trim() === '1';
  } catch {
    return false;
  }
}

/** What whoami adds for every remote caller while the setting is on; empty otherwise. */
export async function membersReadLineageNotice(engine: Pick<BrainEngine, 'getConfig'>): Promise<{ members_read_lineage?: true; members_read_lineage_note?: string }> {
  return await membersReadLineageOn(engine) ? { members_read_lineage: true, members_read_lineage_note: MEMBERS_READ_LINEAGE_NOTE } : {};
}

/**
 * Turns the setting on or off. Only the trusted local operator may: a remote caller (anything whose `remote` is not
 * strictly false) is refused before anything is written.
 */
export async function setMembersReadLineage(engine: BrainEngine, on: boolean, ctx: { remote?: boolean }): Promise<{ members_read_lineage: boolean }> {
  if (ctx.remote !== false) {
    throw hostOnlyError({ remote: true, transport: 'http' }, 'permission_denied',
      'Only the brain operator on the brain host turns members-read-lineage on or off, so nothing was changed.',
      ['gbrain', 'access', 'members-read-lineage', on ? 'on' : 'off'],
      'Lets every member read the derived pages and facts of the pages listed to it. Whether summaries of a page reach everyone that page lists is the brain operator\'s decision, never an agent\'s.');
  }
  if (on) await engine.setConfig(MEMBERS_READ_LINEAGE_KEY, '1');
  else await engine.unsetConfig(MEMBERS_READ_LINEAGE_KEY);
  return { members_read_lineage: await membersReadLineageOn(engine) };
}
