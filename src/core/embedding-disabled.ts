/**
 * Is this brain keyless by choice (`init --no-embedding`)? One predicate for
 * every consumer that must stop recommending embedding work on such a brain
 * (doctor, onboard, features, jobs): the file-plane `embedding_disabled`
 * sentinel, or the DB-plane row init also writes. Never throws.
 */
import { loadConfig, type GBrainConfig } from './config.ts';
import type { BrainEngine } from './engine.ts';

export async function embeddingsDisabled(engine?: { getConfig(key: string): Promise<string | null> } | null): Promise<boolean> {
  try {
    if (loadConfig()?.embedding_disabled === true) return true;
  } catch { /* unreadable config: fall through to the DB plane */ }
  if (!engine) return false;
  try {
    return (await engine.getConfig('embedding_disabled')) === 'true';
  } catch {
    return false;
  }
}

/**
 * May a fact write send its text to the embedding provider? No when the
 * effective config disables embedding (the caller's config, else the config
 * this process's persistence consumer prepares with) or the brain itself does
 * (file or DB plane). A brain keyless by choice never sends fact text to a
 * provider, even when a key sits in the environment. Never throws.
 */
export async function factEmbeddingDisabled(engine: BrainEngine | null | undefined, config?: GBrainConfig | null): Promise<boolean> {
  let effective = config ?? null;
  if (!effective && engine) {
    const { persistenceConsumerConfig } = await import('./persistence/service.ts');
    effective = persistenceConsumerConfig(engine) ?? null;
  }
  if (effective?.embedding_disabled === true) return true;
  return embeddingsDisabled(engine);
}
