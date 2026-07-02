// Smoketest probe for scripts/check-packs-embedded.sh.
//
// Compiled standalone via `bun build --compile` and run as a binary so the
// check exercises the EXACT failure mode that hit production: bundled
// schema-pack YAMLs not embedded in the `--compile` binary. If the
// `with { type: 'file' }` imports in bundled-packs.ts regress (or a pack is
// added to the registry without an embedded import), loading that pack
// throws inside the compiled binary and `all_bundled_loaded` flips false.
//
// We resolve each bundled pack through the real `loadActivePack` boundary
// (perCall + remote:false) so the `extends` walk also loads embedded
// PARENT packs (e.g. gbrain-recommended extends gbrain-base) — the precise
// chain that took down `jarvis-operational` (which extends gbrain-base).

import { loadActivePack } from '../src/core/schema-pack/load-active.ts';
import { BUNDLED_PACK_LIST } from '../src/core/schema-pack/bundled-packs.ts';

const perPack: Record<string, number | string> = {};
let allLoaded = true;
let basePageTypes = 0;

for (const name of BUNDLED_PACK_LIST) {
  try {
    const pack = await loadActivePack({ cfg: null, remote: false, perCall: name });
    perPack[name] = pack.manifest.page_types.length;
    if (name === 'gbrain-base') basePageTypes = pack.manifest.page_types.length;
  } catch (e) {
    perPack[name] = `ERROR: ${(e as Error).message}`;
    allLoaded = false;
  }
}

console.log(
  JSON.stringify(
    {
      // True only when every bundled pack loaded from the embedded asset
      // without throwing (the extends walk loads embedded parents too).
      all_bundled_loaded: allLoaded,
      // gbrain-base MUST declare page types; 0 means the YAML embedded but
      // didn't parse (or an empty asset was bundled).
      base_page_types: basePageTypes,
      per_pack: perPack,
    },
    null,
    2,
  ),
);
