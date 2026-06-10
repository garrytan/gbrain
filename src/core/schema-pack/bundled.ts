// Bundled schema-pack registry.
//
// Keep all bundled pack consumers on this one list so CLI/MCP inspection,
// active-pack loading, mutation guards, and upgrade discovery cannot drift.

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
