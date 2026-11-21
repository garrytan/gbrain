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
  /** The owner recorded the candidates as different people (gbrain dedupe reject): nothing is waiting on them. */
  decided?: 'different';
}

export type MatchOutcome = { kind: 'one'; entityId: string; person: IdentityMemberRef } | { kind: 'none' } | { kind: 'many'; candidates: IdentityMemberRef[] };

const decoded = (value: unknown): unknown => {
  if (typeof value !== 'string' || !/^[[{"]/.test(value)) return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
};
const strings = (value: unknown): string[] => { const v = decoded(value); return (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === 'string'); };
const refKey = (m: IdentityMemberRef) => `${m.source_id}\t${m.slug}`;

/** The person pages (outside this source) whose email or phone equals one of the contact's, exactly. */
export async function exactPersonMatches(engine: BrainEngine, sourceId: string, emails: string[], phones: string[], countryCode: string): Promise<{ pages: IdentityMemberRef[]; truncated: boolean }> {
  const emailKeys = [...new Set(emails.map(e => identityEmailKey(e)).filter((e): e is string => !!e))];
  const phoneKeys = [...new Set(phones.map(p => canonicalPhone(p, countryCode)).filter((p): p is string => !!p))];
  if (!emailKeys.length && !phoneKeys.length) return { pages: [], truncated: false };
  const sourceIds = (await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE archived IS NOT TRUE AND id <> $1 AND COALESCE(config->>'kind','') NOT IN (${CONNECTOR_KINDS_SQL}) ORDER BY id`, [sourceId])).map(r => r.id);
  if (!sourceIds.length) return { pages: [], truncated: false };
  const { text, params } = exactIdentityStatement({
    probes: { titleKeys: [], titleRaw: '', basenames: [], aliasKeys: [], emails: [...new Set([...emails.map(e => e.trim()), ...emailKeys])],
      phones: [...new Set(phoneKeys.flatMap(p => phoneProbeDigits(p, countryCode)))] },
    sourceIds, types: { types: ['person'], per_source: [] }, limit: CANDIDATE_CAP + 1,
  });
  const rows = await engine.executeRaw<ExactIdentityRow>(text, params);
  const matches = rows.slice(0, CANDIDATE_CAP).filter(row =>
    [...strings(row.email), ...strings(row.emails)].some(v => { const k = identityEmailKey(v); return !!k && emailKeys.includes(k); })
    || [...strings(row.phone), ...strings(row.phones)].some(v => { const k = canonicalPhone(v, countryCode); return !!k && phoneKeys.includes(k); }));
  return { pages: matches.map(r => ({ source_id: r.source_id, slug: r.slug })), truncated: rows.length > CANDIDATE_CAP };
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

export interface LinkResult { outcome: MatchOutcome['kind']; linked: boolean; unlinked: boolean; candidates?: IdentityMemberRef[] }

/** Match one contact page and bring its identity link in line with the outcome. */
export async function linkContactPage(engine: BrainEngine, sourceId: string, slug: string, emails: string[], phones: string[], countryCode: string): Promise<LinkResult> {
  const { pages, truncated } = await exactPersonMatches(engine, sourceId, emails, phones, countryCode);
  const outcome = await outcomeOf(engine, pages, truncated);
  const current = (await listEntityIdentities(engine, { slug, slugSourceId: sourceId })).find(m => m.slug === slug && m.source_id === sourceId) ?? null;
  // Another writer's link (the owner's manual link or a dedupe confirm) is a person's decision: never moved or removed here.
  if (current && current.established_by !== APPLE_CONTACTS_LINK_ORIGIN) return { outcome: outcome.kind, linked: false, unlinked: false };
  if (outcome.kind === 'one') {
    if (current?.entity_id === outcome.entityId) return { outcome: 'one', linked: false, unlinked: false };
    const group = await listEntityIdentities(engine, { entityId: outcome.entityId });
    if (!group.some(m => m.slug === outcome.person.slug && m.source_id === outcome.person.source_id)) {
      await linkEntityIdentity(engine, { entityId: outcome.entityId, slug: outcome.person.slug, sourceId: outcome.person.source_id, establishedBy: APPLE_CONTACTS_LINK_ORIGIN, canonical: true });
    }
    if (current) await unlinkContact(engine, current.entity_id, slug, sourceId);
    await linkEntityIdentity(engine, { entityId: outcome.entityId, slug, sourceId, establishedBy: APPLE_CONTACTS_LINK_ORIGIN, canonical: false });
    return { outcome: 'one', linked: true, unlinked: !!current };
  }
  if (current) await unlinkContact(engine, current.entity_id, slug, sourceId);
  return { outcome: outcome.kind, linked: false, unlinked: !!current, ...(outcome.kind === 'many' ? { candidates: outcome.candidates } : {}) };
}

/** Remove this source's link of a contact page, and the person page's row this source made when it is left alone in the group. */
export async function unlinkContact(engine: BrainEngine, entityId: string, slug: string, sourceId: string): Promise<void> {
  await unlinkEntityIdentity(engine, { entityId, slug, sourceId });
  const rest = await listEntityIdentities(engine, { entityId });
  if (rest.length === 1 && rest[0]!.established_by === APPLE_CONTACTS_LINK_ORIGIN) {
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
