/**
 * #7191: `gbrain stats --by source,type [--since <date>] [--collapse-aliases]`
 * (the `get_stats` op's `by` / `since` / `collapse_aliases` params): page
 * counts grouped by source and type, the counts agents otherwise take with
 * `grep -c`, `wc` or SQL.
 *
 * The engine returns live page counts per (source, type) plus raw and
 * distinct-slug totals (`BrainEngine.countPagesBy`); this module groups them.
 * A slug present in two sources (a cross-source twin) is one distinct slug:
 * with `--by source` each source counts its own pages, and every other
 * grouping reports `distinct_slugs` next to the raw page count, so twins are
 * never silently counted twice.
 *
 * `--collapse-aliases` groups near-duplicate type names. The active schema
 * pack decides first (a declared type stays itself, a declared alias joins
 * its canonical type). A type the pack does not declare is normalized: last
 * path segment, lower case, plural to singular (`media/Transcripts` ->
 * `transcript`). If the normalized name ends in `-<name>` or `_<name>` where
 * `<name>` is a declared type or another group, it joins that group
 * (`audio-transcript` -> `transcript`). Every group lists its member types
 * with the rule that put each one there, so the collapse is never silent.
 */
import { classifyStoredType, type TypeUsagePack } from './schema-pack/type-usage.ts';
import type { UntrustedReadPolicy } from './page-find.ts';

export const STATS_DIMENSIONS = ['source', 'type'] as const;
export type StatsDimension = typeof STATS_DIMENSIONS[number];

export interface PageCountQuery {
  sourceId?: string;
  sourceIds?: string[];
  /** Inclusive lower bound on the effective date (`effective_date`, else `updated_at`, else `created_at`). */
  since?: string;
  untrusted?: UntrustedReadPolicy;
}

/** Maps the distinct types the engine saw to their group keys (same order). */
export type TypeGrouper = (types: string[]) => string[];

export interface PageCounts {
  bySourceType: Array<{ source_id: string; type: string; pages: number }>;
  /** Raw and distinct-slug counts per group key; empty unless a grouper was passed. */
  byTypeGroup: Array<{ group: string; pages: number; distinct_slugs: number }>;
  total: { pages: number; distinct_slugs: number };
}

export type TypeCollapseRule = 'exact' | 'pack_alias' | 'normalized' | 'suffix';

export interface TypeMember {
  type: string;
  pages: number;
  via: TypeCollapseRule;
}

export interface StatsByGroup {
  source_id?: string;
  type?: string;
  pages: number;
  distinct_slugs?: number;
  member_types?: TypeMember[];
}

export interface StatsByResult {
  schema_version: 1;
  by: StatsDimension[];
  since: string | null;
  collapse_aliases: boolean;
  total_pages: number;
  distinct_slugs: number;
  groups: StatsByGroup[];
}

/** `'source,type'` (or an array) to dimensions; throws with a message naming the bad value. */
export function parseStatsBy(raw: unknown): StatsDimension[] {
  if (raw === undefined || raw === null) return [];
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
  if (parts === null || parts.some((part) => typeof part !== 'string')) throw new Error('by must be a comma-separated list of: source, type');
  const dims = [...new Set((parts as string[]).map((part) => part.trim().toLowerCase()).filter(Boolean))];
  const bad = dims.filter((dim) => !(STATS_DIMENSIONS as readonly string[]).includes(dim));
  if (bad.length) throw new Error(`by: unknown dimension ${bad.map((dim) => JSON.stringify(dim)).join(', ')}; use source, type or source,type`);
  return STATS_DIMENSIONS.filter((dim) => dims.includes(dim));
}

const singular = (word: string): string => {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !/(ss|is|us)$/.test(word)) return word.slice(0, -1);
  return word;
};

/** The documented fallback normalization for a type the pack does not declare. */
export function normalizeTypeName(type: string): string {
  return singular(type.trim().toLowerCase().split('/').filter(Boolean).pop() ?? '');
}

/** Group key and rule for each stored type (see the module comment for the rules). */
export function collapseTypes(types: readonly string[], pack: TypeUsagePack | null): Map<string, { group: string; via: TypeCollapseRule }> {
  const classify = (name: string) => (pack ? classifyStoredType(name, pack) : { kind: 'undeclared' as const });
  const out = new Map<string, { group: string; via: TypeCollapseRule; declared: boolean }>();
  for (const type of types) {
    const direct = classify(type);
    if (direct.kind === 'canonical') { out.set(type, { group: type, via: 'exact', declared: true }); continue; }
    if (direct.kind === 'alias_of') { out.set(type, { group: direct.canonical, via: 'pack_alias', declared: true }); continue; }
    const norm = normalizeTypeName(type) || type;
    const viaNorm = classify(norm);
    const group = viaNorm.kind === 'alias_of' ? viaNorm.canonical : norm;
    out.set(type, { group, via: group === type ? 'exact' : 'normalized', declared: viaNorm.kind !== 'undeclared' });
  }
  const known = new Set([...out.values()].map((entry) => entry.group));
  for (const pageType of pack?.page_types ?? []) known.add(pageType.name);
  for (const entry of out.values()) {
    if (entry.declared) continue;
    const tail = entry.group.split(/[-_]/).pop() ?? '';
    if (tail && tail !== entry.group && known.has(tail)) Object.assign(entry, { group: tail, via: 'suffix' });
  }
  return new Map([...out].map(([type, { group, via }]) => [type, { group, via }]));
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Group engine counts into the `get_stats` grouped result. */
export function groupPageCounts(
  counts: PageCounts,
  opts: { by: StatsDimension[]; since: string | null; collapse: Map<string, { group: string; via: TypeCollapseRule }> | null },
): StatsByResult {
  const bySource = opts.by.includes('source');
  const byType = opts.by.includes('type');
  const groupOf = (type: string) => opts.collapse?.get(type)?.group ?? type;
  const groups = new Map<string, StatsByGroup & { members: Map<string, TypeMember> }>();
  if (opts.by.length > 0) {
    for (const row of counts.bySourceType) {
      const type = byType ? groupOf(row.type) : undefined;
      const key = JSON.stringify([bySource ? row.source_id : null, type ?? null]);
      let group = groups.get(key);
      if (!group) {
        group = { ...(bySource ? { source_id: row.source_id } : {}), ...(byType ? { type } : {}), pages: 0, members: new Map() };
        groups.set(key, group);
      }
      group.pages += row.pages;
      if (opts.collapse && byType) {
        const member = group.members.get(row.type) ?? { type: row.type, pages: 0, via: opts.collapse.get(row.type)?.via ?? 'exact' };
        member.pages += row.pages;
        group.members.set(row.type, member);
      }
    }
  }
  const distinct = new Map(counts.byTypeGroup.map((row) => [row.group, row.distinct_slugs]));
  const out: StatsByGroup[] = [...groups.values()].map(({ members, ...group }) => ({
    ...group,
    ...(byType && !bySource ? { distinct_slugs: distinct.get(group.type!) ?? group.pages } : {}),
    ...(opts.collapse && byType
      ? { member_types: [...members.values()].sort((a, b) => b.pages - a.pages || byText(a.type, b.type)) }
      : {}),
  }));
  out.sort((a, b) => byText(a.source_id ?? '', b.source_id ?? '') || b.pages - a.pages || byText(a.type ?? '', b.type ?? ''));
  return {
    schema_version: 1,
    by: opts.by,
    since: opts.since,
    collapse_aliases: opts.collapse !== null,
    total_pages: counts.total.pages,
    distinct_slugs: counts.total.distinct_slugs,
    groups: out,
  };
}
