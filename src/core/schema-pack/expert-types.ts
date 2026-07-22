// v0.38 T_W: pack-driven expert types for whoknows / find_experts.
//
// Pre-v0.38: whoknows.ts hardcoded DEFAULT_TYPES = ['person', 'company']
// (and postgres-engine + pglite-engine had the same literal in their
// find_experts SQL — codex finding #3 named all three sites).
//
// v0.38 T_W: the active schema pack declares which types are
// `expert_routing: true`. gbrain-base preserves person + company as
// the default expert types so existing behavior is unchanged. Research
// brains declaring `researcher` + `principal-investigator` with
// `expert_routing: true` get those types routed to whoknows queries
// automatically.
//
// Usage (when callers wire this in Phase B / Phase C):
//
//   const types = opts.types ?? expertTypesFromPack(activePack);
//   const results = await hybridSearch(engine, query, { types, ... });
//
// Until the wiring lands, legacy whoknows.ts callers continue to use
// the hardcoded DEFAULT_TYPES = ['person', 'company'] — which gbrain-
// base also declares, so behavior is preserved.

import type { SchemaPackManifest } from './manifest-v1.ts';

/**
 * Extract the list of pack-declared types with expert_routing: true,
 * in pack manifest declaration order. Empty array means the pack has
 * NO expert types — callers should treat this as "expert search not
 * applicable" rather than falling back to gbrain-base defaults (the
 * pack made an explicit choice).
 *
 * For gbrain-base, this returns ['person', 'company'] (the pre-v0.38
 * hardcoded defaults). Custom packs override freely.
 */
export function expertTypesFromPack(
  pack: Pick<SchemaPackManifest, 'page_types'>,
): string[] {
  return pack.page_types
    .filter(pt => pt.expert_routing === true)
    .map(pt => pt.name);
}

/**
 * Stricter variant: returns the list, but throws when empty. Use this
 * at the `whoknows` CLI entrypoint to surface a clear error when the
 * active pack declares no expert types — rather than silently returning
 * zero results.
 */
export function expertTypesFromPackOrThrow(
  pack: Pick<SchemaPackManifest, 'name' | 'page_types'>,
): string[] {
  const types = expertTypesFromPack(pack);
  if (types.length === 0) {
    throw new Error(
      `active schema pack "${pack.name}" declares no types with ` +
      `expert_routing: true. \`gbrain whoknows\` and \`find_experts\` ` +
      `cannot route queries. Edit the pack manifest to mark at least one ` +
      `page_type as expert_routing: true, or switch packs.`,
    );
  }
  return types;
}
