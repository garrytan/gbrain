/**
 * Dedupe v2 (GST-3609), part 1 of the evidence: the person pages, the candidate pairs and their base class. Read-only.
 *
 * A candidate pair is two live person pages that the duplicate finder groups (same or variant name, a shared key, a
 * conflict; groups of more than MAX_GROUP_MEMBERS pages are counted and left out) or that share one exact email or phone
 * (identityEmailKey, canonicalPhone with identity.phone_country_code) carried by at most CROWDED_LIMIT person pages. A
 * pair already in one identity group, a pair the owner recorded as different (gbrain dedupe reject) and a pair one of
 * whose pages names the other in distinct_from are left out.
 *
 * The base class (classify):
 *   C6  a contradiction: an account or registry id each page holds with no value in common, a shared id or contact value
 *       whose names disagree inside one source, a role mailbox, or a shared value a third person page also carries.
 *   C7  two pages in one source, same name, sharing an id or an exact email or phone (collapse candidates).
 *   C3  across sources, an account or registry id both hold (LinkedIn, GitHub, a declared id), names agree.
 *   C1  across sources, an exact email or phone only these two person pages hold, names agree; C2 when they disagree.
 *   C5  name only: the names agree and nothing else is shared.
 * C4 (same full name and company, two or more pages linking both, no other page of that name) is a signal on a C5 pair,
 * set by core/entities/evidence/classes.ts.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import { CROWDED_LIMIT, ROLE_MAILBOXES, findTypedDuplicateGroups, personPageTypes, strictNameFold, type EntityPage } from '../duplicates.ts';
import { namesAgree } from '../name-variants.ts';
import { decidedSets } from '../identity-decisions.ts';
import { withEngineScope } from '../../engine-scope.ts';
import { isOwnerOnlySourceConfig } from '../../access/owner-only.ts';
import { exaQueryFor } from './exa.ts';
import { identityEmailKey } from '../../ops/whois.ts';
import { canonicalPhone, parsePhoneCountryCode, PHONE_COUNTRY_CODE_CONFIG_KEY } from '../../phone-key.ts';

/** A finder group larger than this is a crowded name: its pairs are counted, not read. */
export const MAX_GROUP_MEMBERS = 10;
const PAGE = 2000;

export type BaseClass = 'C1' | 'C2' | 'C3' | 'C5' | 'C6' | 'C7';
export type Sensitivity = 'family' | 'minor';

export interface PersonPage {
  source_id: string;
  slug: string;
  page_id: number;
  title: string;
  /** strictNameFold of the title. */
  strict: string;
  /** Canonical handles: `e:<address>` and `p:<+digits>`. */
  handles: Set<string>;
  company: string | null;
  role: string | null;
  /** A page labelled family or about a minor: never linked automatically, never searched on the web. */
  sensitive: Sensitivity | null;
  /** Not every reader may read it (see readPeople): never searched on the web. */
  restricted: boolean;
  entity_id: string | null;
}

export interface CandidatePair {
  id: string;
  a: PersonPage;
  b: PersonPage;
  base: BaseClass;
  /** namesAgree(a.title, b.title): null when either name is empty or reads as an address or a number. */
  names: boolean | null;
  /** Handles both pages hold. */
  shared: string[];
  why: string[];
}

export interface PeopleScan {
  people: Map<string, PersonPage>;
  /** Person pages carrying each handle (every value, crowded ones included). */
  carriers: Map<string, string[]>;
  /** How many person pages carry each strict name. */
  nameCounts: Map<string, number>;
  pairs: CandidatePair[];
  skipped: { large_groups: number; already_linked: number; decided_apart: number; no_class: number };
  countryCode: string;
}

const PERSON_KEYS = ['email', 'emails', 'phone', 'phones', 'company', 'employer', 'organization', 'job_title', 'role', 'position', 'visibility',
  'readable_by', 'tags', 'groups', 'relationship', 'relation', 'family', 'minor', 'is_minor', 'age', 'born', 'birth_year', 'birthday', 'birthdate'];
