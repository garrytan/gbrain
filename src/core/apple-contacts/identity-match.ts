/**
 * Tie a contact page to the person page it describes, by exact email or exact phone only (never by name), through the
 * candidate read behind whois (engine-sql/exact-identity.ts) and the identity groups of entity-identity.ts:
 *
 *   - exactly one person: the contact page joins that person's identity group (one is made, with the person page as
 *     its canonical member, when the person page has none). Only entity_identities rows are written; the person page
 *     itself, its file and its frontmatter, are never touched.
 *   - no person: no link (a link this source made earlier is removed).
 *   - two or more: no link. The case is recorded as an identity review for the owner, which gbrain sync status lists
 *     as needing a person. It settles itself on a later run once the owner confirms the candidates are one person
 *     (gbrain dedupe confirm: they then share one identity group) or records them as different people (gbrain dedupe
 *     reject: the review stays, marked decided, and the contact stays unlinked).
 *   - one person the owner recorded as a different person from the contact (gbrain dedupe reject): no link.
 *
 * The Google Contacts linker (google/contact-identity.ts) uses the same rule under its own link origin, and also holds
 * back a single match whose page name clearly disagrees with the contact's (LinkOptions.contactName, names compared by
 * entities/name-variants.ts namesAgree): that case waits as a review too.
 *
 * Candidates are live pages of type person in every unarchived source that is not a connector (a Google or another
 * Apple contacts copy is not a person page); pages already in one identity group count as one person. A contact page another writer linked (a manual or dedupe link) is left as it is.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { exactIdentityStatement, type ExactIdentityRow } from '../engine-sql/exact-identity.ts';
import { identityEmailKey } from '../ops/whois.ts';
import { canonicalPhone, phoneProbeDigits } from '../phone-key.ts';
import { linkEntityIdentity, listEntityIdentities, unlinkEntityIdentity } from '../entity-identity.ts';
import { decidedSets } from '../entities/identity-decisions.ts';
import { namesAgree } from '../entities/name-variants.ts';
import { CONNECTOR_KINDS_SQL } from '../persistence/connector-kinds.ts';
import type { IdentityMemberRef } from '../engine-sql/identity-decisions.ts';

export const APPLE_CONTACTS_LINK_ORIGIN = 'apple-contacts';
import { APPLE_CONTACTS_REVIEW_OP } from './review-status.ts';

export { APPLE_CONTACTS_REVIEW_OP };
const CANDIDATE_CAP = 100;

export interface IdentityReview {
  contact_id: string;
  slug: string;
  candidates: IdentityMemberRef[];
  /** The one matching person's page names someone else (LinkOptions.contactName); absent when two or more people match. */
  reason?: 'name_disagrees';
  /** The owner recorded the candidates as different people (gbrain dedupe reject): nothing is waiting on them. */
  decided?: 'different';
}

export type MatchOutcome = { kind: 'one'; entityId: string; person: IdentityMemberRef } | { kind: 'none' } | { kind: 'many'; candidates: IdentityMemberRef[] }
  | { kind: 'different'; candidates: IdentityMemberRef[] } | { kind: 'name_disagrees'; candidates: IdentityMemberRef[] };

