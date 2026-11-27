/**
 * `initSchema` on the Rust engine. The store creates its tables when it opens (rust/README.md, `brain.open`), so the
 * only work left is what PGLite's schema text seeds into `config`: the `embedding_model` and `embedding_dimensions`
 * rows, each written only when the brain records none (PGLite's `ON CONFLICT (key) DO NOTHING`). The values follow
 * PGLite's initSchema: the stored embedding identity when the brain has one, else the gateway's model and width, else
 * the install defaults. Unlike PGLite, a stored width with no known model writes no model row instead of refusing.
 *
 * Export only BrainEngine members from this file.
 */
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from '../../ai/defaults.ts';
import type { EmbeddingIdentity } from '../../engine-sql/embedding-catalog.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The model and width PGLite's initSchema takes when the brain has no stored identity: the gateway's, else the defaults. */
async function gatewayEmbedding(): Promise<{ model: string; dimensions: number }> {
  try {
    const gateway = await import('../../ai/gateway.ts'); // engine-dynamic-import-ok
    // Both accessors throw when the gateway is unconfigured; the catch is the default fallback, as in PGLite.
    return { dimensions: gateway.getEmbeddingDimensions(), model: gateway.getEmbeddingModel() };
  } catch {
    return { model: DEFAULT_EMBEDDING_MODEL, dimensions: DEFAULT_EMBEDDING_DIMENSIONS };
  }
}

export const initSchema: StoreMember<[], void> = async (brain) => {
  const stored = await storeCall({ member: 'initSchema' }, () => brain.readEmbeddingIdentity()) as EmbeddingIdentity | null;
  const seed = stored ? { model: stored.model, dimensions: stored.dimensions } : await gatewayEmbedding();
  // Each key is read by its literal name, so the config-key guard (test/config-reader-keys-registered.test.ts) sees it.
  const model = seed.model;
  if (model !== null && await storeCall({ member: 'initSchema' }, () => brain.getConfig('embedding_model')) === null) {
    await storeCall({ member: 'initSchema' }, () => brain.setConfig('embedding_model', model));
  }
  if (await storeCall({ member: 'initSchema' }, () => brain.getConfig('embedding_dimensions')) === null) {
    await storeCall({ member: 'initSchema' }, () => brain.setConfig('embedding_dimensions', String(seed.dimensions)));
  }
};
