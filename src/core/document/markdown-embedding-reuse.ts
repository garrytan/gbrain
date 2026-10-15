import { createHash } from 'node:crypto';
import type { Chunk, ChunkInput } from '../types.ts';

export function markdownEmbeddingInputHash(model: string, dimensions: number, mode: string, input: string): string {
  return createHash('sha256').update(JSON.stringify(['embedding-input-v1', 'embedding', model, dimensions, mode, input])).digest('hex');
}

export function reuseMarkdownEmbeddings(
  planned: ChunkInput[], stored: Chunk[], inputs: string[], model: string, dimensions: number,
  mode: string, storedMode: string | null | undefined,
): { reused: number; pending: number[] } {
  const candidates = new Map<string, Chunk[]>();
  for (const chunk of stored) {
    if (!chunk.embedding || chunk.model !== model || chunk.embedding.length !== dimensions) continue;
    if (chunk.embedded_text_hash != null
      && chunk.embedded_text_hash !== createHash('md5').update(chunk.chunk_text).digest('hex')) continue;
    const key = `${chunk.chunk_source}\0${chunk.chunk_text}`;
    const bucket = candidates.get(key);
    if (bucket) bucket.push(chunk);
    else candidates.set(key, [chunk]);
  }
  let reused = 0;
  const pending: number[] = [];
  for (const [index, chunk] of planned.entries()) {
    const key = `${chunk.chunk_source}\0${chunk.chunk_text}`;
    const bucket = candidates.get(key);
    const hash = markdownEmbeddingInputHash(model, dimensions, mode, inputs[index]);
    const match = bucket?.findIndex(candidate => candidate.embedding_input_hash != null
      ? candidate.embedding_input_hash === hash
      : mode === 'none' && storedMode == null && inputs[index] === chunk.chunk_text) ?? -1;
    if (bucket && match >= 0) {
      const [candidate] = bucket.splice(match, 1);
      chunk.embedding = candidate.embedding!;
      chunk.model = candidate.model!;
      chunk.token_count = candidate.token_count ?? undefined;
      chunk.embedding_input_hash = candidate.embedding_input_hash ?? undefined;
      reused++;
      if (!bucket.length) candidates.delete(key);
    } else pending.push(index);
  }
  return { reused, pending };
}
