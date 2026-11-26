/**
 * GST-3216 PR 1: who the brain's owner is, derived from what the brain already stores, with nothing for the user to
 * fill in. Read-only and resolved on every call (no cache), so serve, workers and cron never act on a stale owner.
 *
 * Identifiers come from three places: the member's declared email (access_members.email), the account of each Google
 * source the member owns (sources.config g_account), and the member's external ids (access_member_links). A Google
 * source bound to members (access_member_sources) belongs to them; an unbound one counts for the owner only on a brain
 * where the owner is the only person member, so a shared team mailbox is never anyone's "me". An identifier two members
 * claim counts for neither: two people are never merged.
 *
 * The owner's entity is the one live person page whose frontmatter email or emails names an owner identifier, matched
 * exactly (never by name); otherwise the member's own page (memory/members/<member>), or memory/owner on a brain with no
 * owner member. With several matching pages (a network or cohort directory entry beside a contact card) the entity falls
 * back the same way and every one of them is listed in `pages` as the owner too, so no one has to pick a page.
 *
 * Trusted local callers only: identifiers are personal data and no MCP operation reads this.
 */
import type { BrainEngine } from '../engine.ts';
import { ownerMemberId } from '../access/owner.ts';
import { listMembers } from '../access/members.ts';
import { MEMBER_PAGE_PREFIX, RESERVED_OWNER_SLUG } from '../access/principals.ts';
import { exactIdentityStatement, type ExactIdentityRow } from '../engine-sql/exact-identity.ts';
import { resolvePersonTypes } from '../schema-pack/entity-types.ts';

export { RESERVED_OWNER_SLUG };

export type OwnerIdentifierKind = 'member_email' | 'google_account' | 'member_link';
export interface OwnerIdentifier { kind: OwnerIdentifierKind; value: string; source_id?: string; system?: string }
export type OwnerEntityBasis = 'identifier_page' | 'member_page' | 'reserved_page';
export interface OwnerEntity { slug: string; source_id: string | null; basis: OwnerEntityBasis }
export type OwnerIdentityConflict = { kind: 'identifier_shared'; value: string; members: string[] };
export interface SkippedSource { source_id: string; reason: 'bound_to_other_member' | 'unbound_on_shared_brain' }
export interface OwnerIdentity {
  /** The member this identity is for: the requested member, else access.owner_member, else null (the local owner). */
  member: string | null;
  identifiers: OwnerIdentifier[];
  entity: OwnerEntity;
  /**
   * Every live person page that carries an owner identifier (a network or cohort directory entry, a contact card).
   * Each counts as the owner. With exactly one it is the owner page; with several, the owner page is the fallback
   * (the member page, else memory/owner), so nobody has to pick one, and none of them is merged or edited.
   */
  pages: Array<{ slug: string; source_id: string }>;
  conflicts: OwnerIdentityConflict[];
  skipped_sources: SkippedSource[];
  /** Set when the schema pack's person types could not be loaded, so no person page was searched and the entity is the fallback. */
  degraded?: 'person_types_unavailable';
}

const LOCAL_OWNER = '';
const CANDIDATE_CAP = 50;

const email = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v) ? v : null;
};

const frontmatterEmails = (row: Pick<ExactIdentityRow, 'email' | 'emails'>): string[] =>
  [row.email, row.emails].flatMap(v => {
    const value = typeof v === 'string' && v.startsWith('[') ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v;
    return (Array.isArray(value) ? value : [value]).map(email).filter((e): e is string => e !== null);
  });

