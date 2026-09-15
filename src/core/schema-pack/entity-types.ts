// #4772: pack-driven entity types for the READ-ONLY counters (getHealth,
// doctor graph_coverage / orphan_ratio, the init nudge).
//
// Deliberate design for COUNTERS: the pack's `primitive: entity` types are
// UNIONED with the legacy literal set, so every page counted today keeps
// counting (no pack declares `entity` or `organization`, yet brains hold
// such pages) and pack-declared types count too — a page whose type only
// the pack names must not read as "not an entity" (coverage null,
// most_connected empty, graph_coverage short-circuited). This is the
// opposite of the capability helpers' no-fallback rule in best-effort.ts —
// a counter that undercounts is a false "no entities" signal, not a
// user-intent violation. Write/dispatch sites (onboard checks.ts
// VISIBLE_ENTITY_PREDICATE, extract-ner target types, by-mention gazetteer)
// are deliberately literal and NOT routed here; each changes what is
// written and needs its own change.

import type { BrainEngine } from '../engine.ts';
import type { SchemaPackManifest } from './manifest-v1.ts';
import { loadActivePackForLocalEngine } from './best-effort.ts';

/** The pre-#4772 hardcoded set (union of every counter's spelling). */
export const LEGACY_ENTITY_TYPES: readonly string[] = ['entity', 'person', 'company', 'organization'];

/**
 * Pack-declared `primitive: entity` type names (declaration order) followed
 * by the legacy literals, deduplicated. `null`/`undefined` pack → legacy set.
 */
export function entityTypesFromPack(
  pack?: Pick<SchemaPackManifest, 'page_types'> | null,
): string[] {
  const fromPack = (pack?.page_types ?? [])
    .filter(pt => pt.primitive === 'entity')
    .map(pt => pt.name);
  return [...new Set([...fromPack, ...LEGACY_ENTITY_TYPES])];
}

/**
 * Entity types for an engine-backed local counter. Resolves the active pack
 * through the same tier chain `schema active` reports (env > DB config >
 * file > default); any load failure degrades to the legacy set so a counter
 * can never throw or shrink below today's behavior.
 */
export async function entityTypesForEngine(
  engine: Pick<BrainEngine, 'getConfig'>,
): Promise<string[]> {
  try {
    return entityTypesFromPack((await loadActivePackForLocalEngine(engine))?.manifest);
  } catch {
    return entityTypesFromPack(null);
  }
}
