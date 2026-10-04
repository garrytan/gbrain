/**
 * Is this brain keyless by choice (`init --no-embedding`)? One predicate for
 * every consumer that must stop recommending embedding work on such a brain
 * (doctor, onboard, features, jobs): the file-plane `embedding_disabled`
 * sentinel, or the DB-plane row init also writes. Never throws.
 */
import { loadConfig } from './config.ts';

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
