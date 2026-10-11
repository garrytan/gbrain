/**
 * Whether a brain holds any image embeddings (`content_chunks.embedding_image`).
 * The cross-modal image arm can only return rows from that column, so a
 * text-only brain skips it: a question that mentions photos neither pays for
 * a multimodal embed nor reports a failed vector arm while the text arm
 * answers. One EXISTS probe per engine, cached for a minute; a probe error
 * reads as "has images" so behavior falls back to the pre-probe path.
 */
import type { BrainEngine } from '../engine.ts';

const TTL_MS = 60_000;
const cache = new WeakMap<object, { at: number; value: boolean }>();

export async function brainHasImageVectors(engine: Pick<BrainEngine, 'executeRaw'>, now = Date.now()): Promise<boolean> {
  const hit = cache.get(engine);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let value = true;
  try {
    const [row] = await engine.executeRaw<{ present: boolean }>('SELECT EXISTS (SELECT 1 FROM content_chunks WHERE embedding_image IS NOT NULL) AS present');
    value = row?.present === true || (row?.present as unknown) === 't';
  } catch {
    value = true;
  }
  cache.set(engine, { at: now, value });
  return value;
}

/** Test seam: forget the cached answer for an engine (after writing image chunks). */
export function forgetImageVectorPresence(engine: object): void {
  cache.delete(engine);
}
