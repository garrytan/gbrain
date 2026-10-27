/**
 * #2942: flag a never-seen entity name that sits next to an existing one (flag only, never merge).
 *
 * A transcription slip ("ACMX" for "ACME") mints a new entity page beside the real one. This module finds
 * those pairs so a person can decide: link them (entity_identity_link, still manual-only), add an alias, or
 * mark them distinct. It never writes, never merges and never touches entity_identities.
 *
 * Kinds:
 *   - same: the names normalize equal, or the entity card treats them as one name (honorific, reordered,
 *     diminutive, initial). Offered as an alias, never reported as a different entity.
 *   - typo: Damerau distance exactly 1 between normalized names of 3 to 64 characters.
 *   - acronym: a one-word name equals the initials of a multi-word name, with at most one letter different.
 *
 * Candidates come from symmetric one-deletion keys (a distance-1 pair always shares a key) plus initials
 * keys, so recall is complete within those kinds. Work is bounded: when the key count passes the budget the
 * index is split into shards by key hash (a pair shares a key, so it lands whole in one shard) and callers
 * walk the shards with a cursor.
 */

import type { BrainEngine } from '../engine.ts';
import { nameWords, matchNameVariant, editDistance, type NameMatchKind } from './name-variants.ts';
import { isFactEntityPage } from './resolve.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';

export type NearNameKind = 'same' | 'typo' | 'acronym';

const CORPORATE_SUFFIXES: ReadonlySet<string> = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'labs', 'lab', 'gmbh',
  'plc', 'ag', 'sa', 'bv', 'the',
]);
const SAME_VARIANTS: ReadonlySet<NameMatchKind> = new Set(['normalized', 'honorific', 'reordered', 'diminutive', 'initial']);
export const NEAR_NAME_MIN_CHARS = 3;
export const NEAR_NAME_MAX_CHARS = 64;

/** Name words without corporate suffixes; a name that is only suffixes keeps them. */
export function entityNameWords(name: string): string[] {
  const words = nameWords(name);
  const core = words.filter(w => !CORPORATE_SUFFIXES.has(w));
  return core.length ? core : words;
}

export function normalizeEntityName(name: string): string {
  return entityNameWords(name).join('');
}

function initialsOf(words: string[]): string | null {
  return words.length >= 2 ? words.map(w => w[0]).join('') : null;
}

/** How two entity names relate, or null when they are unrelated. */
export function classifyNearName(a: string, b: string): NearNameKind | null {
  const wa = entityNameWords(a), wb = entityNameWords(b);
  const na = wa.join(''), nb = wb.join('');
  if (!na || !nb) return null;
  if (na === nb) return 'same';
  const variant = matchNameVariant(a, b) ?? matchNameVariant(b, a);
  if (variant && SAME_VARIANTS.has(variant)) return 'same';
  const checkable = (n: string) => n.length >= NEAR_NAME_MIN_CHARS && n.length <= NEAR_NAME_MAX_CHARS;
  if (checkable(na) && checkable(nb) && editDistance(na, nb, 1) === 1) return 'typo';
  const acronym = (single: string[], multi: string[]) => {
    const initials = initialsOf(multi);
    return single.length === 1 && initials !== null && single[0]!.length >= NEAR_NAME_MIN_CHARS
      && initials.length === single[0]!.length && editDistance(single[0]!, initials, 1) <= 1;
  };
  if (acronym(wa, wb) || acronym(wb, wa)) return 'acronym';
  return null;
}

function deletionKeys(s: string): string[] {
  const keys = new Set<string>([s]);
  for (let i = 0; i < s.length; i++) keys.add(s.slice(0, i) + s.slice(i + 1));
  return [...keys];
}

/** Every index key a name contributes: one-deletion keys of the normalized name, and of the initials or acronym. */
export function nameKeys(name: string): string[] {
  const words = entityNameWords(name);
  const normalized = words.join('');
  if (normalized.length < NEAR_NAME_MIN_CHARS || normalized.length > NEAR_NAME_MAX_CHARS) return [];
  const keys = deletionKeys(normalized).map(k => `n:${k}`);
  const acronym = words.length === 1 ? words[0]! : initialsOf(words);
  if (acronym && acronym.length >= NEAR_NAME_MIN_CHARS && acronym.length <= 12) keys.push(...deletionKeys(acronym).map(k => `a:${k}`));
  return keys;
}

function keyShard(key: string, shards: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % shards;
}

export interface EntityName { slug: string; name: string; created_at?: string }

export interface NearNameIndex {
  shard: number;
  shards: number;
  entries: EntityName[];
  keys: Map<string, number[]>;
}

