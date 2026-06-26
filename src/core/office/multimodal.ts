// src/core/office/multimodal.ts
//
// Selective multimodal embedding for office visuals (docs/proposals/office-ingest.md
// §21.4, D6). Picks which DocIR image assets to embed, then routes them through
// the multimodal embedder into image chunks (embedding_image / modality 'image').
//
// Forward-looking for M0: the sidecar emits no image assets until OCR (M1) /
// multimodal (M3), so this is a no-op on text-layer documents — but it's wired
// so figures/page-renders embed automatically once they start flowing.

import { embedMultimodal } from '../embedding.ts';
import { isAvailable } from '../ai/gateway.ts';
import type { DocAsset, DocBlock, DocIR, SourceLocator } from './types.ts';
import type { OfficeConfig } from './config.ts';

const SPARSE_TEXT = 280; // < this many text chars on a page + a figure ⇒ visual
const NEAR_EMPTY_TEXT = 50; // < this ⇒ page is basically a picture/diagram

export interface ImageChunk {
  chunk_text: string;
  embedding_image: Float32Array;
  loc: SourceLocator;
}

/**
 * Pick which assets to embed for the given mode (pure, unit-tested):
 *  - 'off'        → none
 *  - 'all'        → every asset
 *  - 'selective'  → extracted figures (inherently visual) + rendered pages that
 *    are visually dense (sparse text and/or figure-heavy).
 */
export function selectAssetsToEmbed(docir: DocIR, mode: OfficeConfig['multimodal']): DocAsset[] {
  if (mode === 'off') return [];
  if (mode === 'all') return docir.assets;
  return docir.assets.filter((a) =>
    a.is_rendered_page ? pageIsVisuallyDense(docir.blocks, a.locator) : true,
  );
}

function pageIsVisuallyDense(blocks: DocBlock[], loc: SourceLocator): boolean {
  const key = loc.page ?? loc.slide;
  if (key == null) return false;
  const onPage = blocks.filter((b) => (b.locator.page ?? b.locator.slide) === key);
  const textChars = onPage
    .filter((b) => b.type !== 'figure')
    .reduce((n, b) => n + (b.text?.length ?? 0), 0);
  const figures = onPage.filter((b) => b.type === 'figure').length;
  return textChars < NEAR_EMPTY_TEXT || (figures >= 1 && textChars < SPARSE_TEXT);
}

function describe(loc: SourceLocator): string {
  if (loc.page != null) return `page ${loc.page}`;
  if (loc.slide != null) return `slide ${loc.slide}`;
  return 'document';
}

/**
 * Embed selected visual assets → image chunks. Best-effort: returns [] when no
 * multimodal provider is available, and skips any asset that fails — an office
 * import must never fail on the visual path.
 */
export async function multimodalChunks(docir: DocIR, cfg: OfficeConfig): Promise<ImageChunk[]> {
  const selected = selectAssetsToEmbed(docir, cfg.multimodal);
  if (selected.length === 0) return [];
  if (!isAvailable('embedding')) return [];
  const out: ImageChunk[] = [];
  for (const asset of selected) {
    try {
      const [vec] = await embedMultimodal([
        { kind: 'image_base64', data: asset.data_b64, mime: asset.mime },
      ]);
      if (vec) {
        out.push({
          chunk_text: `[image: ${describe(asset.locator)}]`,
          embedding_image: vec,
          loc: asset.locator,
        });
      }
    } catch {
      // best-effort — skip this asset
    }
  }
  return out;
}