const FAMILY_WORDS = new Set(['family', 'spouse', 'wife', 'husband', 'mother', 'father', 'mom', 'mum', 'dad', 'parent', 'son', 'daughter', 'child',
  'sibling', 'brother', 'sister', 'grandmother', 'grandfather', 'grandparent', 'grandchild', 'aunt', 'uncle', 'cousin', 'niece', 'nephew', 'stepson',
  'stepdaughter', 'stepmother', 'stepfather', 'in-law']);
const MINOR_TAGS = new Set(['minor', 'child', 'children', 'kid', 'kids']);

export const pageKey = (p: { source_id: string; slug: string }) => `${p.source_id}\t${p.slug}`;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((s): s is string | number => typeof s === 'string' || typeof s === 'number')
  .map(s => String(s).trim()).filter(Boolean);
const first = (v: unknown) => strings(v)[0] ?? null;
const truthy = (v: unknown) => v === true || (typeof v === 'string' && ['true', 'yes', '1'].includes(v.trim().toLowerCase()));

/** The canonical handle of a chat label or a stored value: an email address or a phone number, else null. */
export function handleOf(raw: string, countryCode: string): string | null {
  const email = identityEmailKey(raw);
  if (email) return `e:${email}`;
  const phone = /^[\s+\d().\-/]+$/.test(raw) ? canonicalPhone(raw, countryCode) : null;
  return phone ? `p:${phone}` : null;
}

export const isRoleHandle = (h: string) => h.startsWith('e:') && ROLE_MAILBOXES.has(h.slice(2, h.indexOf('@')));

/** Family or minor, from tags, groups, a relationship field or a birth year (frontmatter only). */
export function sensitivityOf(keys: Record<string, unknown>, now = new Date()): Sensitivity | null {
  const labels = [...strings(keys.tags), ...strings(keys.groups)].map(s => s.toLowerCase());
  const relation = [...strings(keys.relationship), ...strings(keys.relation)].join(' ').toLowerCase().split(/[^a-z-]+/);
  if (truthy(keys.minor) || truthy(keys.is_minor) || labels.some(l => MINOR_TAGS.has(l))) return 'minor';
  const age = Number(first(keys.age));
  if (Number.isFinite(age) && age > 0 && age < 18) return 'minor';
  for (const f of ['birth_year', 'born', 'birthday', 'birthdate']) {
    const year = Number(/\b(19|20)\d{2}\b/.exec(first(keys[f]) ?? '')?.[0]);
    if (year && now.getUTCFullYear() - year < 18) return 'minor';
  }
  if (truthy(keys.family) || labels.some(l => l.split(/[^a-z]+/).includes('family')) || relation.some(w => FAMILY_WORDS.has(w))) return 'family';
  return null;
}

function toPerson(row: { source_id: string; slug: string; page_id: number; title: string | null; keys: Record<string, unknown>; identity: { entity_id: string } | null }, countryCode: string): PersonPage {
  const k = row.keys;
  const handles = new Set<string>();
  for (const raw of [...strings(k.email), ...strings(k.emails)]) { const e = identityEmailKey(raw); if (e) handles.add(`e:${e}`); }
  for (const raw of [...strings(k.phone), ...strings(k.phones)]) { const p = canonicalPhone(raw, countryCode); if (p) handles.add(`p:${p}`); }
  const visibility = first(k.visibility)?.toLowerCase() ?? 'world';
  const title = row.title ?? '';
  return { source_id: row.source_id, slug: row.slug, page_id: row.page_id, title, strict: strictNameFold(title), handles,
    company: first(k.company) ?? first(k.employer) ?? first(k.organization), role: first(k.job_title) ?? first(k.role) ?? first(k.position),
    sensitive: sensitivityOf(k), restricted: visibility !== 'world' || strings(k.readable_by).length > 0, entity_id: row.identity?.entity_id ?? null };
}

