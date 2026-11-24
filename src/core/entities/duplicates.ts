/**
 * Duplicate finder (plan autoplan-20261117192252, PR 1): read-only groups of person and company pages that are
 * likely one entity, each with its evidence and a class. Nothing here writes. The contract gbrain-evals scores is
 * research/entity-resolution/finder-contract.md; test/entity-duplicates-finder.test.ts is its executable form.
 *
 * Pages: live, unretired person and company pages (canonical type through each source's schema pack) in sources
 * that are not archived, read through BrainEngine.listEntityKeyRows. Keys: email, phone, X handle, LinkedIn,
 * GitHub, a company's domain, and every frontmatter field the pack declares in a page type's `identity_keys`.
 * A placeholder (empty, zero, a placeholder word, too long) is never a key, and a value more than CROWDED_LIMIT
 * pages carry is only counted. Names fold with nameWords, a run of single letters in a company name read as one word
 * (strict: every word kept) and, for "likely" and conflicts, with leading titles and company suffixes dropped (variant).
 *
 * Matchers propose member sets; a cross-source set holding two or more pages of one source also yields those pages as
 * an in_source group, so they can be collapsed. The finder merges proposals with the same kind and members, adds the key
 * evidence (every shared key type, with how many other pages carry a shared contact or handle value, and every
 * key type two members carry with different values), decides each class in one place (classOf, with the clean
 * rule in isCleanGroup; a cross-source group with no shared exclusive key and a vetoing key is a conflict), joins clean groups that share a page and
 * checks the union, then sorts and ids the groups. Only the built-in matchers can make a group clean.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { EntityKeyRow, EntityKeyRowsOpts } from '../engine-sql/entity-keys.ts';
import { NAME_TITLE_TOKENS, nameWords } from './name-variants.ts';
import { CORPORATE_SUFFIXES } from './near-name.ts';
import { GITHUB_RESERVED_NAMES } from './github-reserved.ts';
import { HANDLE_FRONTMATTER_KEYS, frontmatterHandle } from '../by-mention.ts';
import { personTypesFromPack } from '../schema-pack/entity-types.ts';
import { buildAliasGraph, expandClosure } from '../schema-pack/closure.ts';
import type { SchemaPackManifest } from '../schema-pack/manifest-v1.ts';

export const DEDUPE_PREVIEW_SCHEMA_VERSION = 1 as const;
/** A key value carried by more pages than this is crowded: counted, never a key. */
export const CROWDED_LIMIT = 5;
const PAGE_SIZE = 5000;
const MAX_VALUE_CHARS = 320;
const MIN_PHONE_DIGITS = 7;

export type EntityKind = 'person' | 'company';
export type DuplicateKind = 'cross_source' | 'in_source' | 'conflict' | 'thin';
export type DuplicateClass = 'clean' | 'likely' | 'weak' | 'thin' | 'conflict';
export type KeyType = 'email' | 'phone' | 'x_handle' | 'linkedin' | 'github' | 'domain' | 'declared_id';
export type KeyClass = 'exclusive' | 'contact' | 'handle';

export const DUPLICATE_KINDS: readonly DuplicateKind[] = ['cross_source', 'in_source', 'conflict', 'thin'];
export const DUPLICATE_CLASSES: readonly DuplicateClass[] = ['clean', 'likely', 'weak', 'thin', 'conflict'];

export interface DuplicateEvidence {
  matcher: string;
  rule: string;
  key?: KeyType;
  field?: string;
  key_class?: KeyClass;
  role_address?: boolean;
  /** On a shared contact or handle key: pages outside the group carrying a shared value, with a strict name a member has. */
  other_pages_same_name?: number;
  /** On a shared contact or handle key: pages outside the group carrying a shared value, with any other strict name. */
  other_pages_other_name?: number;
  veto?: boolean;
}
export interface DuplicateMember { source_id: string; slug: string }
export interface DuplicateGroup { id: string; kind: DuplicateKind; class: DuplicateClass; members: DuplicateMember[]; evidence: DuplicateEvidence[] }
export interface DuplicateCounts { by_kind: Record<DuplicateKind, number>; by_class: Record<DuplicateClass, number>; crowded_key_values: number }
export interface DuplicateResult { schema_version: typeof DEDUPE_PREVIEW_SCHEMA_VERSION; groups: DuplicateGroup[]; counts: DuplicateCounts }

