// Bundled schema-pack registry — single source of truth for the packs that
// ship in src/core/schema-pack/base/. Keep every bundled-pack consumer
// (CLI/MCP inspection, active-pack loading, mutation guards, upgrade
// discovery) on this one list so they cannot drift.
//
// v0.39 T8 — gbrain-base + gbrain-recommended.
// v0.41 T4 — lens packs: creator, investor, engineer, everything (meta-pack).
// v0.42 type-unification — gbrain-base-v2, the 15-type canonical successor.

export const BUNDLED_PACK_NAMES = [
  'gbrain-base',
  'gbrain-recommended',
  'gbrain-creator',
  'gbrain-investor',
  'gbrain-engineer',
  'gbrain-everything',
  'gbrain-base-v2',
] as const;

export type BundledPackName = typeof BUNDLED_PACK_NAMES[number];

export function isBundledPackName(name: string): name is BundledPackName {
  return (BUNDLED_PACK_NAMES as readonly string[]).includes(name);
}