/** Every live person page, keyed by pageKey; `restricted` holds only the frontmatter rule until markRestricted runs. */
export async function readPeople(engine: BrainEngine, countryCode: string): Promise<Map<string, PersonPage>> {
  const types = await personPageTypes(engine);
  const out = new Map<string, PersonPage>();
  for (let after: { source_id: string; slug: string } | undefined; ;) {
    const rows = await engine.listEntityKeyRows({ types, keys: PERSON_KEYS, limit: PAGE, ...(after ? { after } : {}) });
    for (const row of rows) out.set(pageKey(row), toPerson(row, countryCode));
    if (rows.length < PAGE) return out;
    after = { source_id: rows.at(-1)!.source_id, slug: rows.at(-1)!.slug };
  }
}

/** Reads the page again at send time: true while it would still send exactly this query. */
export async function stillSendsQuery(engine: BrainEngine, p: PersonPage, query: string): Promise<boolean> {
  const page = await engine.getPage(p.slug, { sourceId: p.source_id } as never);
  if (!page) return false;
  const keys = Object.fromEntries(PERSON_KEYS.map(k => [k, (page.frontmatter as Record<string, unknown> | undefined)?.[k]]));
  const fresh = toPerson({ source_id: p.source_id, slug: p.slug, page_id: p.page_id, title: page.title, keys, identity: null }, '');
  fresh.sensitive = await tableSensitivity(engine, fresh, fresh.sensitive);
  await markRestricted(engine, [fresh]);
  const q = exaQueryFor(fresh);
  return 'query' in q && q.query === query;
}

/**
 * Marks restricted every page not every reader may read: the frontmatter rule, the shared private-page rule (privacy
 * labels, folder rules, private lineage) and owner-only sources. Only the web search needs it, so only it pays for it.
 */
export async function markRestricted(engine: BrainEngine, pages: Iterable<PersonPage>): Promise<void> {
  const ownerOnly = new Set((await engine.listAllSources({ includeArchived: true })).filter(s => isOwnerOnlySourceConfig(s.config)).map(s => s.id));
  const open = new Map<string, PersonPage>();
  for (const p of pages) {
    if (ownerOnly.has(p.source_id)) p.restricted = true;
    if (!p.restricted) open.set(pageKey(p), p);
  }
  const refs = [...open.values()].map(p => ({ source_id: p.source_id, slug: p.slug }));
  for (let i = 0; i < refs.length; i += PAGE) {
    for (const r of await withEngineScope(engine, () => engine.listRestrictedIdentityMembers(refs.slice(i, i + PAGE)))) open.get(pageKey(r))!.restricted = true;
  }
}

export function pairId(a: { source_id: string; slug: string }, b: { source_id: string; slug: string }): string {
  const [x, y] = [pageKey(a), pageKey(b)].sort();
  return `pair/${createHash('sha256').update(`${x}\n${y}`).digest('hex').slice(0, 16)}`;
}

const exclusiveValues = (p: EntityPage | undefined) => new Map([...p?.keys ?? []].filter(([, k]) => k.key_class === 'exclusive'));

/** The base class of a pair, or null when it is no candidate (names that disagree with nothing shared). */
export function classify(a: PersonPage, b: PersonPage, fa: EntityPage | undefined, fb: EntityPage | undefined, carriers: Map<string, string[]>):
  { base: BaseClass; names: boolean | null; shared: string[]; why: string[] } | null {
  const names = namesAgree(a.title, b.title);
  const sameSource = a.source_id === b.source_id;
  const why: string[] = [];
  const xa = exclusiveValues(fa);
  const xb = exclusiveValues(fb);
  let sharedId = false;
  let differingId = false;
  for (const [id, ka] of xa) {
    const kb = xb.get(id);
    if (!kb) continue;
    if ([...ka.values].some(v => kb.values.has(v))) { sharedId = true; why.push(`shared ${ka.key}`); } else { differingId = true; why.push(`different ${ka.key}`); }
  }
  const shared = [...a.handles].filter(h => b.handles.has(h)).sort();
  if (differingId && !sharedId) return { base: 'C6', names, shared, why };
  if (sharedId) {
    if (names !== true) return { base: 'C6', names, shared, why: [...why, 'names disagree'] };
    return { base: sameSource ? 'C7' : 'C3', names, shared, why };
  }
  if (shared.length) {
    why.push(...shared.map(h => (h.startsWith('e:') ? 'shared email' : 'shared phone')));
    if (shared.some(isRoleHandle)) return { base: 'C6', names, shared, why: [...why, 'role address'] };
    if (shared.some(h => (carriers.get(h)?.length ?? 0) > 2)) return { base: 'C6', names, shared, why: [...why, 'a third person page holds it'] };
    if (sameSource) return names === true ? { base: 'C7', names, shared, why } : { base: 'C6', names, shared, why: [...why, 'names disagree'] };
    return { base: names === true ? 'C1' : 'C2', names, shared, why };
  }
  if (names === true) return { base: 'C5', names, shared, why: ['names agree'] };
  return null;
}

