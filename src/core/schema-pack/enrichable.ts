// v0.38 T_E: pack-driven enrichable types + rubric routing.
//
// Pre-v0.38:
//   src/core/enrichment-service.ts:25 hardcoded:
//     entityType: 'person' | 'company';
//   src/core/enrichment/completeness.ts:221 hardcoded:
//     const RUBRICS_BY_TYPE = new Map([
//       ['person', personRubric], ['company', companyRubric],
//       ['deal', dealRubric], ...
//     ]);
//
// v0.38 T_E: the active schema pack declares which types are
// `enrichable_types` (with their associated rubric). gbrain-base
// preserves person + company + deal as enrichable defaults — existing
// enrichment behavior unchanged. Custom packs (research-state, legal,
// product) override with their domain entities.
//
// Usage (when callers wire this in Phase B):
//
//   const enrichable = enrichableTypesFromPack(activePack);
//   if (!enrichable.has(parsed.type)) { skip; }
//   const rubricName = rubricNameForType(activePack, parsed.type) ?? 'default';
//
// Until the wiring lands, legacy enrichment-service + completeness
// callers continue to hardcode person/company/deal — which gbrain-base
// also declares, so behavior is preserved.

import type { SchemaPackManifest } from './manifest-v1.ts';

/** Set of types the active pack marks enrichable. */
export function enrichableTypesFromPack(
  pack: Pick<SchemaPackManifest, 'enrichable_types'>,
): Set<string> {
  return new Set(pack.enrichable_types.map(e => e.type));
}

/**
 * Return the rubric slot name for a type, or null if the type isn't
 * declared as enrichable. Rubric names map to in-source Rubric objects
 * via `src/core/enrichment/completeness.ts` registries — the pack
 * specifies the NAME; the in-code module owns the implementation. This
 * keeps rubric authoring deterministic without serializing the rubric
 * structure into YAML.
 */
export function rubricNameForType(
  pack: Pick<SchemaPackManifest, 'enrichable_types'>,
  type: string,
): string | null {
  const entry = pack.enrichable_types.find(e => e.type === type);
  return entry?.rubric ?? null;
}
