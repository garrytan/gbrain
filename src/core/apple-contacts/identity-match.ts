/**
 * Tie a contact page to the person page it describes, by exact email or exact phone only (never by name), through the
 * candidate read behind whois (engine-sql/exact-identity.ts) and the identity groups of entity-identity.ts:
 *
 *   - exactly one person: the contact page joins that person's identity group (one is made, with the person page as
 *     its canonical member, when the person page has none). With collapseMirrors (the Google Contacts linker), copies
 *     of one person page in other sources (the same slug, the same matched keys and a name that agrees: mirrorSets)
 *     are one person, and all of them join the group, with the default source's copy as canonical. Only entity_identities rows are written; the person page
 *     itself, its file and its frontmatter, are never touched.
 *   - no person: no link (a link this source made earlier is removed).
 *   - two or more: no link. The case is recorded as an identity review for the owner, which gbrain sync status lists
 *     as needing a person. It settles itself on a later run once the owner confirms the candidates are one person
 *     (gbrain dedupe confirm: they then share one identity group) or records them as different people (gbrain dedupe
 *     reject: the review stays, marked decided, and the contact stays unlinked).
 *   - a candidate the owner recorded as a different person from the contact (gbrain dedupe reject or decide) is dropped,
 *     pair by pair: with none left there is no link (outcome different); with some left the contact waits on them.
 *   - a contact the owner marked as not a person (a one-member "different" decision, gbrain dedupe decide ignore): no
 *     link and no review (outcome ignored).
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
import { CONNECTOR_KINDS_SQL, isConnectorSourceKind } from '../persistence/connector-kinds.ts';
import { DEFAULT_SOURCE_ID } from '../sync-failure-ledger.ts';
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

/** person: the canonical page; members: every matched page of that person (copies of one page in other sources included). */
export type MatchOutcome = { kind: 'one'; entityId: string; person: IdentityMemberRef; members: IdentityMemberRef[] } | { kind: 'none' } | { kind: 'many'; candidates: IdentityMemberRef[] }
  | { kind: 'different'; candidates: IdentityMemberRef[] } | { kind: 'name_disagrees'; candidates: IdentityMemberRef[] } | { kind: 'ignored' };

/** Which of a contact's keys matched a candidate: the kind only, never the value. */
export type MatchedKey = 'email' | 'phone';

