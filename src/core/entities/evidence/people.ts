/**
 * Dedupe v2 (GST-3609), part 1 of the evidence: the person pages, the candidate pairs and their base class. Read-only.
 *
 * A candidate pair is two live person pages that the duplicate finder groups (same or variant name, a shared key, a
 * conflict; groups of more than MAX_GROUP_MEMBERS pages are counted and left out) or that share one exact email or phone
 * (identityEmailKey, canonicalPhone with identity.phone_country_code) carried by at most CROWDED_LIMIT person pages. A
 * pair already in one identity group, a pair the owner recorded as different (gbrain dedupe reject) and a pair one of
 * whose pages names the other in distinct_from are left out. So are mirror copies (isCopy: one page kept under the same
 * slug in two sources, same name, nothing that disagrees): a copy pair is no duplicate, and of the pairs that differ only
 * by which copy they hold, the one with the most default-source pages is kept.
 *
 * The base class (classify):
 *   C6  a contradiction: an account or registry id each page holds with no value in common, a shared id or contact value
 *       whose names disagree inside one source, a role mailbox, or a shared value a third person page also carries. A
 *       shared id that a person page with another name also holds (ids copied between cofounders' pages) proves
 *       nothing, so a pair whose only shared ids are such ids is C6 too.
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
import { DEFAULT_SOURCE_ID } from '../../sync-failure-ledger.ts';

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
  /** A page labelled family or about a minor, read broadly: never searched on the web. */
  sensitive: Sensitivity | null;
  /** The same label read for linking (sensitivityOf with use 'link'): a pair with such a page never links automatically. */
  hold: Sensitivity | null;
  /** The title reads as a room, a team, a mailbox or a business (readsAsNonPerson): never linked automatically. */
  nonPerson: boolean;
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
  skipped: { large_groups: number; already_linked: number; decided_apart: number; no_class: number; copies: number };
  countryCode: string;
}

const PERSON_KEYS = ['email', 'emails', 'phone', 'phones', 'company', 'employer', 'organization', 'job_title', 'role', 'position', 'visibility',
  'readable_by', 'tags', 'groups', 'relationship', 'relation', 'family', 'minor', 'is_minor', 'age', 'born', 'birth_year', 'birthday', 'birthdate'];
const FAMILY_WORDS = new Set(['family', 'spouse', 'wife', 'husband', 'mother', 'father', 'mom', 'mum', 'dad', 'parent', 'son', 'daughter', 'child',
  'sibling', 'brother', 'sister', 'grandmother', 'grandfather', 'grandparent', 'grandchild', 'aunt', 'uncle', 'cousin', 'niece', 'nephew', 'stepson',
  'stepdaughter', 'stepmother', 'stepfather', 'in-law', 'son-in-law', 'daughter-in-law', 'mother-in-law', 'father-in-law', 'brother-in-law',
  'sister-in-law']);
const MINOR_TAGS = new Set(['minor', 'child', 'children', 'kid', 'kids']);
/** A label word right after "family" that names something other than the owner's family (a family office, family friends). */
const NOT_FAMILY_LABEL = new Set(['office', 'offices', 'friend', 'friends', 'foundation']);
/** Someone other than the owner, who can own a relative: "wife of a colleague", "a friend's son". */
const OTHER_OWNERS = new Set(['friend', 'friends', 'colleague', 'colleagues', 'coworker', 'co-worker', 'client', 'customer', 'neighbor',
  'neighbour', 'boss', 'manager', 'investor', 'founder', 'cofounder', 'co-founder', 'employee', 'classmate', 'teammate', 'acquaintance']);
const familyWords = (s: string) => s.split(/[^a-z-]+/).filter(w => FAMILY_WORDS.has(w));
/**
 * One relationship value's family words, less those a friend, colleague or client owns ("wife of a colleague", "a
 * friend's son") and less a school parent. Any other owner ("mother of Emma", "husband of ten years") is the owner's own.
 */