export async function ownerIdentity(engine: BrainEngine, opts: { member?: string } = {}): Promise<OwnerIdentity> {
  const configured = await ownerMemberId(engine);
  const member = opts.member ?? configured;
  const key = member ?? LOCAL_OWNER;
  const people = (await listMembers(engine)).filter(m => m.status === 'enabled' && m.kind === 'person');
  const onlyOwner = people.every(m => m.id === member);

  const claims = new Map<string, Set<string>>();
  const claim = (value: string, who: string) => (claims.get(value) ?? claims.set(value, new Set()).get(value)!).add(who);
  const spellings = new Map<string, Set<string>>();
  const spelled = (raw: unknown) => {
    const e = email(raw);
    if (e) (spellings.get(e) ?? spellings.set(e, new Set([e])).get(e)!).add((raw as string).trim());
    return e;
  };
  for (const m of people) { const e = spelled(m.email); if (e) claim(e, m.id); }

  const sources = await engine.executeRaw<{ id: string; account: string | null; members: string[] | null }>(
    `SELECT s.id, s.config->>'g_account' AS account,
            (SELECT array_agg(b.member_id ORDER BY b.member_id) FROM access_member_sources b WHERE b.source_id = s.id) AS members
       FROM sources s
      WHERE s.archived IS NOT TRUE AND s.config->>'kind' = 'google'
      ORDER BY s.id`);
  const skipped: SkippedSource[] = [];
  const googleOf = new Map<string, string[]>();
  for (const s of sources) {
    const account = spelled(s.account);
    if (!account) continue;
    const bound = s.members ?? [];
    const owners = bound.length ? bound : onlyOwner ? [key] : [];
    if (!owners.includes(key)) skipped.push({ source_id: s.id, reason: bound.length ? 'bound_to_other_member' : 'unbound_on_shared_brain' });
    for (const who of owners) claim(account, who);
    if (owners.includes(key)) googleOf.set(account, [...(googleOf.get(account) ?? []), s.id]);
  }

  const conflicts: OwnerIdentityConflict[] = [];
  const identifiers: OwnerIdentifier[] = [];
  const own = (value: string) => {
    const who = claims.get(value);
    if (!who?.has(key)) return false;
    if (who.size > 1) { conflicts.push({ kind: 'identifier_shared', value, members: [...who].map(w => w || 'local owner').sort() }); return false; }
    return true;
  };
  const self = people.find(m => m.id === member);
  const selfEmail = email(self?.email);
  if (selfEmail && own(selfEmail)) identifiers.push({ kind: 'member_email', value: selfEmail });
  for (const [account, ids] of googleOf) {
    if (account === selfEmail || !own(account)) continue;
    for (const source_id of ids) identifiers.push({ kind: 'google_account', value: account, source_id });
  }
  if (member) {
    const links = await engine.executeRaw<{ system: string; external_id: string }>(
      'SELECT system, external_id FROM access_member_links WHERE member_id = $1 ORDER BY system, external_id', [member]);
    for (const l of links) identifiers.push({ kind: 'member_link', system: l.system, value: l.external_id });
  }

  const fallback: OwnerEntity = member
    ? { slug: `${MEMBER_PAGE_PREFIX}${member}`, source_id: null, basis: 'member_page' }
    : { slug: RESERVED_OWNER_SLUG, source_id: null, basis: 'reserved_page' };
  const emails = [...new Set(identifiers.filter(i => i.kind !== 'member_link').map(i => i.value))].sort();
  let entity = fallback;
  let pages: Array<{ slug: string; source_id: string }> = [];
  let degraded: OwnerIdentity['degraded'];
  if (emails.length) {
    const sourceIds = (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(r => r.id);
    const resolved = await resolvePersonTypes(engine, sourceIds);
    if (resolved.status === 'pack_unavailable') degraded = 'person_types_unavailable';
    const { text, params } = exactIdentityStatement({
      probes: { titleKeys: [], titleRaw: '', basenames: [], aliasKeys: [], emails: [...new Set(emails.flatMap(e => [...(spellings.get(e) ?? [e])]))].sort() },
      sourceIds, types: resolved.filter, emailsOnly: true, limit: CANDIDATE_CAP,
    });
    const wanted = new Set(emails);
    pages = (await engine.executeRaw<ExactIdentityRow>(text, params))
      .filter(r => frontmatterEmails(r).some(e => wanted.has(e)))
      .map(r => ({ slug: r.slug, source_id: r.source_id }));
    if (pages.length === 1) entity = { ...pages[0]!, basis: 'identifier_page' };
  }
  return { member, identifiers, entity, pages, conflicts, skipped_sources: skipped, ...(degraded ? { degraded } : {}) };
}
