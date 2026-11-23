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
import { opError, type OperationError } from '../ops/contract.ts';
import { ACCESS_ID_RE, normalizePrincipal } from './principals.ts';
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

/**
 * GST-3058: the take holders an HTTP transport hands dispatch for a verified credential: its stored list when it has
 * one, none (every holder, which readHolders confirms against the caller's audience) when it is bound to the brain
 * owner, and ['world'] for every other credential.
 */
export async function credentialHolders(engine: Pick<BrainEngine, 'getConfig'>, stored: string[] | null | undefined, memberId: string | null | undefined): Promise<string[] | undefined> {
  if (stored) return stored;
  return memberId && memberId === await ownerMemberId(engine) ? undefined : ['world'];
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

/**
 * GST-2698: the owner a reader list must name: the live owner, else a configured owner that is a member id but not
 * enabled now (live false). Null when no owner is set, so a brain without an owner never refuses a list.
 */
export async function readersOwner(engine: BrainEngine): Promise<{ owner: string | null; live: boolean }> {
  const view = await ownerView(engine);
  if (view.owner) return { owner: view.owner, live: true };
  const inactive = view.inactive ? normalizePrincipal(view.inactive.value) : null;
  return { owner: inactive?.startsWith('member:') ? inactive.slice('member:'.length) : null, live: false };
}

/**
 * GST-2476, GST-2698: readers that leave out the owner close `what` to the owner's own keys on every read path
 * (access/caller.ts), so `gbrain repair visibility --readers` and `gbrain access rule add` refuse such a list unless
 * --allow-without-owner. A group that holds the owner does not count. `principals` are normalized (member:<id>, group:<id>).
 */
export function readersOmitOwnerError(owner: string, live: boolean, principals: string[], what: string): OperationError {
  const shown = principals.map(p => p.startsWith('member:') ? p.slice('member:'.length) : p);
  return opError('invalid_params', 'These readers leave out the brain owner "' + owner + '"' + (live ? '' : ' (configured, not enabled now)') + ', so the owner\'s own keys could no longer read ' + what + '; nothing was written. Name the owner, or pass --allow-without-owner.',
    'Add the owner to the list (--readers ' + [...shown, owner].join(',') + '), or pass --allow-without-owner if the owner should not read it. A group that holds the owner does not count.',
    { reason: 'readers_omit_owner' });
}

/**
 * GST-2128: the reader list a printed `gbrain access rule add` command names: `readers` plus the owner readersOwner names,
 * when one is set and not listed, so pasting it is not refused readers_omit_owner. An unreadable owner prints `readers`.
 */
export async function hintReaders(engine: BrainEngine, readers: string[]): Promise<string> {
  const owner = await readersOwner(engine).then(r => r.owner, () => null);
  return (owner && !readers.includes(owner) ? [...readers, owner] : readers).join(',');
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

/** The refusal for a labelled-only grant on the owner: `member` is the owner (or the labelled-only member named as owner). */
export function labelledOnlyOwnerError(member: string, via: 'grant' | 'owner'): OperationError {
  const grant = via === 'grant';
  return opError('access_labelled_only_owner',
    grant ? `Member "${member}" is the brain owner, so it cannot be labelled-only; nothing was changed.`
      : `Member "${member}" is labelled-only, so it cannot be the brain owner; nothing was changed.`,
    grant ? 'Ask the user which member the group or audience credential should read as, add that member, bind the credential to it and mark that member labelled-only.'
      : `Ask the user whether to clear the labelled-only grant first (gbrain access member labelled-only ${member} off) or name another member the owner.`,
    {
      why: 'The owner reads the whole brain. A labelled-only grant would hide every unlabelled page from the owner\'s own credentials, so the two never go together.',
      fix: grant
        ? { ask_user: true, argv: ['gbrain', 'access', 'member', 'add', '<MEMBER>'], inputs: [{ name: 'MEMBER', how: 'Ask the user for a new member id for the group or audience credential (lower-case letters, digits, ., _ and -). Then: gbrain auth rescope --token <name> --member <MEMBER>, and gbrain access member labelled-only <MEMBER> on.' }],
          consent: [], actor: 'user', why: 'Gives the group or audience credential its own member, which can be labelled-only, and leaves the owner reading the whole brain.', requires_exclusive: false }
        : { ask_user: true, argv: ['gbrain', 'access', 'member', 'labelled-only', member, 'off'], consent: [], actor: 'user', requires_exclusive: false,
          why: 'Clears the labelled-only grant, so the member may be named the owner; every credential bound to it then reads its whole grant again.' },
    });
}

/**
 * Names the owner; refuses an ill-formed or non-enabled member, and (GBRA-108 design 1) a labelled-only one, before
 * writing anything.
 */
export async function setOwner(engine: BrainEngine, raw: unknown): Promise<OwnerView> {
  const { member } = await memberIdentity(engine, raw);
  const [row] = await engine.readAccessMembers({ id: member });
  if (row?.labelled_only === true) throw labelledOnlyOwnerError(member, 'owner');
  await engine.setConfig(OWNER_MEMBER_KEY, member);
  return ownerView(engine);
}

/** Names no owner: every caller reads under the ordinary read policy again. */
export async function clearOwner(engine: BrainEngine): Promise<OwnerView> {
  await engine.unsetConfig(OWNER_MEMBER_KEY);
  return { owner: null, bound_credentials: [], reads_restricted: await ownerReadsRestrictedOn(engine) };
}
