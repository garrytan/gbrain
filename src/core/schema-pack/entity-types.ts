/**
 * #4772: which stored page types are entities, by the active schema pack.
 *
 * The health counters (`getHealth` entity_page_count, link_coverage,
 * timeline_coverage, most_connected) and doctor's graph_coverage /
 * orphan_ratio gates used to answer "is this page an entity" with a string
 * literal list. A brain whose pack declares `researcher` or `yc` under
 * `primitive: entity` counted zero entities. This module is the one policy;
 * the SQL callers bind what it resolves.
 *
 * Policy: a type is an entity when the pack declares it with
 * `primitive: entity`, or lists it as an alias of such a type without
 * declaring it itself (`classifyStoredType` resolves aliases the same way).
 * The legacy names (`entity`, `person`, `company`, `organization`) stay
 * entities while a pack leaves them undeclared, so a brain that stores types
 * its pack does not know keeps its pre-pack reading; a pack that declares a
 * legacy name under another primitive reclassified it on purpose and wins.
 *
 * Per source: a per-source override (`schema_pack.source.<id>`) is consulted
 * only when the loader is given that source, so a scoped reading resolves
 * every requested source and a brain-wide reading resolves the brain's pack
 * plus every registered source with an override. The same type name may be
 * an entity in one source and a document in another; the bindings keep them
 * apart (`CASE p.source_id`) instead of unioning the names.
 *
 * Failure: when any pack in scope does not load, the whole resolution is
 * `pack_unavailable` with an empty filter. `best-effort.ts` is explicit that
 * a null pack is EMPTY-filter semantics and never a license to fall back to
 * a hardcoded list; callers surface the status instead of a zero that looks
 * like "no entities".
 *
 * The pack loader is imported lazily: both engines import this module for
 * their `HealthDeps.entityTypes` delegate, and a static schema-pack import in
 * the engine module graph breaks the OpenClaw plugin's context engine at load
 * time (same reason as `timeline-grading.ts`).
 */
import type { BrainEngine } from '../engine.ts';
import { joinFragments, sqlFragment, trustedSql, type SqlFragment } from '../engine-sql/fragment.ts';
import type { SchemaPackManifest } from './manifest-v1.ts';

/** The pre-pack hardcoded list; still entities while a pack leaves them undeclared. */
export const LEGACY_ENTITY_TYPES: readonly string[] = ['entity', 'person', 'company', 'organization'];

/** The entity type lists one reading binds: a default list, and the sources whose own pack answers differently. */
export interface EntityTypeFilter {
  /** Types that count in every source not named in `per_source`. */
  types: string[];
  /** Sources whose resolved list differs from `types`, sorted by source id. */
  per_source: Array<{ source_id: string; types: string[] }>;
}

export type EntityTypeResolution =
  | { status: 'resolved'; filter: EntityTypeFilter }
  /** A pack in scope did not load: the filter is empty, `unresolved` names the sources whose pack failed ('' is the brain's own pack). */
  | { status: 'pack_unavailable'; filter: EntityTypeFilter; unresolved: string[] };

export const EMPTY_ENTITY_TYPE_FILTER: EntityTypeFilter = { types: [], per_source: [] };

/** Entity type names under one resolved pack, sorted. */
export function entityTypesFromPack(pack: Pick<SchemaPackManifest, 'page_types'>): string[] {
  const declared = new Set(pack.page_types.map((t) => t.name));
  const aliased = new Set(pack.page_types.flatMap((t) => t.aliases ?? []));
  const out = new Set<string>();
  for (const pt of pack.page_types) {
    if (pt.primitive !== 'entity') continue;
    out.add(pt.name);
    for (const alias of pt.aliases ?? []) if (!declared.has(alias)) out.add(alias);
  }
  for (const legacy of LEGACY_ENTITY_TYPES) {
    if (!declared.has(legacy) && !aliased.has(legacy)) out.add(legacy);
  }
  return [...out].sort();
}

const SOURCE_OVERRIDE_PREFIX = 'schema_pack.source.';

/**
 * Resolve the entity type filter for a reading: `scope` is the requested
 * source ids, or null for brain-wide. One pack load per distinct source (the
 * loader caches by pack name); never throws.
 */
export async function resolveEntityTypes(
  engine: Pick<BrainEngine, 'getConfig' | 'executeRaw'>,
  scope: readonly string[] | null,
): Promise<EntityTypeResolution> {
  const { loadActivePackForLocalEngine } = await import('./best-effort.ts');
  const typesFor = async (sourceId?: string) => {
    const pack = await loadActivePackForLocalEngine(engine, sourceId ? { sourceId } : {});
    return pack ? entityTypesFromPack(pack.manifest) : null;
  };
  const unresolved: string[] = [];
  let defaults: string[] | null;
  let sources: string[];
  if (scope === null) {
    defaults = await typesFor();
    if (defaults === null) unresolved.push('');
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT substr(c.key, length($2::text) + 1) AS source_id FROM config c
        WHERE c.key LIKE $1 AND substr(c.key, length($2::text) + 1) IN (SELECT id FROM sources)`,
      [`${SOURCE_OVERRIDE_PREFIX}%`, SOURCE_OVERRIDE_PREFIX],
    ).catch(() => null);
    if (rows === null) return { status: 'pack_unavailable', filter: EMPTY_ENTITY_TYPE_FILTER, unresolved: [''] };
    sources = rows.map((r) => r.source_id);
  } else {
    sources = [...new Set(scope)];
    defaults = null;
  }
  const perSource: Array<{ source_id: string; types: string[] }> = [];
  for (const sourceId of sources.sort()) {
    const types = await typesFor(sourceId);
    if (types === null) { unresolved.push(sourceId); continue; }
    if (defaults === null && scope !== null) { defaults = types; continue; }
    if (defaults !== null && sameList(types, defaults)) continue;
    perSource.push({ source_id: sourceId, types });
  }
  if (unresolved.length > 0) return { status: 'pack_unavailable', filter: EMPTY_ENTITY_TYPE_FILTER, unresolved };
  return { status: 'resolved', filter: { types: defaults ?? [], per_source: perSource } };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * `<alias>.type` is an entity type under the filter, as a parameter-bound
 * fragment: `alias.type = ANY($n::text[])`, or a `CASE alias.source_id`
 * over the per-source lists when sources disagree. An empty filter is
 * `= ANY('{}')`, which matches no row.
 */
export function entityTypePredicateSql(alias: string, filter: EntityTypeFilter): SqlFragment {
  if (!SQL_ALIAS.test(alias)) throw new Error(`entityTypePredicateSql: alias must be a plain identifier, got ${JSON.stringify(alias)}`);
  const type = trustedSql(`${alias}.type`);
  if (filter.per_source.length === 0) return sqlFragment`${type} = ANY(${filter.types}::text[])`;
  const source = trustedSql(`${alias}.source_id`);
  const arms = joinFragments(
    filter.per_source.map((b) => sqlFragment`WHEN ${b.source_id}::text THEN ${b.types}::text[]`),
    ' ',
  );
  return sqlFragment`${type} = ANY(CASE ${source} ${arms} ELSE ${filter.types}::text[] END)`;
}