const decoded = (value: unknown): unknown => {
  if (typeof value !== 'string' || !/^[[{"]/.test(value)) return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
};
const strings = (value: unknown): string[] => { const v = decoded(value); return (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === 'string'); };
const refKey = (m: IdentityMemberRef) => `${m.source_id}\t${m.slug}`;

/** The person pages (outside this source) whose email or phone equals one of the contact's, exactly, with the kinds of key that matched. */
export interface ExactPersonMatches {
  pages: IdentityMemberRef[];
  truncated: boolean;
  titles: Map<string, string>;
  /** By candidate (source_id, tab, slug): the kinds of key that matched. */
  matched: Map<string, MatchedKey[]>;
  /** By candidate: the normalized keys that matched, for comparing copies of one page; never printed. */
  keys: Map<string, string[]>;
}

export async function exactPersonMatches(engine: BrainEngine, sourceId: string, emails: string[], phones: string[], countryCode: string): Promise<ExactPersonMatches> {
  const emailKeys = [...new Set(emails.map(e => identityEmailKey(e)).filter((e): e is string => !!e))];
  const phoneKeys = [...new Set(phones.map(p => canonicalPhone(p, countryCode)).filter((p): p is string => !!p))];
  if (!emailKeys.length && !phoneKeys.length) return { pages: [], truncated: false, titles: new Map(), matched: new Map(), keys: new Map() };
  const sourceIds = (await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE archived IS NOT TRUE AND id <> $1 AND COALESCE(config->>'kind','') NOT IN (${CONNECTOR_KINDS_SQL}) ORDER BY id COLLATE "C"`, [sourceId])).map(r => r.id);
  if (!sourceIds.length) return { pages: [], truncated: false, titles: new Map(), matched: new Map(), keys: new Map() };
  const { text, params } = exactIdentityStatement({
    probes: { titleKeys: [], titleRaw: '', basenames: [], aliasKeys: [], emails: [...new Set([...emails.map(e => e.trim()), ...emailKeys])],
      phones: [...new Set(phoneKeys.flatMap(p => phoneProbeDigits(p, countryCode)))] },
    sourceIds, types: { types: ['person'], per_source: [] }, limit: CANDIDATE_CAP + 1,
  });
  const rows = await engine.executeRaw<ExactIdentityRow>(text, params);
  const matched = new Map<string, MatchedKey[]>();
  const keys = new Map<string, string[]>();
  for (const row of rows.slice(0, CANDIDATE_CAP)) {
    const mails = [...strings(row.email), ...strings(row.emails)].map(v => identityEmailKey(v)).filter((k): k is string => !!k && emailKeys.includes(k));
    const nums = [...strings(row.phone), ...strings(row.phones)].map(v => canonicalPhone(v, countryCode)).filter((k): k is string => !!k && phoneKeys.includes(k));
    if (!mails.length && !nums.length) continue;
    matched.set(refKey(row), [...(mails.length ? ['email' as const] : []), ...(nums.length ? ['phone' as const] : [])]);
    keys.set(refKey(row), [...new Set([...mails.map(k => `email:${k}`), ...nums.map(k => `phone:${k}`)])].sort());
  }
  const matches = rows.slice(0, CANDIDATE_CAP).filter(row => matched.has(refKey(row)));
  return { pages: matches.map(r => ({ source_id: r.source_id, slug: r.slug })), truncated: rows.length > CANDIDATE_CAP,
    titles: new Map(matches.filter(r => r.title).map(r => [refKey(r), r.title!])), matched, keys };
}

/**
 * Copies of one page: candidates with the same slug in several sources that carry exactly the same matched keys under
 * names that agree, as when a person page is mirrored into read-only copies of other sources. Each set lists the
 * default source's copy first; every other candidate is a set of one. Copies that disagree on a key, or that the owner
 * recorded as different people (apart), stay apart.
 */
export function mirrorSets(pages: IdentityMemberRef[], m: Pick<ExactPersonMatches, 'keys' | 'titles'>, apart: IdentityMemberRef[][] = []): IdentityMemberRef[][] {
  const bySlug = new Map<string, IdentityMemberRef[]>();
  for (const page of pages) bySlug.set(page.slug, [...bySlug.get(page.slug) ?? [], page]);
  const sig = (page: IdentityMemberRef) => (m.keys.get(refKey(page)) ?? []).join('\n');
  const out: IdentityMemberRef[][] = [];
  for (const copies of bySlug.values()) {
    const first = copies[0]!;
    const name = m.titles.get(refKey(first));
    const keys = copies.map(refKey);
    const one = copies.length > 1 && !!sig(first) && !!name && copies.every(c => {
      const t = m.titles.get(refKey(c));
      return sig(c) === sig(first) && !!t && (t === name || namesAgree(name, t) === true);
    }) && !apart.some(set => set.filter(x => keys.includes(refKey(x))).length > 1);
    if (!one) { for (const c of copies) out.push([c]); continue; }
    out.push([...copies].sort((a, b) => Number(b.source_id === DEFAULT_SOURCE_ID) - Number(a.source_id === DEFAULT_SOURCE_ID) || (a.source_id < b.source_id ? -1 : 1)));
  }
  return out;
}

/**
 * Matched pages counted as people: pages in one identity group are one person, and so are the copies of one page
 * (mirrorSets) when all of them sit in the same identity group or none does, so collapsing never grows a group.
 */
async function outcomeOf(engine: BrainEngine, pages: IdentityMemberRef[], truncated: boolean, m: Pick<ExactPersonMatches, 'keys' | 'titles'> | null, apart: IdentityMemberRef[][]): Promise<MatchOutcome> {
  if (!pages.length) return { kind: 'none' };
  const entityOf = new Map(await Promise.all(pages.map(async page => [refKey(page), (await listEntityIdentities(engine, { slug: page.slug, slugSourceId: page.source_id }))
    .find(x => x.slug === page.slug && x.source_id === page.source_id)?.entity_id ?? null] as const)));
  const groups = new Map<string, IdentityMemberRef[]>();
  for (const set of m ? mirrorSets(pages, m, apart) : pages.map(p => [p])) {
    const entities = new Set(set.map(p => entityOf.get(refKey(p)) ?? null));
    for (const unit of entities.size > 1 ? set.map(p => [p]) : [set]) {
      const entity = unit.map(p => entityOf.get(refKey(p))).find(e => !!e);
      const key = entity ? `entity:${entity}` : `page:${refKey(unit[0]!)}`;
      groups.set(key, [...groups.get(key) ?? [], ...unit]);
    }
  }
  if (groups.size > 1 || truncated) return { kind: 'many', candidates: pages };
  const [key, members] = [...groups][0]!;
  const person = members.find(p => p.source_id === DEFAULT_SOURCE_ID) ?? members[0]!;
  return { kind: 'one', person, members, entityId: key.startsWith('entity:') ? key.slice('entity:'.length)
    : `person-${createHash('sha256').update(refKey(person)).digest('hex').slice(0, 16)}` };
}

/** otherWriter: the contact page is in an identity group another writer made, which is left as it is. matched: by candidate (source_id, tab, slug). */
export interface LinkResult { outcome: MatchOutcome['kind']; linked: boolean; unlinked: boolean; candidates?: IdentityMemberRef[]; otherWriter?: boolean; matched?: Map<string, MatchedKey[]>; titles?: Map<string, string>; sets?: IdentityMemberRef[][] }

export interface LinkOptions {
  /** established_by of the rows this linker writes; only its own rows are moved or removed. */
  origin?: string;
  /** The sets the owner recorded as different people (decidedSets().apart); read here when not given. */
  apart?: IdentityMemberRef[][];
  /** Decide and report the outcome without writing. */
  dryRun?: boolean;
  /** The contact's name: a single match whose page names clearly disagree with it is not linked (outcome name_disagrees). */
  contactName?: string;
  /** Count the copies of one page in other sources as one person (mirrorSets); the Google Contacts linker sets it. */
  collapseMirrors?: boolean;
}

/** Match one contact page and bring its identity link in line with the outcome. */
export async function linkContactPage(engine: BrainEngine, sourceId: string, slug: string, emails: string[], phones: string[], countryCode: string,
  opts: LinkOptions = {}): Promise<LinkResult> {
  const origin = opts.origin ?? APPLE_CONTACTS_LINK_ORIGIN;
  const apart = opts.apart ?? decidedSets(await engine.listIdentityDecisions()).apart;
  const contact = refKey({ source_id: sourceId, slug });
  const decided = apart.filter(set => set.some(m => refKey(m) === contact));
  const found = await exactPersonMatches(engine, sourceId, emails, phones, countryCode);
  const { pages, truncated, titles, matched } = found;
  let outcome: MatchOutcome;
  if (decided.some(set => set.length === 1)) outcome = { kind: 'ignored' };
  else {
    const rejected = new Set(decided.flatMap(set => set.map(refKey)).filter(k => k !== contact));
    const kept: IdentityMemberRef[] = [];
    for (const page of pages) {
      if (rejected.size) {
        const entity = (await listEntityIdentities(engine, { slug: page.slug, slugSourceId: page.source_id })).find(m => m.slug === page.slug && m.source_id === page.source_id)?.entity_id;
        const people = entity ? (await listEntityIdentities(engine, { entityId: entity })).map(refKey) : [refKey(page)];
        if (people.some(k => rejected.has(k))) continue;
      }
      kept.push(page);
    }
    outcome = pages.length && !kept.length ? { kind: 'different', candidates: pages } : await outcomeOf(engine, kept, truncated, opts.collapseMirrors ? found : null, apart);
    if (outcome.kind === 'one' && kept.length < pages.length) outcome = { kind: 'many', candidates: kept };
    else if (outcome.kind === 'one' && opts.contactName) {
      const verdicts = kept.map(p => titles.get(refKey(p))).filter((t): t is string => !!t).map(t => namesAgree(opts.contactName!, t));
      if (verdicts.length && verdicts.every(v => v === false)) outcome = { kind: 'name_disagrees', candidates: kept };
    }
  }
  const current = (await listEntityIdentities(engine, { slug, slugSourceId: sourceId })).find(m => m.slug === slug && m.source_id === sourceId) ?? null;
  // Another writer's link (the owner's manual link or a dedupe confirm) is a person's decision: never moved or removed here.
  if (current && current.established_by !== origin) return { outcome: outcome.kind, linked: false, unlinked: false, otherWriter: true };
  if (outcome.kind === 'one') {
    const { entityId, person } = outcome;
    const group = await listEntityIdentities(engine, { entityId });
    const missing = outcome.members.filter(p => !group.some(g => g.slug === p.slug && g.source_id === p.source_id));
    const moves = current?.entity_id !== entityId;
    if (!moves && !missing.length) return { outcome: 'one', linked: false, unlinked: false };
    if (opts.dryRun) return { outcome: 'one', linked: moves, unlinked: moves && !!current };
    const hasCanonical = group.some(g => g.canonical);
    for (const p of missing) {
      await linkEntityIdentity(engine, { entityId, slug: p.slug, sourceId: p.source_id, establishedBy: origin, canonical: !hasCanonical && refKey(p) === refKey(person) });
    }
    if (!moves) return { outcome: 'one', linked: false, unlinked: false };
    if (current) await unlinkContact(engine, current.entity_id, slug, sourceId, origin);
    await linkEntityIdentity(engine, { entityId, slug, sourceId, establishedBy: origin, canonical: false });
    return { outcome: 'one', linked: true, unlinked: !!current };
  }
  if (current && !opts.dryRun) await unlinkContact(engine, current.entity_id, slug, sourceId, origin);
  return { outcome: outcome.kind, linked: false, unlinked: !!current, ...(outcome.kind === 'many' || outcome.kind === 'name_disagrees' ? { candidates: outcome.candidates, matched, titles, ...(opts.collapseMirrors ? { sets: mirrorSets(outcome.candidates, found, apart) } : {}) } : {}) };
}

/**
 * Remove this source's link of a contact page, and the person page rows this linker made (the page and its copies in
 * other sources) when no contact page of any connector source and no other writer's row is left in the group.
 */
export async function unlinkContact(engine: BrainEngine, entityId: string, slug: string, sourceId: string, origin = APPLE_CONTACTS_LINK_ORIGIN): Promise<void> {
  await unlinkEntityIdentity(engine, { entityId, slug, sourceId });
  const rest = await listEntityIdentities(engine, { entityId });
  if (!rest.length || rest.some(r => r.established_by !== origin)) return;
  const kinds = new Map(await Promise.all([...new Set(rest.map(r => r.source_id))].map(async id => [id, (await engine.getSource(id))?.config?.kind] as const)));
  if (rest.every(r => !isConnectorSourceKind(kinds.get(r.source_id)))) {
    for (const r of rest) await unlinkEntityIdentity(engine, { entityId, slug: r.slug, sourceId: r.source_id });
  }
}

/** Is every candidate inside one set the owner recorded as different people? */
export async function decidedDifferent(engine: BrainEngine, candidates: IdentityMemberRef[]): Promise<boolean> {
  const read = await engine.listIdentityDecisions().catch(() => null);
  if (!read) return false;
  const wanted = candidates.map(refKey);
  if (wanted.length < 2) return false;
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
