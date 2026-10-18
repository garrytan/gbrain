/**
 * Per-process cache of resolved query embeddings, used only by
 * `gateway.embedQuery` (document embeds never use it).
 *
 * The key is the recipe, the resolved model id, the base-URL override, the
 * effective dimensions and the exact string sent to the provider, so a hit is
 * the vector the provider would have been asked for. Map order is the LRU
 * order (512 entries, 10-minute TTL). Only resolved vectors are stored, never
 * an in-flight promise, so one caller's abort or failure cannot reach another
 * caller; reads and writes copy, so a caller mutating its vector cannot change
 * the cache. The gateway clears it with its model cache whenever the config or
 * env that built the provider client changes; the generation counter keeps an
 * embed that started before a clear from storing its vector after it.
 */

const MAX_ENTRIES = 512;
const TTL_MS = 10 * 60_000;

const entries = new Map<string, { vector: Float32Array; expiresAt: number }>();
let generation = 0;

export function queryEmbedCacheKey(recipeId: string, modelId: string, baseUrl: string, dims: number, input: string): string {
  return JSON.stringify([recipeId, modelId, baseUrl, dims, 'query', input]);
}

/** A copy of the live entry for `key` (refreshed as most recently used), or null. */
export function cachedQueryEmbedding(key: string): Float32Array | null {
  const entry = entries.get(key);
  if (!entry) return null;
  entries.delete(key);
  if (entry.expiresAt <= Date.now()) return null;
  entries.set(key, entry);
  return new Float32Array(entry.vector);
}

export function queryEmbedGeneration(): number {
  return generation;
}

/** Store `vector` unless the cache was cleared since `startedAt` (a queryEmbedGeneration() value). */
export function storeQueryEmbedding(key: string, vector: Float32Array, startedAt: number): void {
  if (startedAt !== generation) return;
  entries.set(key, { vector: new Float32Array(vector), expiresAt: Date.now() + TTL_MS });
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

export function clearQueryEmbedCache(): void {
  entries.clear();
  generation++;
}
