// Static text imports keep bundled schema-pack manifests available inside
// `bun build --compile` binaries. The normal source/runtime path still loads
// YAML from disk first so cross-process mtime invalidation keeps working during
// development; these immutable strings are the compiled-binary fallback.

import gbrainBase from './base/gbrain-base.yaml' with { type: 'text' };
import gbrainRecommended from './base/gbrain-recommended.yaml' with { type: 'text' };
import gbrainCreator from './base/gbrain-creator.yaml' with { type: 'text' };
import gbrainInvestor from './base/gbrain-investor.yaml' with { type: 'text' };
import gbrainEngineer from './base/gbrain-engineer.yaml' with { type: 'text' };
import gbrainEverything from './base/gbrain-everything.yaml' with { type: 'text' };
import gbrainBaseV2 from './base/gbrain-base-v2.yaml' with { type: 'text' };

const EMBEDDED_BUNDLED_PACKS: Readonly<Record<string, string>> = Object.freeze({
  'gbrain-base': gbrainBase,
  'gbrain-recommended': gbrainRecommended,
  'gbrain-creator': gbrainCreator,
  'gbrain-investor': gbrainInvestor,
  'gbrain-engineer': gbrainEngineer,
  'gbrain-everything': gbrainEverything,
  'gbrain-base-v2': gbrainBaseV2,
});

export function embeddedBundledPack(name: string): string | null {
  return EMBEDDED_BUNDLED_PACKS[name] ?? null;
}
