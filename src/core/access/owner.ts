/**
 * GST-2059: the brain owner. On a personal brain the owner's own agents must read the whole brain, private pages
 * included, while every other remote caller keeps the read policy. The owner is named explicitly, never guessed: config
 * access.owner_member holds one member id, and a credential (token or OAuth client, bound with
 * `gbrain auth rescope --member <id>`) or a stdio server (config mcp.stdio_member) bound to that live member reads as
 * the owner (CallerAccess.owner, src/core/access/caller.ts). Everything lives in the database, so a repo-less brain
 * gets it unchanged. Only the trusted local CLI writes it.
 *
 * GST-2490: the owner opt-in, config access.owner_reads_restricted ('1' on, unset off). With it on, the owner's
 * credentials also read pages a readers list, folder rule or page rule would close to the owner (and their derived pages
 * and facts), except another member's own member page; see OWNER_READS_RESTRICTED_KEY. Off by default, set only by the
 * trusted local operator (setOwnerReadsRestricted refuses a remote caller).
 */
import type { BrainEngine } from '../engine.ts';
import { OWNER_MEMBER_KEY, OWNER_READS_RESTRICTED_KEY } from '../search/private-visibility.ts';
import { hostOnlyError } from '../ops/op-fix.ts';
import { ACCESS_ID_RE } from './principals.ts';
import { boundCredentials, memberIdentity } from './members.ts';
import type { CredentialRef } from './members.ts';

export interface OwnerView {
  owner: string | null;
  /** The configured value when it names no enabled member (ill-formed, disabled, removed or missing): no caller reads as the owner. */
  inactive?: { value: string; reason: string };
  bound_credentials: CredentialRef[];
  /** GST-2490: access.owner_reads_restricted is on (the owner's credentials read past readers lists and rules). */
  reads_restricted: boolean;
}

/** The owner member id, or null when unset or ill-formed (fail closed). */
export async function ownerMemberId(engine: Pick<BrainEngine, 'getConfig'>): Promise<string | null> {
  try {
    const raw = (await engine.getConfig(OWNER_MEMBER_KEY))?.trim();
    return raw && ACCESS_ID_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** The configured owner, whether it is live, and the credentials that read as it. */
export async function ownerView(engine: BrainEngine): Promise<OwnerView> {
  const raw = (await engine.getConfig(OWNER_MEMBER_KEY))?.trim() ?? '';
  const reads_restricted = await ownerReadsRestrictedOn(engine);
  if (!raw) return { owner: null, bound_credentials: [], reads_restricted };
  try {
    const { member } = await memberIdentity(engine, raw);
    return { owner: member, bound_credentials: await boundCredentials(engine, member), reads_restricted };
  } catch (e) {
    return { owner: null, inactive: { value: raw, reason: e instanceof Error ? e.message : String(e) }, bound_credentials: [], reads_restricted };
  }
}

/** GST-2490: is access.owner_reads_restricted on? Unset, anything but '1', or unreadable is off (nothing widens). */
export async function ownerReadsRestrictedOn(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  try {
    return (await engine.getConfig(OWNER_READS_RESTRICTED_KEY))?.trim() === '1';
  } catch {
    return false;
  }
}

/**
 * GST-2490: what whoami adds for every remote caller while the owner opt-in is on and names a live owner, so a member's
 * agent can find out that the owner reads the pages kept to it. Empty otherwise.
 */
export async function ownerReadsRestrictedNotice(engine: BrainEngine): Promise<{ owner_reads_restricted?: true; owner_reads_restricted_note?: string }> {
  if (!(await ownerReadsRestrictedOn(engine)) || !(await ownerView(engine)).owner) return {};
  return { owner_reads_restricted: true, owner_reads_restricted_note: "The brain owner's credentials read every page on this brain that readers lists or folder or page rules keep to members, including pages kept to this connection, and their derived pages and facts; never a member's own member page. The brain operator set this (config access.owner_reads_restricted)." };
}

/**
 * GST-2490: turns the owner opt-in on or off. Only the trusted local operator may: a remote caller (anything whose
 * `remote` is not strictly false) is refused before anything is written.
 */
export async function setOwnerReadsRestricted(engine: BrainEngine, on: boolean, ctx: { remote?: boolean }): Promise<OwnerView> {
  if (ctx.remote !== false) {
    throw hostOnlyError({ remote: true, transport: 'http' }, 'permission_denied',
      'Only the brain operator on the brain host turns the owner opt-in on or off, so nothing was changed.',
      ['gbrain', 'access', 'owner', 'reads-restricted', on ? 'on' : 'off'],
      'Lets the owner\'s credentials read pages that readers lists and folder or page rules keep to other members. Whether the owner reads them is the brain operator\'s decision, never an agent\'s.');
  }
  if (on) await engine.setConfig(OWNER_READS_RESTRICTED_KEY, '1');
  else await engine.unsetConfig(OWNER_READS_RESTRICTED_KEY);
  return ownerView(engine);
}

/** Names the owner; refuses an ill-formed or non-enabled member before writing anything. */
export async function setOwner(engine: BrainEngine, raw: unknown): Promise<OwnerView> {
  const { member } = await memberIdentity(engine, raw);
  await engine.setConfig(OWNER_MEMBER_KEY, member);
  return ownerView(engine);
}

/** Names no owner: every caller reads under the ordinary read policy again. */
export async function clearOwner(engine: BrainEngine): Promise<OwnerView> {
  await engine.unsetConfig(OWNER_MEMBER_KEY);
  return { owner: null, bound_credentials: [], reads_restricted: await ownerReadsRestrictedOn(engine) };
}