export interface PageKey { key: KeyType; field: string; key_class: KeyClass; values: Set<string> }
export interface EntityPage extends DuplicateMember {
  title: string;
  type: EntityKind;
  /** nameWords joined: every word, suffixes and titles included. */
  strict: string;
  /** strict without leading titles (and, for a company, trailing corporate suffixes). */
  variant: string;
  /** Usable key values by `<key>:<field>`; placeholders and crowded values are already gone. */
  keys: Map<string, PageKey>;
  distinctFrom: Set<string>;
  page_id: number;
  generation: number;
  created_at: string;
  identity: { entity_id: string; established_by: string } | null;
  /** Domains from a site value with no URL path: the company's own site, not a page it has on someone else's. */
  ownDomains: Set<string>;
  countries: Set<string>;
  /** pageFingerprint: its variant name and strong keys, read before crowded values are dropped. */
  fingerprint: string | null;
}
export interface KeyValueCarriers { key: KeyType; field: string; value: string; pages: EntityPage[] }
export interface DuplicateScan {
  pages(filter?: { type?: EntityKind; sourceId?: string }): Promise<EntityPage[]>;
  /** Every usable key value with the pages that carry it. */
  keyValues(): Promise<KeyValueCarriers[]>;
}
export interface DuplicateProposal {
  kind?: DuplicateKind;
  class?: DuplicateClass;
  members: DuplicateMember[];
  evidence: Array<{ rule: string; matcher?: string; key?: KeyType; field?: string }>;
}
export interface DuplicateMatcher { name: string; propose(scan: DuplicateScan): Promise<DuplicateProposal[]> }
export interface FindDuplicatesOptions {
  kind?: DuplicateKind;
  /** Keep groups with at least one member in this source (every source is still read). */
  sourceId?: string;
  /** Declared id fields per entity kind; replaces the schema packs' `identity_keys` when set. */
  identityKeys?: Partial<Record<EntityKind, string[]>>;
  matchers?: DuplicateMatcher[];
  /**
   * The owner's recorded decisions (gbrain dedupe confirm and reject): every pair inside an `apart` set is kept out of every
   * group, like `distinct_from`; a group whose members all sit in one `confirmed` set is decided and left out.
   */
  decided?: { apart: DuplicateMember[][]; confirmed: DuplicateMember[][]; apartEvidence?: string[][] };
  /**
   * Read only these pages and every page that shares an exclusive key value (LinkedIn, GitHub, a declared id) with them,
   * two hops out: every group a `clean` class can come from (the company sweep after a sync). Other groups of these pages
   * may be missing pages, so only their clean groups are complete.
   */
  near?: DuplicateMember[];
  /** How many hops out `near` reads; 2 unless set. */
  nearHops?: number;
}

const PLACEHOLDER_WORDS = new Set(['unknown', 'none', 'null', 'n/a', 'na', 'tbd', 'todo', '-', '?']);
export const ROLE_MAILBOXES: ReadonlySet<string> = new Set(['team', 'support', 'info', 'hello', 'contact', 'office', 'admin', 'sales', 'help', 'hr',
  'billing', 'accounts', 'family', 'home', 'household', 'reception', 'frontdesk', 'enquiries', 'inquiries', 'press', 'jobs', 'careers', 'ops',
  'noreply', 'mail']);
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de', 'mail.com',
  'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com', 'zoho.com', 'fastmail.com', 'hey.com']);

interface KeySpec { key: KeyType; field: string; key_class: KeyClass; fields: readonly string[]; kinds: readonly EntityKind[]; norm: (raw: string, kind: EntityKind) => string | null }
const BOTH: readonly EntityKind[] = ['person', 'company'];

