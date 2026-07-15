// Bundled schema-pack registry — the single source of truth for which packs
// ship inside the binary and where their YAML lives.
//
// Each base/*.yaml is embedded via Bun's `with { type: 'file' }` asset
// pattern (same mechanism as chunkers/code.ts tree-sitter grammars and
// admin-embedded.ts). At runtime the import evaluates to a PATH string:
//   - `bun run` (dev): the real source-tree path.
//   - `bun build --compile`: a synthesized bunfs path whose bytes Bun
//     bundled into the binary, readable via node:fs (readFileSync).
//
// This is what makes bundled packs resolvable in the compiled binary. A
// plain `existsSync(join(dirname(import.meta.url), 'base', name))` does NOT
// resolve under --compile (the source tree isn't on disk) — that was the
// "Unknown pack: gbrain-base" bug for every bundled pack in the binary.
//
// Adding a new bundled pack: drop base/<name>.yaml, add an embed import +
// a BUNDLED_PACK_PATHS entry below. scripts/check-schema-packs-embedded.sh
// fails CI if a base/*.yaml has no embed entry that loads in the compiled
// artifact.

// @ts-ignore — `type: 'file'` import attribute is valid Bun syntax, absent from lib.d.ts
import GBRAIN_BASE from './base/gbrain-base.yaml' with { type: 'file' };
// @ts-ignore
import GBRAIN_BASE_V2 from './base/gbrain-base-v2.yaml' with { type: 'file' };
// @ts-ignore
import GBRAIN_RECOMMENDED from './base/gbrain-recommended.yaml' with { type: 'file' };
// @ts-ignore
import GBRAIN_CREATOR from './base/gbrain-creator.yaml' with { type: 'file' };
// @ts-ignore
import GBRAIN_INVESTOR from './base/gbrain-investor.yaml' with { type: 'file' };
// @ts-ignore
import GBRAIN_ENGINEER from './base/gbrain-engineer.yaml' with { type: 'file' };
// @ts-ignore
import GBRAIN_EVERYTHING from './base/gbrain-everything.yaml' with { type: 'file' };

/**
 * Bundled pack name → embedded YAML path (resolves in dev + compiled).
 * Single source of truth; consumed by load-active.ts (runtime locator),
 * commands/schema.ts (CLI surface), and mutate.ts (read-only guard).
 */
export const BUNDLED_PACK_PATHS: Readonly<Record<string, string>> = {
  'gbrain-base': GBRAIN_BASE,
  'gbrain-base-v2': GBRAIN_BASE_V2,
  'gbrain-recommended': GBRAIN_RECOMMENDED,
  'gbrain-creator': GBRAIN_CREATOR,
  'gbrain-investor': GBRAIN_INVESTOR,
  'gbrain-engineer': GBRAIN_ENGINEER,
  'gbrain-everything': GBRAIN_EVERYTHING,
};

/** Canonical set of bundled (read-only) pack names. */
export const BUNDLED_PACK_NAMES: ReadonlySet<string> = new Set(Object.keys(BUNDLED_PACK_PATHS));

/** Resolve a bundled pack name to its embedded YAML path, or null if not bundled. */
export function bundledPackPath(name: string): string | null {
  return BUNDLED_PACK_PATHS[name] ?? null;
}

/** Sorted bundled pack names, for stable CLI display. */
export function bundledPackNames(): string[] {
  return Object.keys(BUNDLED_PACK_PATHS).sort();
}
