/**
 * Mention-linking policy: which page types are linkable entities, which names
 * are ignored, and whether the mention pass runs at all.
 *
 * Linkable types per source are the union of the four always-linkable types
 * (person, company, organization, entity), every type the source's schema pack
 * marks `primitive: entity`, and those types' declared type aliases (`product`
 * excluded: a product page is not a name agents brief on), adjusted by
 * `mentions.entity_types` (`+type` or `type` adds, `-type` removes; the four
 * always-linkable types cannot be removed). The gazetteer, the entity card's
 * entity preference and the mention pass's alias refresh all read this one
 * resolver. Type lists reach SQL bound as `text[]`, never interpolated.
 *
 * Off switches: `auto_link=false` (global) or `mentions.auto_link=false`.
 * `mentions.exclude_slugs` keeps named pages out of the gazetteer entirely
 * (#5829: an entity whose name is also a common word). `mentions.alias_deny`
 * and `mentions.multiword_aliases` shape alias derivation (aliases.ts);
 * `mentions.sibling_merge` turns identity siblings off (siblings.ts).
 */

import type { BrainEngine } from '../engine.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';

export const ALWAYS_LINKABLE_TYPES = ['person', 'company', 'organization', 'entity'] as const;
const EXCLUDED_LINKABLE_ALIASES: ReadonlySet<string> = new Set(['product']);

export interface PackTypes {
  page_types: ReadonlyArray<{ name: string; primitive?: string; aliases?: ReadonlyArray<string> }>;
}

export interface MentionPolicy {
  enabled: boolean;
  /** The key that turned the pass off, when it is off. */
  disabledBy: 'auto_link' | 'mentions.auto_link' | null;
  typeAdds: string[];
  typeRemoves: string[];
  /** Names never linked (`mentions.ignore`), matched case-insensitively. */
  ignore: string[];
  /** Page slugs that get no gazetteer entry, by title or alias (`mentions.exclude_slugs`, #5829). */
  excludeSlugs: string[];
  /** Names never derived as an alias for any page (`mentions.alias_deny`). */
  aliasDeny: string[];
  /** Derive multi-word declared aliases (`mentions.multiword_aliases`, default on). */
  multiwordAliases: boolean;
  /** Show same-subject pages as identity siblings on cards and in search (`mentions.sibling_merge`, default on). */
  siblingMerge: boolean;
}

const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

function isOff(value: string | null): boolean {
  return value != null && FALSE_VALUES.has(value.trim().toLowerCase());
}

/** A JSON array or a comma/newline-separated list of strings. */
export function parseNameList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  const text = value.trim();
  if (text.startsWith('[')) {
    try { return parseNameList(JSON.parse(text)); } catch { /* fall through to the plain list */ }
  }
  return text.split(/[,\n]/).map(v => v.trim()).filter(Boolean);
}

export async function readMentionPolicy(engine: Pick<BrainEngine, 'getConfig'>): Promise<MentionPolicy> {
  const [global, own, types, ignore, excludeSlugs, aliasDeny, multiword, siblings] = await Promise.all([
    engine.getConfig('auto_link'), engine.getConfig('mentions.auto_link'),
    engine.getConfig('mentions.entity_types'), engine.getConfig('mentions.ignore'),
    engine.getConfig('mentions.exclude_slugs'), engine.getConfig('mentions.alias_deny'),
    engine.getConfig('mentions.multiword_aliases'), engine.getConfig('mentions.sibling_merge'),
  ]);
  const typeAdds: string[] = [];
  const typeRemoves: string[] = [];
  for (const entry of parseNameList(types)) {
    if (entry.startsWith('-')) typeRemoves.push(entry.slice(1).trim());
    else typeAdds.push(entry.replace(/^\+/, '').trim());
  }
  const disabledBy = isOff(global) ? 'auto_link' : isOff(own) ? 'mentions.auto_link' : null;
  return { enabled: disabledBy === null, disabledBy, typeAdds: typeAdds.filter(Boolean), typeRemoves: typeRemoves.filter(Boolean), ignore: parseNameList(ignore),
    excludeSlugs: parseNameList(excludeSlugs), aliasDeny: parseNameList(aliasDeny), multiwordAliases: !isOff(multiword), siblingMerge: !isOff(siblings) };
}

/** Linkable entity types for one pack (null = no pack resolved), sorted. */
export function linkableTypesFor(pack: PackTypes | null, policy: Pick<MentionPolicy, 'typeAdds' | 'typeRemoves'>): string[] {
  const types = new Set<string>(ALWAYS_LINKABLE_TYPES);
  for (const pt of pack?.page_types ?? []) {
    if (pt.primitive !== 'entity') continue;
    types.add(pt.name);
    for (const alias of pt.aliases ?? []) if (!EXCLUDED_LINKABLE_ALIASES.has(alias)) types.add(alias);
  }
  for (const t of policy.typeAdds) types.add(t);
  for (const t of policy.typeRemoves) if (!(ALWAYS_LINKABLE_TYPES as readonly string[]).includes(t)) types.delete(t);
  return [...types].sort();
}

/** Stored type → the pack's canonical type (type aliases mapped); untyped pages group as `untyped`. */
export function canonicalTypeOf(stored: string | null | undefined, pack: PackTypes | null): string {
  if (!stored) return 'untyped';
  for (const pt of pack?.page_types ?? []) if (pt.name === stored) return stored;
  for (const pt of pack?.page_types ?? []) if (pt.aliases?.includes(stored)) return pt.name;
  return stored;
}

/** `[stored, canonical]` pairs for every alias the pack declares, for SQL grouping (bound as two text[]). */
export function typeAliasPairs(pack: PackTypes | null): { stored: string[]; canonical: string[] } {
  const stored: string[] = [];
  const canonical: string[] = [];
  const declared = new Set((pack?.page_types ?? []).map(pt => pt.name));
  for (const pt of pack?.page_types ?? []) {
    for (const alias of pt.aliases ?? []) {
      if (declared.has(alias) || stored.includes(alias)) continue;
      stored.push(alias);
      canonical.push(pt.name);
    }
  }
  return { stored, canonical };
}

/** The active pack for a source; null when none resolves. `strict` rethrows a resolution failure instead. */
export async function loadSourcePack(engine: Pick<BrainEngine, 'getConfig'>, sourceId: string, opts: { strict?: boolean } = {}): Promise<PackTypes | null> {
  try {
    return (await loadActivePackForEngine(engine, { remote: false, sourceId })).manifest;
  } catch (error) {
    if (opts.strict) throw error;
    return null;
  }
}

export async function loadLinkableTypes(engine: Pick<BrainEngine, 'getConfig'>, sourceId: string,
  opts: { strict?: boolean; policy?: MentionPolicy } = {}): Promise<{ types: string[]; pack: PackTypes | null }> {
  const policy = opts.policy ?? await readMentionPolicy(engine);
  const pack = await loadSourcePack(engine, sourceId, opts);
  return { types: linkableTypesFor(pack, policy), pack };
}
