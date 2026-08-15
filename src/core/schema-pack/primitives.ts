// v0.38 Schema Pack primitives — the five composable defaults.
//
// A primitive is a named bundle of (default link verbs, default frontmatter
// fields, expert-routing flag, enrichment rubric slot). Pack types extend
// one primitive by name; the primitive's defaults flow through unless the
// type overrides specific fields. Closed enum — packs CANNOT add new
// primitives, only types that extend them. This keeps compile-time
// exhaustiveness available on the primitive enum even though PageType
// is now open string.
//
// Primitives drive INHERITANCE DEFAULTS only — NOT query closure. The E8
// refinement of D12 separates these two axes: primitive = defaults graph,
// `aliases:` field = closure graph. Run `gbrain whoknows expert` and you'd
// expect to find person + researcher + cofounder, NOT adversary-profile
// (also entity primitive). Per-type `aliases: [person]` is the opt-in;
// primitive sharing is not.

import { assertNever } from '../types.ts';
import type { PackPrimitive } from './manifest-v1.ts';

export { PACK_PRIMITIVES, type PackPrimitive } from './manifest-v1.ts';

export interface PrimitiveDefaults {
  /** Default link verbs the primitive emits in inferLinkType heuristics. */
  default_link_verbs: readonly string[];
  /** Default frontmatter fields the inference layer recognizes. */
  default_frontmatter_fields: readonly string[];
  /** Whether types under this primitive are expert-routing candidates by default. */
  default_expert_routing: boolean;
  /** Default enrichment rubric slot (consulted by enrichment-service). */
  default_rubric: string | null;
  /** Whether types under this primitive are facts-eligible by default. */
  default_extractable: boolean;
}

const ENTITY: PrimitiveDefaults = {
  default_link_verbs: ['works_at', 'founded', 'mentions', 'invested_in', 'advises', 'attended'],
  default_frontmatter_fields: ['aliases', 'email', 'location', 'role'],
  default_expert_routing: true,
  default_rubric: 'entity-default',
  default_extractable: true,
};

const MEDIA: PrimitiveDefaults = {
  default_link_verbs: ['cites', 'references', 'authored_by'],
  default_frontmatter_fields: ['url', 'source', 'author', 'date'],
  default_expert_routing: false,
  default_rubric: 'media-default',
  default_extractable: false,
};

const TEMPORAL: PrimitiveDefaults = {
  default_link_verbs: ['attended', 'occurred_at'],
  default_frontmatter_fields: ['date', 'attendees', 'duration', 'location'],
  default_expert_routing: false,
  default_rubric: 'temporal-default',
  default_extractable: true,
};

const ANNOTATION: PrimitiveDefaults = {
  default_link_verbs: ['claims', 'sources_from'],
  default_frontmatter_fields: ['confidence', 'valid_from', 'source'],
  default_expert_routing: false,
  default_rubric: 'annotation-default',
  default_extractable: false,
};

const CONCEPT: PrimitiveDefaults = {
  default_link_verbs: ['relates_to', 'supersedes', 'mentions'],
  default_frontmatter_fields: ['tags'],
  default_expert_routing: false,
  default_rubric: 'concept-default',
  default_extractable: false,
};

/**
 * Lookup defaults for a primitive. Exhaustive over the closed enum —
 * adding a new primitive requires updating this switch AND the enum;
 * `assertNever` will fail to type-check otherwise.
 */
export function getPrimitiveDefaults(p: PackPrimitive): PrimitiveDefaults {
  switch (p) {
    case 'entity': return ENTITY;
    case 'media': return MEDIA;
    case 'temporal': return TEMPORAL;
    case 'annotation': return ANNOTATION;
    case 'concept': return CONCEPT;
    default: return assertNever(p);
  }
}