/** Read the person pages and build every candidate pair with its base class. */
export async function scanPeople(engine: BrainEngine): Promise<PeopleScan> {
  const countryCode = parsePhoneCountryCode(await engine.getConfig(PHONE_COUNTRY_CODE_CONFIG_KEY));
  const decided = decidedSets(await engine.listIdentityDecisions());
  const { result, kindOf, pages: finderPages } = await findTypedDuplicateGroups(engine, { decided });
  const people = await readPeople(engine, countryCode);
  const carriers = new Map<string, string[]>();
  const nameCounts = new Map<string, number>();
  for (const [key, p] of people) {
    for (const h of p.handles) carriers.set(h, [...(carriers.get(h) ?? []), key]);
    if (p.strict) nameCounts.set(p.strict, (nameCounts.get(p.strict) ?? 0) + 1);
  }
  const apart = new Map<string, Set<string>>();
  for (const set of decided.apart) for (const m of set) {
    const others = apart.get(pageKey(m)) ?? new Set<string>();
    for (const o of set) if (pageKey(o) !== pageKey(m)) others.add(pageKey(o));
    apart.set(pageKey(m), others);
  }
  const skipped = { large_groups: 0, already_linked: 0, decided_apart: 0, no_class: 0 };
  const proposed = new Set<string>();
  const propose = (keys: string[]) => {
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) proposed.add([keys[i]!, keys[j]!].sort().join('\n'));
  };
  for (const g of result.groups) {
    if (kindOf.get(g.id) !== 'person') continue;
    if (g.members.length > MAX_GROUP_MEMBERS) { skipped.large_groups++; continue; }
    propose(g.members.map(pageKey));
  }
  for (const keys of carriers.values()) if (keys.length > 1 && keys.length <= CROWDED_LIMIT) propose(keys);

  const pairs: CandidatePair[] = [];
  for (const k of [...proposed].sort()) {
    const [ka, kb] = k.split('\n') as [string, string];
    const a = people.get(ka);
    const b = people.get(kb);
    if (!a || !b) continue;
    if (a.entity_id && a.entity_id === b.entity_id) { skipped.already_linked++; continue; }
    const fa = finderPages.get(ka);
    const fb = finderPages.get(kb);
    if (apart.get(ka)?.has(kb) || fa?.distinctFrom.has(b.slug) && a.source_id === b.source_id || fb?.distinctFrom.has(a.slug) && a.source_id === b.source_id) {
      skipped.decided_apart++;
      continue;
    }
    const c = classify(a, b, fa, fb, carriers);
    if (!c) { skipped.no_class++; continue; }
    pairs.push({ id: pairId(a, b), a, b, ...c });
  }
  const paired = new Map<string, PersonPage>();
  for (const p of pairs) { paired.set(pageKey(p.a), p.a); paired.set(pageKey(p.b), p.b); }
  for (const p of paired.values()) p.sensitive = await tableSensitivity(engine, p, p.sensitive);
  return { people, carriers, nameCounts, pairs, skipped, countryCode };
}

/** Folds in tags added with `gbrain tag` or add_tag, which live only in the tags table, never in frontmatter. */
async function tableSensitivity(engine: BrainEngine, p: { slug: string; source_id: string }, fromFrontmatter: Sensitivity | null): Promise<Sensitivity | null> {
  if (fromFrontmatter === 'minor') return fromFrontmatter;
  return sensitivityOf({ tags: await engine.getTags(p.slug, { sourceId: p.source_id }) }) ?? fromFrontmatter;
}