const KEY_SPECS: readonly KeySpec[] = [
  { key: 'email', field: 'email', key_class: 'contact', fields: ['email', 'emails'], kinds: BOTH,
    norm: raw => /^[^@\s]+@[^@\s]+$/.test(raw.toLowerCase()) ? raw.toLowerCase() : null },
  { key: 'phone', field: 'phone', key_class: 'contact', fields: ['phone', 'phones'], kinds: BOTH, norm: raw => {
    const digits = raw.replace(/\D/g, '');
    return digits.length < MIN_PHONE_DIGITS || /^0+$/.test(digits) ? null : digits;
  } },
  { key: 'x_handle', field: 'x_handle', key_class: 'handle', fields: HANDLE_FRONTMATTER_KEYS, kinds: BOTH, norm: raw => frontmatterHandle(raw) },
  { key: 'linkedin', field: 'linkedin', key_class: 'exclusive', fields: ['linkedin', 'linkedin_url'], kinds: BOTH, norm: (raw, kind) => {
    const v = raw.toLowerCase();
    const m = /(?:^|\/)(in|company|pub)\/([^/?#\s][^?#\s]*)/.exec(v);
    if (m) return `${m[1]}/${m[1] === 'pub' ? m[2]!.replace(/\/+$/, '') : m[2]!.split('/')[0]}`;
    return /^[a-z0-9][a-z0-9_%-]*$/.test(v) ? `${kind === 'company' ? 'company' : 'in'}/${v}` : null;
  } },
  { key: 'github', field: 'github', key_class: 'exclusive', fields: ['github'], kinds: BOTH, norm: raw => {
    const v = raw.toLowerCase().replace(/^@/, '');
    const login = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)/.exec(v)?.[1] ?? v;
    return /^[a-z0-9][a-z0-9-]{0,38}$/.test(login) && !GITHUB_RESERVED_NAMES.has(login) ? login : null;
  } },
  { key: 'domain', field: 'domain', key_class: 'contact', fields: ['domain', 'website'], kinds: ['company'], norm: raw => {
    const host = raw.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#:]/)[0]!.replace(/^www\./, '');
    return host.includes('.') && /^[a-z0-9.-]+$/.test(host) && !FREE_MAIL_DOMAINS.has(host) ? host : null;
  } },
];

const isPlaceholder = (v: string) => !v || /^0+$/.test(v) || PLACEHOLDER_WORDS.has(v.toLowerCase()) || v.length > MAX_VALUE_CHARS;

function rawValues(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter(v => typeof v === 'string' || typeof v === 'number').map(v => String(v).trim()).filter(v => !isPlaceholder(v));
}

/**
 * nameWords; for a company, a run of single letters reads as one word, so "L.L.C.", "L L C" and "LLC" fold alike. A
 * person's initials stay apart, so "D. R. Example" never folds into the title "Dr".
 */
function foldWords(text: string, kind: EntityKind): string[] {
  if (kind !== 'company') return nameWords(text);
  const out: string[] = [];
  let run = '';
  for (const w of [...nameWords(text), '']) {
    if (w.length === 1 && /\p{L}/u.test(w)) { run += w; continue; }
    if (run) out.push(run);
    run = '';
    if (w) out.push(w);
  }
  return out;
}

export function strictNameFold(text: string, kind: EntityKind = 'person'): string {
  return foldWords(text, kind).join(' ');
}

export function variantNameFold(text: string, kind: EntityKind = 'person'): string {
  const words = foldWords(text, kind);
  let start = 0;
  while (start < words.length - 1 && NAME_TITLE_TOKENS.has(words[start]!)) start++;
  let end = words.length;
  if (kind === 'company') while (end - 1 > start && CORPORATE_SUFFIXES.has(words[end - 1]!)) end--;
  return words.slice(start, end).join(' ');
}

const STRONG_KEYS: ReadonlySet<KeyType> = new Set(['linkedin', 'github', 'domain', 'declared_id']);

/**
 * A page's fingerprint: 32 hex of sha256 over its kind, its variant name (leading titles and company suffixes dropped,
 * so "Acme" and "Acme Ltd" agree) and its strong key values (LinkedIn, GitHub, domain, declared ids), never the values
 * themselves. A "different" decision keeps its members' fingerprints, so the pair stays apart after a new slug, a move
 * to another source or a suffix added to the name; a page edited to new keys or another name is new evidence. A page
 * with no strong key has none, since its name alone would keep every namesake apart; its pair stays apart by slug.
 */
export function pageFingerprint(type: EntityKind, name: string, keys: ReadonlyMap<string, PageKey>): string | null {
  const values = [...keys].filter(([, k]) => STRONG_KEYS.has(k.key)).flatMap(([id, k]) => [...k.values].map(v => `${id}=${v}`)).sort();
  if (!values.length) return null;
  return createHash('sha256').update([type, name, ...values].join('\n')).digest('hex').slice(0, 32);
}

/** The forms listEntityKeyRows's token read matches a stored value against, for one normalized key value. */
function keyTokens(k: PageKey): string[] {
  if (k.key === 'linkedin') return [...k.values].map(v => v.split('/')[1]!).filter(Boolean);
  return [...k.values];
}

const pageKey = (m: DuplicateMember) => `${m.source_id}\t${m.slug}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isRoleAddress = (email: string) => ROLE_MAILBOXES.has(email.slice(0, email.indexOf('@')));

interface SourceTypes { person: Set<string>; company: Set<string>; declared: Record<EntityKind, Set<string>> }

async function sourceTypes(engine: BrainEngine, sourceId: string, override: FindDuplicatesOptions['identityKeys']): Promise<SourceTypes> {
  const { loadActivePackForLocalEngine } = await import('../schema-pack/best-effort.ts');
  const pack = await loadActivePackForLocalEngine(engine, { sourceId });
  const manifest: SchemaPackManifest | null = pack?.manifest ?? null;
  const person = new Set(manifest ? personTypesFromPack(manifest) : ['person']);
  const company = new Set(manifest ? expandClosure('company', buildAliasGraph(manifest)) : ['company', 'organization']);
  const declared: Record<EntityKind, Set<string>> = { person: new Set(override?.person ?? []), company: new Set(override?.company ?? []) };
  if (!override && manifest) {
    for (const t of manifest.page_types) {
      const kind: EntityKind | null = person.has(t.name) ? 'person' : company.has(t.name) ? 'company' : null;
      if (kind) for (const f of t.identity_keys ?? []) declared[kind].add(f);
    }
  }
  return { person, company, declared };
}

/** Every page type a source's schema pack reads as a person, across the sources that are not archived. */
export async function personPageTypes(engine: BrainEngine): Promise<string[]> {
  const out = new Set<string>();
  for (const s of await engine.listAllSources()) for (const t of (await sourceTypes(engine, s.id, undefined)).person) out.add(t);
  return [...out].sort();
}

async function loadScan(engine: BrainEngine, opts: FindDuplicatesOptions): Promise<{ scan: DuplicateScan; byKey: Map<string, EntityPage>; crowded: number; carriers: Map<string, EntityPage[]> }> {
  const sources = await engine.listAllSources();
  const typesBySource = new Map<string, SourceTypes>();
  for (const s of sources) typesBySource.set(s.id, await sourceTypes(engine, s.id, opts.identityKeys));
  const types = [...new Set([...typesBySource.values()].flatMap(t => [...t.person, ...t.company]))].sort();
  const declaredFields = [...new Set([...typesBySource.values()].flatMap(t => [...t.declared.person, ...t.declared.company]))];
  const keyFields = [...new Set([...KEY_SPECS.flatMap(s => s.fields), ...declaredFields, 'distinct_from', 'country'])].sort();
  const tokenFields = [...new Set([...KEY_SPECS.filter(s => s.key_class === 'exclusive').flatMap(s => s.fields), ...declaredFields])].sort();

  const read = async (filter: Pick<EntityKeyRowsOpts, 'members' | 'tokens'>) => {
    const out: EntityKeyRow[] = [];
    for (let after: { source_id: string; slug: string } | undefined; ;) {
      const page = await engine.listEntityKeyRows({ types, keys: keyFields, after, limit: PAGE_SIZE, ...filter });
      out.push(...page);
      if (page.length < PAGE_SIZE) break;
      after = { source_id: page[page.length - 1]!.source_id, slug: page[page.length - 1]!.slug };
    }
    return out;
  };
  let rows: EntityKeyRow[];
  if (!opts.near) rows = await read({});
  else {
    const byRow = new Map<string, EntityKeyRow>();
    let frontier = opts.near.length ? await read({ members: opts.near }) : [];
    for (const r of frontier) byRow.set(pageKey(r), r);
    const searched = new Set<string>();
    for (let hop = 0; hop < (opts.nearHops ?? 2) && frontier.length; hop++) {
      const values = [...new Set(frontier.flatMap(r => [...toPage(r)?.keys.values() ?? []].filter(k => k.key_class === 'exclusive').flatMap(keyTokens)))].filter(v => !searched.has(v));
      for (const v of values) searched.add(v);
      frontier = values.length ? (await read({ tokens: { values, fields: tokenFields } })).filter(r => !byRow.has(pageKey(r))) : [];
      for (const r of frontier) byRow.set(pageKey(r), r);
    }
    rows = [...byRow.values()].sort((a, b) => cmp(a.source_id, b.source_id) || cmp(a.slug, b.slug));
  }

  const pages: EntityPage[] = [];
  for (const row of rows) {
    const p = toPage(row);
    if (p) pages.push(p);
  }

  function toPage(row: EntityKeyRow): EntityPage | null {
    const st = typesBySource.get(row.source_id);
    const type: EntityKind | null = st?.person.has(row.type) ? 'person' : st?.company.has(row.type) ? 'company' : null;
    if (!st || !type) return null;
    const title = row.title ?? '';
    const keys = new Map<string, PageKey>();
    const add = (key: KeyType, field: string, key_class: KeyClass, value: string | null) => {
      if (!value) return;
      const id = `${key}:${field}`;
      const k = keys.get(id) ?? { key, field, key_class, values: new Set<string>() };
      k.values.add(value);
      keys.set(id, k);
    };
    for (const spec of KEY_SPECS) {
      if (!spec.kinds.includes(type)) continue;
      for (const f of spec.fields) for (const raw of rawValues(row.keys[f])) add(spec.key, spec.field, spec.key_class, spec.norm(raw, type));
    }
    for (const f of st.declared[type]) for (const raw of rawValues(row.keys[f])) add('declared_id', f, 'exclusive', raw.toLowerCase());
    const distinct = row.keys.distinct_from;
    const domainSpec = KEY_SPECS.find(s => s.key === 'domain')!;
    const ownDomains = new Set(type !== 'company' ? [] : domainSpec.fields.flatMap(f => rawValues(row.keys[f]))
      .filter(raw => /^[^/?#]*\/?(?:[?#].*)?$/.test(raw.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '')))
      .map(raw => domainSpec.norm(raw, type)).filter((d): d is string => !!d));
    const strict = strictNameFold(title, type);
    return { source_id: row.source_id, slug: row.slug, title, type, strict, variant: variantNameFold(title, type), keys,
      distinctFrom: new Set((Array.isArray(distinct) ? distinct : [distinct]).filter((d): d is string => typeof d === 'string').map(d => d.trim())),
      page_id: row.page_id, generation: row.generation, created_at: row.created_at, identity: row.identity, ownDomains,
      countries: new Set(rawValues(row.keys.country).map(c => c.toLowerCase())), fingerprint: pageFingerprint(type, variantNameFold(title, type), keys) };
  }

  const carriers = new Map<string, EntityPage[]>();
  for (const p of pages) for (const [id, k] of p.keys) for (const v of k.values) {
    const list = carriers.get(`${id}\n${v}`) ?? [];
    list.push(p);
    carriers.set(`${id}\n${v}`, list);
  }
  let crowded = 0;
  for (const [cv, list] of carriers) {
    if (list.length <= CROWDED_LIMIT) continue;
    crowded++;
    const [id, v] = cv.split('\n') as [string, string];
    for (const p of list) {
      const k = p.keys.get(id);
      k?.values.delete(v);
      if (k && k.values.size === 0) p.keys.delete(id);
    }
    carriers.delete(cv);
  }

  const byKey = new Map(pages.map(p => [pageKey(p), p]));
  const scan: DuplicateScan = {
    async pages(filter = {}) {
      return pages.filter(p => (!filter.type || p.type === filter.type) && (!filter.sourceId || p.source_id === filter.sourceId));
    },
    async keyValues() {
      return [...carriers].map(([cv, list]) => {
        const [id, value] = cv.split('\n') as [string, string];
        const k = list[0]!.keys.get(id)!;
        return { key: k.key, field: k.field, value, pages: list };
      });
    },
  };
  return { scan, byKey, crowded, carriers };
}

const groupBy = <T>(items: readonly T[], keyOf: (t: T) => string | null) => {
  const out = new Map<string, T[]>();
  for (const t of items) {
    const k = keyOf(t);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(t); else out.set(k, [t]);
  }
  return out;
};

/** Pages that share one usable key value: one group when their variant names agree, a conflict when they don't. */
const sharedKeyMatcher: DuplicateMatcher = {
  name: 'shared_key',
  async propose(scan) {
    const out: DuplicateProposal[] = [];
    for (const kv of await scan.keyValues()) {
      for (const sameType of groupBy(kv.pages, p => p.type).values()) {
        if (sameType.length < 2) continue;
        const agree = new Set(sameType.map(p => p.variant)).size === 1;
        out.push(agree ? { members: sameType, evidence: [] } : { kind: 'conflict', class: 'conflict', members: sameType, evidence: [] });
      }
    }
    return out;
  },
};

/** Pages of one type with the same strict name; and pages whose names differ only by leading titles or company suffixes. */
const sameNameMatcher: DuplicateMatcher = {
  name: 'same_name',
  async propose(scan) {
    const pages = (await scan.pages()).filter(p => p.strict);
    const out: DuplicateProposal[] = [];
    for (const g of groupBy(pages, p => `${p.type}\n${p.strict}`).values()) if (g.length > 1) out.push({ members: g, evidence: [{ rule: 'strict_name' }] });
    for (const g of groupBy(pages, p => p.variant ? `${p.type}\n${p.variant}` : null).values()) {
      if (new Set(g.map(p => p.strict)).size > 1) out.push({ members: g, evidence: [{ rule: 'variant_name' }] });
    }
    return out;
  },
};

const AGENT_WIKI = /^wiki\/agents\/[^/]+\/((?:people|companies)\/[^/]+)$/;
const ENTITY_DIR: Record<EntityKind, string> = { person: 'people', company: 'companies' };

/** Inside one source: legacy accent spellings of one name, and root-level or agent-wiki copies of `people/<x>` or `companies/<x>`. */
const slugShapeMatcher: DuplicateMatcher = {
  name: 'slug_shape',
  async propose(scan) {
    const pages = await scan.pages();
    const out: DuplicateProposal[] = [];
    const bySlug = new Map(pages.map(p => [pageKey(p), p]));
    const copies = new Map<string, { base: EntityPage; members: EntityPage[]; rules: Set<string> }>();
    for (const p of pages) {
      const wiki = AGENT_WIKI.exec(p.slug)?.[1];
      const baseSlug = wiki ?? (p.slug.includes('/') ? null : `${ENTITY_DIR[p.type]}/${p.slug}`);
      const base = baseSlug ? bySlug.get(pageKey({ source_id: p.source_id, slug: baseSlug })) : undefined;
      if (!base || base.type !== p.type || base.strict !== p.strict || !p.strict) continue;
      const entry = copies.get(pageKey(base)) ?? { base, members: [base], rules: new Set<string>() };
      entry.members.push(p);
      entry.rules.add(wiki ? 'agent_wiki_copy' : 'root_copy');
      copies.set(pageKey(base), entry);
    }
    for (const c of copies.values()) out.push({ members: c.members, evidence: [...c.rules].map(rule => ({ rule })) });
    const accented = pages.filter(p => p.strict && /[^\u0000-\u007f]/.test(p.title));
    for (const g of groupBy(accented, p => `${p.source_id}\n${p.type}\n${p.slug.slice(0, p.slug.lastIndexOf('/') + 1)}\n${p.strict}`).values()) {
      if (g.length > 1) out.push({ members: g, evidence: [{ rule: 'legacy_accent_slug' }] });
    }
    return out;
  },
};

/** A person page titled with one word, beside exactly one other person page in its source whose name starts with that word. */
const thinPageMatcher: DuplicateMatcher = {
  name: 'thin_page',
  async propose(scan) {
    const out: DuplicateProposal[] = [];
    const people = await scan.pages({ type: 'person' });
    const firstWords = groupBy(people.filter(p => p.strict.includes(' ')), p => `${p.source_id}\n${p.strict.split(' ')[0]}`);
    for (const p of people) {
      if (!p.strict || p.strict.includes(' ')) continue;
      const candidates = firstWords.get(`${p.source_id}\n${p.strict}`) ?? [];
      if (candidates.length === 1) out.push({ kind: 'thin', class: 'thin', members: [p, candidates[0]!], evidence: [{ rule: 'first_name_only' }] });
    }
    return out;
  },
};

export const DEFAULT_MATCHERS: readonly DuplicateMatcher[] = [sharedKeyMatcher, sameNameMatcher, slugShapeMatcher, thinPageMatcher];

/** What the clean rule reads. Every input is explicit so a different rule is a change to isCleanGroup alone. */
export interface CleanRuleInput {
  members: Array<{ source_id: string; type: EntityKind; strict: string }>;
  /** One entry per key type every member shares a value of. */
  shared_keys: Array<{ key: KeyType; key_class: KeyClass; role_address?: boolean; shared_values: number; values_only_in_group: number }>;
  /** One entry per key type two members carry with values that don't overlap. */
  differing_keys: Array<{ key: KeyType; key_class: KeyClass; veto: boolean }>;
  /** Set when the group is the union of clean groups that share a page. */
  union?: { parts: number };
}

/**
 * The rule for `clean`, rule A as the owner chose it on the bench numbers (plan Decision F, narrowed): one type,
 * one strict name, one member per source, no vetoing key, no two different domains, and a shared **exclusive** key
 * (LinkedIn, GitHub, a declared id) whose value no page outside the group carries, or, for a union, clean parts.
 * Contact and handle keys (email, phone, X handle, domain) never make a group clean on their own. Two companies with
 * one name on a group's shared LinkedIn page (a US firm and its UK namesake) differ by domain, so they stay likely.
 */
export function isCleanGroup(input: CleanRuleInput): boolean {
  const { members } = input;
  if (new Set(members.map(m => m.type)).size !== 1 || new Set(members.map(m => m.strict)).size !== 1 || !members[0]?.strict) return false;
  if (new Set(members.map(m => m.source_id)).size !== members.length) return false;
  if (input.differing_keys.some(k => k.veto || k.key === 'domain')) return false;
  if (input.union) return true;
  return input.shared_keys.some(k => k.key_class === 'exclusive' && k.values_only_in_group > 0);
}

interface Draft { kind: DuplicateKind; members: EntityPage[]; evidence: Map<string, DuplicateEvidence>; proposed: DuplicateClass[]; builtin: boolean; union?: { parts: number; failed: boolean } }

const RANK: Record<DuplicateClass, number> = { conflict: 0, thin: 0, weak: 1, likely: 2, clean: 3 };
const evidenceKey = (e: DuplicateEvidence) => [e.matcher, e.rule, e.key ?? '', e.field ?? ''].join('\t');

function keyEvidence(members: EntityPage[], carriers: Map<string, EntityPage[]>): { evidence: DuplicateEvidence[]; input: Pick<CleanRuleInput, 'shared_keys' | 'differing_keys'> } {
  const evidence: DuplicateEvidence[] = [];
  const shared_keys: CleanRuleInput['shared_keys'] = [];
  const differing_keys: CleanRuleInput['differing_keys'] = [];
  const ids = [...new Set(members.flatMap(m => [...m.keys.keys()]))].sort();
  const inGroup = new Set(members.map(pageKey));
  const names = new Set(members.map(m => m.strict));
  for (const id of ids) {
    const sets = members.map(m => m.keys.get(id));
    const spec = sets.find(Boolean)!;
    const base = { key: spec.key, field: spec.field, key_class: spec.key_class };
    if (sets.every(Boolean)) {
      const common = [...sets[0]!.values].filter(v => sets.every(s => s!.values.has(v)));
      if (common.length) {
        const role = spec.key === 'email' ? { role_address: common.some(isRoleAddress) } : {};
        const carrying = common.map(v => carriers.get(`${id}\n${v}`) ?? []);
        const others = [...new Map(carrying.flat().filter(p => !inGroup.has(pageKey(p))).map(p => [pageKey(p), p])).values()];
        const sameName = others.filter(p => names.has(p.strict)).length;
        const counts = spec.key_class === 'exclusive' ? {} : { other_pages_same_name: sameName, other_pages_other_name: others.length - sameName };
        evidence.push({ matcher: 'shared_key', rule: 'shared_key', ...base, ...role, ...counts });
        shared_keys.push({ key: spec.key, key_class: spec.key_class, ...role, shared_values: common.length,
          values_only_in_group: carrying.filter(list => list.length === members.length).length });
      }
    }
    const present = sets.filter((s): s is PageKey => !!s);
    const differs = present.some((a, i) => present.slice(i + 1).some(b => ![...a.values].some(v => b.values.has(v))));
    if (differs) {
      const veto = spec.key_class === 'exclusive';
      evidence.push({ matcher: 'key_check', rule: 'key_differs', ...base, veto });
      differing_keys.push({ key: spec.key, key_class: spec.key_class, veto });
    }
  }
  return { evidence, input: { shared_keys, differing_keys } };
}

function classOf(d: Draft, carriers: Map<string, EntityPage[]>): { cls: DuplicateClass; evidence: DuplicateEvidence[] } {
  const keys = keyEvidence(d.members, carriers);
  const evidence = [...d.evidence.values(), ...keys.evidence];
  if (d.union?.failed) evidence.push({ matcher: 'key_check', rule: 'union_check_failed' });
  const shared = keys.input.shared_keys;
  if (d.kind === 'cross_source' && shared.length && shared.every(k => k.key_class !== 'exclusive')) evidence.push({ matcher: 'key_check', rule: 'contact_key_only' });
  if (d.kind === 'conflict' || d.kind === 'thin') return { cls: d.kind, evidence };
  const plugin = d.proposed.map(c => (c === 'clean' ? 'likely' : c)).filter(c => c === 'likely' || c === 'weak');
  let builtin: DuplicateClass | null = null;
  if (d.builtin) {
    if (d.kind === 'in_source') builtin = 'likely';
    else if (!d.union?.failed && isCleanGroup({ members: d.members, ...keys.input, ...(d.union ? { union: { parts: d.union.parts } } : {}) })) builtin = 'clean';
    else if (d.union || keys.input.shared_keys.length || evidence.some(e => e.rule !== 'strict_name' && e.matcher !== 'key_check')) builtin = 'likely';
    else builtin = 'weak';
  }
  const all = [...plugin, ...(builtin ? [builtin] : [])] as DuplicateClass[];
  const cls = all.reduce<DuplicateClass>((best, c) => (RANK[c] > RANK[best] ? c : best), all[0] ?? 'likely');
  if (d.kind === 'in_source') return { cls: 'likely', evidence };
  const vetoedWithoutId = cls !== 'clean' && !shared.some(k => k.key_class === 'exclusive') && keys.input.differing_keys.some(k => k.veto);
  return { cls: vetoedWithoutId ? 'conflict' : cls, evidence };
}

const hasDistinctPair = (members: EntityPage[]) => members.some(a => a.distinctFrom.size > 0 && members.some(b => a !== b && a.distinctFrom.has(b.slug)));

function decidedChecks(decided: FindDuplicatesOptions['decided']) {
  const apartOf = new Map<string, Set<string>>();
  for (const set of decided?.apart ?? []) for (const a of set) {
    const others = apartOf.get(pageKey(a)) ?? new Set<string>();
    for (const b of set) if (pageKey(b) !== pageKey(a)) others.add(pageKey(b));
    apartOf.set(pageKey(a), others);
  }
  const prints = (decided?.apartEvidence ?? []).filter(e => e.length > 1);
  const matched = (evidence: string[], members: EntityPage[]) => {
    const left = [...evidence];
    let n = 0;
    for (const m of members) { const at = m.fingerprint ? left.indexOf(m.fingerprint) : -1; if (at >= 0) { left.splice(at, 1); n++; } }
    return n;
  };
  const confirmedSets = (decided?.confirmed ?? []).map(set => new Set(set.map(pageKey)));
  const confirmedIn = new Map<string, number[]>();
  confirmedSets.forEach((set, i) => { for (const k of set) confirmedIn.set(k, [...(confirmedIn.get(k) ?? []), i]); });
  return {
    keptApart: (members: EntityPage[]) => {
      if (hasDistinctPair(members)) return true;
      if (prints.some(evidence => matched(evidence, members) > 1)) return true;
      if (!apartOf.size) return false;
      const inGroup = new Set(members.map(pageKey));
      return members.some(a => [...(apartOf.get(pageKey(a)) ?? [])].some(b => inGroup.has(b)));
    },
    confirmed: (members: DuplicateMember[]) => {
      return (confirmedIn.get(pageKey(members[0]!)) ?? []).some(i => members.every(m => confirmedSets[i]!.has(pageKey(m))));
    },
  };
}

function groupId(kind: DuplicateKind, members: DuplicateMember[]): string {
  const lines = members.map(pageKey).sort(cmp).join('\n');
  return `dedupe/${createHash('sha256').update(`${kind}\n${lines}`).digest('hex').slice(0, 16)}`;
}

/** The finder's view of these pages (missing ones are left out), for the fingerprints a "different" decision keeps. */
export async function entityPagesOf(engine: BrainEngine, members: DuplicateMember[]): Promise<Map<string, EntityPage>> {
  return members.length ? (await loadScan(engine, { near: members, nearHops: 0 })).byKey : new Map();
}

export async function findDuplicateGroups(engine: BrainEngine, opts: FindDuplicatesOptions = {}): Promise<DuplicateResult> {
  return (await findTypedDuplicateGroups(engine, opts)).result;
}

/** findDuplicateGroups plus each group's entity kind (person or company), which the finder's JSON contract leaves out. */
export async function findTypedDuplicateGroups(engine: BrainEngine, opts: FindDuplicatesOptions = {}): Promise<{ result: DuplicateResult; kindOf: Map<string, EntityKind>; pages: Map<string, EntityPage> }> {
  const { scan, byKey, crowded, carriers } = await loadScan(engine, opts);
  const kindOf = new Map<string, EntityKind>();
  const matchers = opts.matchers ?? DEFAULT_MATCHERS;
  const { keptApart, confirmed } = decidedChecks(opts.decided);
  const drafts = new Map<string, Draft>();
  const draftKey = (kind: DuplicateKind, members: EntityPage[]) => `${kind}\n${members.map(pageKey).sort(cmp).join('\n')}`;
  const add = (draft: Draft) => {
    const k = draftKey(draft.kind, draft.members);
    const prev = drafts.get(k);
    if (!prev) { drafts.set(k, draft); return; }
    for (const [ek, e] of draft.evidence) prev.evidence.set(ek, e);
    prev.proposed.push(...draft.proposed);
    prev.builtin ||= draft.builtin;
    if (draft.union) prev.union = draft.union;
  };

  for (const matcher of matchers) {
    const builtin = DEFAULT_MATCHERS.includes(matcher);
    for (const p of await matcher.propose(scan)) {
      const members = [...new Map(p.members.map(m => [pageKey(m), byKey.get(pageKey(m))])).values()].filter((m): m is EntityPage => !!m);
      if (members.length < 2) continue;
      if (keptApart(members)) continue;
      const spread = new Set(members.map(m => m.source_id)).size > 1 ? 'cross_source' : 'in_source';
      const kind: DuplicateKind = p.kind === 'conflict' || p.kind === 'thin' ? p.kind : spread;
      const evidence = new Map<string, DuplicateEvidence>();
      for (const e of p.evidence) {
        const item: DuplicateEvidence = { matcher: matcher.name, rule: e.rule, ...(e.key ? { key: e.key } : {}), ...(e.field ? { field: e.field } : {}) };
        evidence.set(evidenceKey(item), item);
      }
      const proposed: DuplicateClass[] = !builtin && p.class ? [p.class] : builtin ? [] : ['likely'];
      add({ kind, members, evidence, proposed, builtin });
      if (kind !== 'cross_source') continue;
      for (const same of groupBy(members, m => m.source_id).values()) {
        if (same.length > 1) add({ kind: 'in_source', members: same, evidence: new Map(evidence), proposed: [...proposed], builtin });
      }
    }
  }

  const clean = [...drafts].filter(([, d]) => d.kind === 'cross_source' && classOf(d, carriers).cls === 'clean');
  const parent = new Map(clean.map(([k]) => [k, k]));
  const find = (k: string): string => { const up = parent.get(k)!; if (up === k) return k; const root = find(up); parent.set(k, root); return root; };
  const firstClean = new Map<string, string>();
  for (const [k, d] of clean) for (const m of d.members) {
    const seen = firstClean.get(pageKey(m));
    if (seen) parent.set(find(k), find(seen)); else firstClean.set(pageKey(m), k);
  }
  for (const parts of groupBy(clean, ([k]) => find(k)).values()) {
    if (parts.length < 2) continue;
    const members = [...new Map(parts.flatMap(([, d]) => d.members).map(m => [pageKey(m), m])).values()];
    if (keptApart(members)) continue;
    for (const [k] of parts) drafts.delete(k);
    const evidence = new Map(parts.flatMap(([, d]) => [...d.evidence]));
    const union: Draft = { kind: 'cross_source', members, evidence, proposed: [], builtin: true, union: { parts: parts.length, failed: false } };
    union.union!.failed = classOf(union, carriers).cls !== 'clean';
    add(union);
  }

  const groups: DuplicateGroup[] = [];
  for (const d of drafts.values()) {
    if (opts.sourceId && !d.members.some(m => m.source_id === opts.sourceId)) continue;
    if (opts.kind && d.kind !== opts.kind) continue;
    if (confirmed(d.members)) continue;
    const { cls, evidence } = classOf(d, carriers);
    const members = d.members.map(m => ({ source_id: m.source_id, slug: m.slug }))
      .sort((a, b) => cmp(a.source_id, b.source_id) || cmp(a.slug, b.slug));
    const sorted = [...new Map(evidence.map(e => [evidenceKey(e), e])).values()]
      .sort((a, b) => cmp(a.matcher, b.matcher) || cmp(a.rule, b.rule) || cmp(a.key ?? '', b.key ?? '') || cmp(a.field ?? '', b.field ?? ''));
    const id = groupId(d.kind, members);
    kindOf.set(id, d.members[0]!.type);
    groups.push({ id, kind: d.kind, class: cls, members, evidence: sorted });
  }
  groups.sort((a, b) => DUPLICATE_KINDS.indexOf(a.kind) - DUPLICATE_KINDS.indexOf(b.kind) || cmp(a.id, b.id));

  const counts: DuplicateCounts = {
    by_kind: Object.fromEntries(DUPLICATE_KINDS.map(k => [k, 0])) as Record<DuplicateKind, number>,
    by_class: Object.fromEntries(DUPLICATE_CLASSES.map(c => [c, 0])) as Record<DuplicateClass, number>,
    crowded_key_values: crowded,
  };
  for (const g of groups) { counts.by_kind[g.kind]++; counts.by_class[g.class]++; }
  return { result: { schema_version: DEDUPE_PREVIEW_SCHEMA_VERSION, groups, counts }, kindOf, pages: byKey };
}
