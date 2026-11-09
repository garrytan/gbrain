/**
 * GST-2059: the brain owner. On a personal brain the owner's own agents must read the whole brain, private pages
 * included, while every other remote caller keeps the read policy. The owner is named explicitly, never guessed: config
 * access.owner_member holds one member id, and a credential (token or OAuth client, bound with
 * `gbrain auth rescope --member <id>`) or a stdio server (config mcp.stdio_member) bound to that live member reads as
 * the owner (CallerAccess.owner, src/core/access/caller.ts). Everything lives in the database, so a repo-less brain
 * gets it unchanged. Only the trusted local CLI writes it.
 */
import type { BrainEngine } from '../engine.ts';
import { OWNER_MEMBER_KEY } from '../search/private-visibility.ts';
import { ACCESS_ID_RE } from './principals.ts';
import { boundCredentials, memberIdentity } from './members.ts';
import type { CredentialRef } from './members.ts';

export interface OwnerView {
  owner: string | null;
  /** The configured value when it names no enabled member (ill-formed, disabled, removed or missing): no caller reads as the owner. */
  inactive?: { value: string; reason: string };
  bound_credentials: CredentialRef[];
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
  if (!raw) return { owner: null, bound_credentials: [] };
  try {
    const { member } = await memberIdentity(engine, raw);
    return { owner: member, bound_credentials: await boundCredentials(engine, member) };
  } catch (e) {
    return { owner: null, inactive: { value: raw, reason: e instanceof Error ? e.message : String(e) }, bound_credentials: [] };
  }
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
  return { owner: null, bound_credentials: [] };
}