const decoded = (value: unknown): unknown => {
  if (typeof value !== 'string' || !/^[[{"]/.test(value)) return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
};
const strings = (value: unknown): string[] => { const v = decoded(value); return (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === 'string'); };
const refKey = (m: IdentityMemberRef) => `${m.source_id}\t${m.slug}`;

/** The person pages (outside this source) whose email or phone equals one of the contact's, exactly. */
export async function exactPersonMatches(engine: BrainEngine, sourceId: string, emails: string[], phones: string[], countryCode: string): Promise<{ pages: IdentityMemberRef[]; truncated: boolean; titles: Map<string, string> }> {
  const emailKeys = [...new Set(emails.map(e => identityEmailKey(e)).filter((e): e is string => !!e))];
  const phoneKeys = [...new Set(phones.map(p => canonicalPhone(p, countryCode)).filter((p): p is string => !!p))];
  if (!emailKeys.length && !phoneKeys.length) return { pages: [], truncated: false, titles: new Map() };
  const sourceIds = (await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE archived IS NOT TRUE AND id <> $1 AND COALESCE(config->>'kind','') NOT IN (${CONNECTOR_KINDS_SQL}) ORDER BY id`, [sourceId])).map(r => r.id);
  if (!sourceIds.length) return { pages: [], truncated: false, titles: new Map() };
  const { text, params } = exactIdentityStatement({
    probes: { titleKeys: [], titleRaw: '', basenames: [], aliasKeys: [], emails: [...new Set([...emails.map(e => e.trim()), ...emailKeys])],
      phones: [...new Set(phoneKeys.flatMap(p => phoneProbeDigits(p, countryCode)))] },
    sourceIds, types: { types: ['person'], per_source: [] }, limit: CANDIDATE_CAP + 1,
  });
  const rows = await engine.executeRaw<ExactIdentityRow>(text, params);
  const matches = rows.slice(0, CANDIDATE_CAP).filter(row =>
    [...strings(row.email), ...strings(row.emails)].some(v => { const k = identityEmailKey(v); return !!k && emailKeys.includes(k); })
    || [...strings(row.phone), ...strings(row.phones)].some(v => { const k = canonicalPhone(v, countryCode); return !!k && phoneKeys.includes(k); }));
  return { pages: matches.map(r => ({ source_id: r.source_id, slug: r.slug })), truncated: rows.length > CANDIDATE_CAP,
    titles: new Map(matches.filter(r => r.title).map(r => [refKey(r), r.title!])) };
}

/** Matched pages counted as people: pages in one identity group are one person. */
async function outcomeOf(engine: BrainEngine, pages: IdentityMemberRef[], truncated: boolean): Promise<MatchOutcome> {
  if (!pages.length) return { kind: 'none' };
  const groups = new Map<string, IdentityMemberRef[]>();
  const members = await Promise.all(pages.map(async page => ({ page, entity: (await listEntityIdentities(engine, { slug: page.slug, slugSourceId: page.source_id }))
    .find(m => m.slug === page.slug && m.source_id === page.source_id)?.entity_id ?? null })));
  for (const { page, entity } of members) {
    const key = entity ? `entity:${entity}` : `page:${refKey(page)}`;
    groups.set(key, [...groups.get(key) ?? [], page]);
  }
  if (groups.size > 1 || truncated) return { kind: 'many', candidates: pages };
  const [key, [person]] = [...groups][0]!;
  return { kind: 'one', person: person!, entityId: key.startsWith('entity:') ? key.slice('entity:'.length)
    : `person-${createHash('sha256').update(refKey(person!)).digest('hex').slice(0, 16)}` };
}

/** otherWriter: the contact page is in an identity group another writer made, which is left as it is. */
export interface LinkResult { outcome: MatchOutcome['kind']; linked: boolean; unlinked: boolean; candidates?: IdentityMemberRef[]; otherWriter?: boolean }

export interface LinkOptions {
  /** established_by of the rows this linker writes; only its own rows are moved or removed. */
  origin?: string;
  /** The sets the owner recorded as different people (decidedSets().apart); read here when not given. */
  apart?: IdentityMemberRef[][];
  /** Decide and report the outcome without writing. */
  dryRun?: boolean;
  /** The contact's name: a single match whose page names clearly disagree with it is not linked (outcome name_disagrees). */
  contactName?: string;
}

/** Match one contact page and bring its identity link in line with the outcome. */
export async function linkContactPage(engine: BrainEngine, sourceId: string, slug: string, emails: string[], phones: string[], countryCode: string,
  opts: LinkOptions = {}): Promise<LinkResult> {
  const origin = opts.origin ?? APPLE_CONTACTS_LINK_ORIGIN;
  const { pages, truncated, titles } = await exactPersonMatches(engine, sourceId, emails, phones, countryCode);
  let outcome = await outcomeOf(engine, pages, truncated);
  if (outcome.kind === 'one') {
    const apart = opts.apart ?? decidedSets(await engine.listIdentityDecisions()).apart;
    const contact = refKey({ source_id: sourceId, slug });
    const people = new Set([...pages, ...await listEntityIdentities(engine, { entityId: outcome.entityId })].map(refKey));
    if (apart.some(set => { const keys = set.map(refKey); return keys.includes(contact) && keys.some(k => k !== contact && people.has(k)); })) outcome = { kind: 'different', candidates: pages };
    else if (opts.contactName) {
      const verdicts = pages.map(p => titles.get(refKey(p))).filter((t): t is string => !!t).map(t => namesAgree(opts.contactName!, t));
      if (verdicts.length && verdicts.every(v => v === false)) outcome = { kind: 'name_disagrees', candidates: pages };
    }
  }
  const current = (await listEntityIdentities(engine, { slug, slugSourceId: sourceId })).find(m => m.slug === slug && m.source_id === sourceId) ?? null;
  // Another writer's link (the owner's manual link or a dedupe confirm) is a person's decision: never moved or removed here.
  if (current && current.established_by !== origin) return { outcome: outcome.kind, linked: false, unlinked: false, otherWriter: true };
  if (outcome.kind === 'one') {
    if (current?.entity_id === outcome.entityId) return { outcome: 'one', linked: false, unlinked: false };
    if (opts.dryRun) return { outcome: 'one', linked: true, unlinked: !!current };
    const group = await listEntityIdentities(engine, { entityId: outcome.entityId });
    if (!group.some(m => m.slug === outcome.person.slug && m.source_id === outcome.person.source_id)) {
      await linkEntityIdentity(engine, { entityId: outcome.entityId, slug: outcome.person.slug, sourceId: outcome.person.source_id, establishedBy: origin, canonical: true });
    }
    if (current) await unlinkContact(engine, current.entity_id, slug, sourceId, origin);
    await linkEntityIdentity(engine, { entityId: outcome.entityId, slug, sourceId, establishedBy: origin, canonical: false });
    return { outcome: 'one', linked: true, unlinked: !!current };
  }
  if (current && !opts.dryRun) await unlinkContact(engine, current.entity_id, slug, sourceId, origin);
  return { outcome: outcome.kind, linked: false, unlinked: !!current, ...(outcome.kind === 'many' || outcome.kind === 'name_disagrees' ? { candidates: outcome.candidates } : {}) };
}

/** Remove this source's link of a contact page, and the person page's row this source made when it is left alone in the group. */
export async function unlinkContact(engine: BrainEngine, entityId: string, slug: string, sourceId: string, origin = APPLE_CONTACTS_LINK_ORIGIN): Promise<void> {
  await unlinkEntityIdentity(engine, { entityId, slug, sourceId });
  const rest = await listEntityIdentities(engine, { entityId });
  if (rest.length === 1 && rest[0]!.established_by === origin) {
    await unlinkEntityIdentity(engine, { entityId, slug: rest[0]!.slug, sourceId: rest[0]!.source_id });
  }
}

/** Is every candidate inside one set the owner recorded as different people? */
export async function decidedDifferent(engine: BrainEngine, candidates: IdentityMemberRef[]): Promise<boolean> {
  const read = await engine.listIdentityDecisions().catch(() => null);
  if (!read) return false;
  const wanted = candidates.map(refKey);
  return decidedSets(read).apart.some(set => { const keys = new Set(set.map(refKey)); return wanted.every(k => keys.has(k)); });
}

export async function readIdentityReviews(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<IdentityReview[]> {
  const [row] = await engine.executeRaw<{ reviews: unknown }>('SELECT completed_keys AS reviews FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [APPLE_CONTACTS_REVIEW_OP, sourceId]);
  const value = decoded(row?.reviews);
  return Array.isArray(value) ? value as IdentityReview[] : [];
}

export async function writeIdentityReviews(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, reviews: IdentityReview[]): Promise<void> {
  if (!reviews.length) {
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [APPLE_CONTACTS_REVIEW_OP, sourceId]);
    return;
  }
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [APPLE_CONTACTS_REVIEW_OP, sourceId, JSON.stringify([...reviews].sort((a, b) => a.slug.localeCompare(b.slug)))]);
}