function ownFamilyWords(value: string): string[] {
  if (/(^|[^a-z])school([^a-z]|$)/.test(value) && familyWords(value).every(w => w === 'parent')) return [];
  return familyWords(value
    .replace(/([a-z-]+)\s+of\s+(?:(?:a|an|the|his|her|their)\s+)?([a-z-]+)/g, (m, x: string, y: string) => (FAMILY_WORDS.has(x) && OTHER_OWNERS.has(y) ? ' ' : m))
    .replace(/([a-z-]+)'s\s+([a-z-]+)/g, (m, y: string, x: string) => (FAMILY_WORDS.has(x) && OTHER_OWNERS.has(y) ? ' ' : m)));
}
/** Under 18 at `now`, from a birth date or a birth year; a year alone counts as under 18 through the year of the 18th birthday. */
function bornUnder18(v: unknown, now: Date): boolean {
  const raw = Array.isArray(v) ? v[0] : v;
  const m = /\b((?:19|20)\d{2})(?:-(\d{2})-(\d{2}))?\b/.exec(raw instanceof Date ? raw.toISOString() : first(raw) ?? '');
  if (!m) return false;
  const years = now.getUTCFullYear() - Number(m[1]);
  if (!m[2]) return years <= 18;
  return years - (`${m[2]}-${m[3]}` > now.toISOString().slice(5, 10) ? 1 : 0) < 18;
}
const NON_PERSON_WORDS = new Set(['team', 'teams', 'room', 'rooms', 'office', 'offices', 'mailbox', 'inbox', 'desk', 'department', 'committee',
  'service', 'services', 'support', 'helpdesk', 'noreply', 'partners', 'fund', 'funds', 'construction', 'inc', 'llc', 'ltd', 'corp', 'corporation',
  'group', 'conference']);
const NON_PERSON_PARTS = ['clientservice', 'customerservice', 'support', 'mailbox', 'inbox', 'noreply', 'helpdesk'];

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

/**
 * Family or minor, from tags, groups, a relationship field or a birth date (frontmatter only). use 'web' (the Exa block)
 * reads every family word; use 'link' (the hold on automatic links) judges each relationship value on its own and leaves
 * out labels and values that are only someone else's: a family office, family friends, "wife of a colleague", a school
 * parent. The minor rules are the same for both.
 */
export function sensitivityOf(keys: Record<string, unknown>, now = new Date(), use: 'web' | 'link' = 'web'): Sensitivity | null {
  const labels = [...strings(keys.tags), ...strings(keys.groups)].map(s => s.toLowerCase());
  const relation = [...strings(keys.relationship), ...strings(keys.relation)].map(s => s.toLowerCase())
    .flatMap(v => (use === 'link' ? ownFamilyWords(v) : familyWords(v)));
  const familyLabel = (l: string) => {
    const words = l.split(/[^a-z]+/);
    return words.some((w, i) => w === 'family' && !(use === 'link' && NOT_FAMILY_LABEL.has(words[i + 1] ?? '')));
  };
  if (truthy(keys.minor) || truthy(keys.is_minor) || labels.some(l => MINOR_TAGS.has(l))) return 'minor';
  const age = Number(first(keys.age));
  if (Number.isFinite(age) && age > 0 && age < 18) return 'minor';
  if (['birth_year', 'born', 'birthday', 'birthdate'].some(f => bornUnder18(keys[f], now))) return 'minor';
  if (truthy(keys.family) || labels.some(familyLabel) || relation.length) return 'family';
  return null;
}

/** A title that names a room, a team, a shared mailbox or a business rather than a person. */
export function readsAsNonPerson(title: string): boolean {
  const words = title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.some(w => NON_PERSON_WORDS.has(w))) return true;
  return words.length === 1 && NON_PERSON_PARTS.some(p => words[0]!.includes(p));
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
    sensitive: sensitivityOf(k), hold: sensitivityOf(k, new Date(), 'link'), nonPerson: readsAsNonPerson(title),
    restricted: visibility !== 'world' || strings(k.readable_by).length > 0, entity_id: row.identity?.entity_id ?? null };
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
  await foldTags(engine, fresh);
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

/** Person pages carrying each account or registry id value, keyed `<key>:<field>\t<value>`. */
export type IdCarriers = Map<string, PersonPage[]>;

/**
 * The base class of a pair, or null when it is no candidate (names that disagree with nothing shared). A shared id value
 * counts as proof only while no person page carrying it has a name that disagrees with either page of the pair.
 */
export function classify(a: PersonPage, b: PersonPage, fa: EntityPage | undefined, fb: EntityPage | undefined, carriers: Map<string, string[]>,
  idCarriers: IdCarriers = new Map()): { base: BaseClass; names: boolean | null; shared: string[]; why: string[] } | null {
  const names = namesAgree(a.title, b.title);
  const sameSource = a.source_id === b.source_id;
  const why: string[] = [];
  const xa = exclusiveValues(fa);
  const xb = exclusiveValues(fb);
  const contested = (id: string, v: string) => (idCarriers.get(`${id}\t${v}`) ?? [])
    .some(p => namesAgree(p.title, a.title) === false || namesAgree(p.title, b.title) === false);
  let sharedId = false;
  let contestedId = false;
  let differingId = false;
  for (const [id, ka] of xa) {
    const kb = xb.get(id);
    if (!kb) continue;
    const common = [...ka.values].filter(v => kb.values.has(v));
    if (!common.length) { differingId = true; why.push(`different ${ka.key}`); continue; }
    if (common.every(v => contested(id, v))) { contestedId = true; why.push(`shared ${ka.key} also on a page with another name`); }
    else { sharedId = true; why.push(`shared ${ka.key}`); }
  }
  const shared = [...a.handles].filter(h => b.handles.has(h)).sort();
  if (!sharedId && (differingId || contestedId)) return { base: 'C6', names, shared, why };
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

const sameValue = (x: string | null, y: string | null) => !x || !y || x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === y.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const within = (x: Set<string>, y: Set<string>) => [...x].every(h => y.has(h));

/** One page kept under the same slug in two sources: the same name, and no company, role, email or phone that disagrees. */
export function isCopy(x: PersonPage, y: PersonPage): boolean {
  return x.slug === y.slug && x.source_id !== y.source_id && !!x.strict && x.strict === y.strict && sameValue(x.company, y.company)
    && sameValue(x.role, y.role) && (within(x.handles, y.handles) || within(y.handles, x.handles));
}

/** Read the person pages and build every candidate pair with its base class. */
export async function scanPeople(engine: BrainEngine): Promise<PeopleScan> {
  const countryCode = parsePhoneCountryCode(await engine.getConfig(PHONE_COUNTRY_CODE_CONFIG_KEY));
  const decided = decidedSets(await engine.listIdentityDecisions());
  const { result, kindOf, pages: finderPages } = await findTypedDuplicateGroups(engine, { decided });
  const people = await readPeople(engine, countryCode);
  const carriers = new Map<string, string[]>();
  const nameCounts = new Map<string, number>();
  const bySlug = new Map<string, PersonPage[]>();
  const idCarriers: IdCarriers = new Map();
  for (const [key, p] of people) {
    for (const h of p.handles) carriers.set(h, [...(carriers.get(h) ?? []), key]);
    if (p.strict) nameCounts.set(p.strict, (nameCounts.get(p.strict) ?? 0) + 1);
    bySlug.set(p.slug, [...(bySlug.get(p.slug) ?? []), p]);
    for (const [id, k] of exclusiveValues(finderPages.get(key))) for (const v of k.values) idCarriers.set(`${id}\t${v}`, [...(idCarriers.get(`${id}\t${v}`) ?? []), p]);
  }
  const mirrorOf = (p: PersonPage) => ((bySlug.get(p.slug) ?? []).some(o => isCopy(p, o)) ? `copy\t${p.slug}` : pageKey(p));
  const apart = new Map<string, Set<string>>();
  for (const set of decided.apart) for (const m of set) {
    const others = apart.get(pageKey(m)) ?? new Set<string>();
    for (const o of set) if (pageKey(o) !== pageKey(m)) others.add(pageKey(o));
    apart.set(pageKey(m), others);
  }
  const skipped = { large_groups: 0, already_linked: 0, decided_apart: 0, no_class: 0, copies: 0 };
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

  const found: CandidatePair[] = [];
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
    const c = classify(a, b, fa, fb, carriers, idCarriers);
    if (!c) { skipped.no_class++; continue; }
    if (c.base !== 'C6' && isCopy(a, b)) { skipped.copies++; continue; }
    found.push({ id: pairId(a, b), a, b, ...c });
  }
  const outside = (p: CandidatePair) => Number(p.a.source_id !== DEFAULT_SOURCE_ID) + Number(p.b.source_id !== DEFAULT_SOURCE_ID);
  const kept = new Map<string, CandidatePair>();
  const pairs: CandidatePair[] = [];
  const copyOf = (x: PersonPage, y: PersonPage) => pageKey(x) === pageKey(y) || isCopy(x, y);
  for (const p of found.sort((x, y) => outside(x) - outside(y) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    const key = [mirrorOf(p.a), mirrorOf(p.b)].sort().join('\n');
    const k = kept.get(key);
    if (k && (copyOf(k.a, p.a) && copyOf(k.b, p.b) || copyOf(k.a, p.b) && copyOf(k.b, p.a))) { skipped.copies++; continue; }
    if (!k) kept.set(key, p);
    pairs.push(p);
  }
  const paired = new Map<string, PersonPage>();
  for (const p of pairs) { paired.set(pageKey(p.a), p.a); paired.set(pageKey(p.b), p.b); }
  for (const p of paired.values()) await foldTags(engine, p);
  return { people, carriers, nameCounts, pairs, skipped, countryCode };
}

/** Folds in tags added with `gbrain tag` or add_tag, which live only in the tags table, never in frontmatter. */
async function foldTags(engine: BrainEngine, p: PersonPage): Promise<void> {
  const tags = { tags: await engine.getTags(p.slug, { sourceId: p.source_id }) };
  if (p.sensitive !== 'minor') p.sensitive = sensitivityOf(tags) ?? p.sensitive;
  if (p.hold !== 'minor') p.hold = sensitivityOf(tags, new Date(), 'link') ?? p.hold;
}
