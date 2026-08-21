/**
 * Bundled schema-pack assets [ENG-6] (#4266).
 *
 * `bin/gbrain` ships via `bun build --compile`, where filesystem-relative
 * pack resolution breaks: the import.meta-derived paths in
 * `load-active.ts:defaultPackLocator` and `schema.ts:packPathByName` point
 * into `/$bunfs/...` directories that only exist for files the bundler
 * actually embedded. Nothing imported the base/*.yaml packs, so every
 * bundled pack lookup returned null and the compiled binary threw
 * UnknownPackError for ALL bundled packs.
 *
 * Fix: statically import each bundled pack YAML with Bun's
 * `import ... with { type: 'file' }` — the same mechanism as the bootstrap
 * templates in `src/core/bootstrap/assets.ts` and the tree-sitter WASMs in
 * `src/core/chunkers/code.ts`. In dev the import resolves to the source-tree
 * path; in the compiled binary to a bundler-synthesized path. Either way
 * `readFileSync(path)` (what `loadPackFromFile` does) works.
 *
 * Keep this file in lockstep with `BUNDLED_PACK_NAMES` in `bundled.ts` —
 * the exhaustive Record below fails typecheck if a name is added there
 * without a matching asset import here.
 */

import { existsSync } from 'node:fs';
import { isBundledPackName, type BundledPackName } from './bundled.ts';

// @ts-ignore — type: 'file' import attribute is valid Bun syntax, not in lib.d.ts
import P_BASE from './base/gbrain-base.yaml' with { type: 'file' };
// @ts-ignore
import P_RECOMMENDED from './base/gbrain-recommended.yaml' with { type: 'file' };
// @ts-ignore
import P_CREATOR from './base/gbrain-creator.yaml' with { type: 'file' };
// @ts-ignore
import P_INVESTOR from './base/gbrain-investor.yaml' with { type: 'file' };
// @ts-ignore
import P_ENGINEER from './base/gbrain-engineer.yaml' with { type: 'file' };
// @ts-ignore
import P_EVERYTHING from './base/gbrain-everything.yaml' with { type: 'file' };
// @ts-ignore
import P_BASE_V2 from './base/gbrain-base-v2.yaml' with { type: 'file' };

const BUNDLED_PACK_ASSETS: Record<BundledPackName, string> = {
  'gbrain-base': P_BASE as unknown as string,
  'gbrain-recommended': P_RECOMMENDED as unknown as string,
  'gbrain-creator': P_CREATOR as unknown as string,
  'gbrain-investor': P_INVESTOR as unknown as string,
  'gbrain-engineer': P_ENGINEER as unknown as string,
  'gbrain-everything': P_EVERYTHING as unknown as string,
  'gbrain-base-v2': P_BASE_V2 as unknown as string,
};

/**
 * Resolve a bundled pack name to a readable path (dev: source-tree path;
 * compiled binary: bundler-synthesized `/$bunfs/...` path). Returns null
 * for non-bundled names or when the asset path is unexpectedly unreadable
 * (callers keep their import.meta fallback for that case).
 */
export function bundledPackPath(name: string): string | null {
  if (!isBundledPackName(name)) return null;
  const assetPath = BUNDLED_PACK_ASSETS[name];
  if (assetPath && existsSync(assetPath)) return assetPath;
  return null;
}