/** Build one shard of the index. A pair of names sharing a key is in exactly the shard that key hashes to. */
export function buildNearNameIndex(names: EntityName[], shard = 0, shards = 1): NearNameIndex {
  const keys = new Map<string, number[]>();
  names.forEach((entry, i) => {
    for (const key of nameKeys(entry.name)) {
      if (shards > 1 && keyShard(key, shards) !== shard) continue;
      const list = keys.get(key);
      if (list) { if (list[list.length - 1] !== i) list.push(i); } else keys.set(key, [i]);
    }
  });
  return { shard, shards, entries: names, keys };
}

/** Count the keys a name set would produce, to pick a shard count before building. */
export function countNameKeys(names: EntityName[]): number {
  let n = 0;
  for (const entry of names) n += nameKeys(entry.name).length;
  return n;
}

export interface NearNameMatch { slug: string; name: string; kind: Exclude<NearNameKind, 'same'> | 'same' }

/** Names in this shard that are near `name` (any kind, `same` included), excluding `excludeSlug`. */
export function queryNearNames(index: NearNameIndex, name: string, excludeSlug?: string): NearNameMatch[] {
  const seen = new Set<number>();
  const out: NearNameMatch[] = [];
  for (const key of nameKeys(name)) {
    if (index.shards > 1 && keyShard(key, index.shards) !== index.shard) continue;
    for (const i of index.keys.get(key) ?? []) {
      if (seen.has(i)) continue;
      seen.add(i);
      const entry = index.entries[i]!;
      if (entry.slug === excludeSlug) continue;
      const kind = classifyNearName(name, entry.name);
      if (kind) out.push({ slug: entry.slug, name: entry.name, kind });
    }
  }
  return out;
}

/** Index keys allowed in one shard; past this the index splits into more shards. */
export const NEAR_NAME_MAX_KEYS_PER_SHARD = 500_000;
/** Entity names loaded per source; past this possible_duplicates reports incomplete instead of reading more. */
export const NEAR_NAME_MAX_ENTITIES = 200_000;

export interface EntityNameLoad { names: EntityName[]; truncated: boolean; aliasesBySlug: Map<string, Set<string>>; distinctBySlug: Map<string, Set<string>> }

/**
 * The live entity names (title, aliases, slug basename) of one source a caller may read: fact-entity pages
 * plus the source pack's linkable entity types. Private pages are left out for callers that exclude them,
 * so a hidden page never shapes what a restricted caller is shown.
 */
export async function loadEntityNames(engine: BrainEngine, sourceId: string, opts: { excludePrivate?: boolean; max?: number } = {}): Promise<EntityNameLoad> {
  const max = opts.max ?? NEAR_NAME_MAX_ENTITIES;
  const privacy = opts.excludePrivate ? `AND ${privatePagesFilterFragment('p')}` : '';
  const rows = await engine.executeRaw<{ slug: string; type: string | null; title: string | null; aliases: unknown; distinct_from: unknown; created_at: string }>(
    `SELECT p.slug, p.type, p.title, p.frontmatter -> 'aliases' AS aliases, p.frontmatter -> 'distinct_from' AS distinct_from,
            p.created_at::text AS created_at
       FROM pages p WHERE p.source_id = $1 AND p.deleted_at IS NULL ${privacy}
      ORDER BY p.id LIMIT $2`,
    [sourceId, max + 1],
  );
  let linkable: Set<string> | null = null;
  const names: EntityName[] = [];
  const aliasesBySlug = new Map<string, Set<string>>();
  const distinctBySlug = new Map<string, Set<string>>();
  const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];
  for (const row of rows.slice(0, max)) {
    if (!isFactEntityPage(row.slug, row.type)) {
      linkable ??= new Set((await (await import('../mentions/policy.ts')).loadLinkableTypes(engine, sourceId).catch(() => ({ types: [] as string[] }))).types);
      if (row.type == null || !linkable.has(row.type)) continue;
    }
    const aliases = list(row.aliases);
    const own = new Set<string>([row.title ?? '', row.slug.split('/').pop()!.replace(/-/g, ' '), ...aliases].filter(Boolean));
    for (const name of own) names.push({ slug: row.slug, name, created_at: row.created_at });
    aliasesBySlug.set(row.slug, new Set([...own].map(normalizeEntityName)));
    const distinct = list(row.distinct_from);
    if (distinct.length) distinctBySlug.set(row.slug, new Set(distinct));
  }
  return { names, truncated: rows.length > max, aliasesBySlug, distinctBySlug };
}

/** Shards needed so no shard passes the key budget. */
export function shardCountFor(names: EntityName[], maxKeysPerShard = NEAR_NAME_MAX_KEYS_PER_SHARD): number {
  return Math.max(1, Math.ceil(countNameKeys(names) / maxKeysPerShard));
}
