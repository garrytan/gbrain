/**
 * A deterministic counting embedder (Wave C, finding ceo-r3-native-6): stands in for the embedding provider through the
 * gateway's test transport (`__setEmbedTransportForTests`), so the normal embed paths run unchanged and no network call
 * is made. Every input gets a full-size vector, as long as the brain's active embedding column is declared in the
 * database, derived from the input's sha256 (the same text always gets the same unit vector, different texts different
 * ones). It counts provider calls, inputs and tokens (one token per four characters, rounded up per input, reported to
 * the gateway as usage), which the large-page bench and its kill-and-resume cells compare against live chunks.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../../src/core/search/embedding-column.ts';

export interface CountingEmbedder { dims: number; calls: number; inputs: number; tokens: number; restore(): void }

/** The unit vector the counting embedder returns for `text` at `dims` dimensions (xorshift128 seeded by its sha256). */
export function countingVector(text: string, dims: number): number[] {
  const digest = createHash('sha256').update(text, 'utf8').digest();
  let [a, b, c, d] = [0, 4, 8, 12].map(at => digest.readUInt32LE(at) || 1) as [number, number, number, number];
  const values = Array.from({ length: dims }, () => {
    const t = (a ^ (a << 11)) >>> 0;
    [a, b, c] = [b, c, d];
    d = (d ^ (d >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return d / 0x8000_0000 - 1;
  });
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map(v => v / norm);
}

/**
 * Configures the gateway for a placeholder OpenAI model at the dimensions of the brain's active embedding column, as the
 * database declares it (`vector(N)` / `halfvec(N)`), and installs the counting transport; `restore()` undoes both.
 */
export async function installCountingEmbedder(engine: BrainEngine): Promise<CountingEmbedder> {
  const column = await resolveActiveEmbeddingColumnFromEngine(engine);
  const [declared] = await engine.executeRaw<{ type: string }>(`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
    WHERE attrelid = 'content_chunks'::regclass AND attname = $1`, [column.name]);
  const dims = Number(/\((\d+)\)/.exec(declared?.type ?? '')?.[1]);
  if (!Number.isInteger(dims) || dims < 1) throw new Error(`installCountingEmbedder: content_chunks.${column.name} declares no dimensions (${declared?.type ?? 'missing'})`);
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-counting-embedder' } });
  const counter: CountingEmbedder = { dims, calls: 0, inputs: 0, tokens: 0, restore: () => { __setEmbedTransportForTests(null); resetGateway(); } };
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    const tokens = values.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
    counter.calls++;
    counter.inputs += values.length;
    counter.tokens += tokens;
    return { embeddings: values.map(text => countingVector(text, dims)), usage: { tokens } };
  }) as never);
  return counter;
}
