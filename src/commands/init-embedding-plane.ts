/**
 * GBRA-248 W0b: a re-init that fell back to keyless only because no provider
 * key was in reach (a cold GBRAIN_HOME, a container restarted without its
 * key) must not write embedding_disabled over a content database that already
 * carries an embedding identity. It keeps the database's model and width in
 * the file plane instead and says which key to set. Only stored vectors make
 * the identity worth keeping: a database with none (a fresh one, or a keyless
 * brain whose config row holds only the new-install default) still gets
 * embedding_disabled, as does an explicit --no-embedding.
 */
import type { BrainEngine } from '../core/engine.ts';
import { readPrimaryEmbeddingStores, readStoredEmbeddingIdentity } from '../core/stored-embedding-identity.ts';
import { resolveRecipe } from '../core/ai/model-resolver.ts';
import type { ResolvedAIOptions } from './init.ts';

/** The database identity the file plane keeps. Vectors whose model or width cannot be confirmed keep nothing: embedding_disabled is written as before, and doctor embedding_plane_disagreement points at migrate embeddings --status. */
export interface KeptEmbedding { model: string; dimensions: number }

export async function keptEmbeddingIdentity(engine: BrainEngine, aiOpts: ResolvedAIOptions | undefined, fresh: boolean): Promise<KeptEmbedding | null> {
  if (!aiOpts?.noEmbedding || !aiOpts.implicitKeyless || fresh) return null;
  if (await engine.getConfig('embedding_disabled').catch(() => null) === 'true') return null;
  let embedded = false;
  for (const table of await readPrimaryEmbeddingStores(engine)) {
    const [row] = await engine.executeRaw<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${table} WHERE embedding IS NOT NULL) AS present`);
    if (row?.present) { embedded = true; break; }
  }
  if (!embedded) return null;
  const stored = await readStoredEmbeddingIdentity(engine).catch(() => null);
  const configured = Number(await engine.getConfig('embedding_dimensions').catch(() => null) ?? NaN);
  const agrees = stored?.model && (!Number.isFinite(configured) || configured === stored.dimensions);
  return agrees ? { model: stored!.model!, dimensions: stored!.dimensions } : null;
}

/** The notice init prints instead of the deferred-setup hint when it kept the database's identity. */
export function keptEmbeddingNotice(kept: KeptEmbedding): string {
  let key = 'the provider API key';
  try { key = resolveRecipe(kept.model.includes(':') ? kept.model : `openai:${kept.model}`).recipe.auth_env?.required?.[0] ?? key; } catch { /* unknown provider: generic wording */ }
  return `  Embedding: kept this database's ${kept.model} (${kept.dimensions}d) instead of disabling embeddings; no provider key was found. Set ${key}, then run gbrain embed --stale to embed pages written meanwhile.`;
}
