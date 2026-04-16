/**
 * E5 Embedding Adapter
 *
 * Drop-in replacement for embedding.ts that calls a self-hosted
 * intfloat/multilingual-e5-small (or compatible) HTTP endpoint
 * instead of the OpenAI API.
 *
 * Configure via environment variables:
 *   GBRAIN_EMBEDDING_PROVIDER=e5          — selects this adapter
 *   GBRAIN_E5_URL=http://host:8000/embed  — embedding endpoint
 *   GBRAIN_E5_BATCH_SIZE=16               — texts per request (default 16)
 *
 * The endpoint must accept:
 *   POST { "texts": string[] }  →  { "embeddings": number[][], "model": string }
 *
 * Dimensions are auto-detected from the first response and exported
 * as EMBEDDING_DIMENSIONS for schema creation.
 */

const E5_URL = process.env.GBRAIN_E5_URL || 'http://embeddings-e5:8000/embed';
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60000;
const BATCH_SIZE = parseInt(process.env.GBRAIN_E5_BATCH_SIZE || '16', 10);

let detectedDimensions: number | null = null;
let detectedModel: string = 'e5-unknown';

export async function embed(text: string): Promise<Float32Array> {
  const result = await embedBatch([text]);
  return result[0];
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch);
    results.push(...batchResults);
  }

  return results;
}

async function embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(E5_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`E5 embedding request failed: ${response.status} ${body}`);
      }

      const data = await response.json() as {
        embeddings: number[][];
        model?: string;
      };

      if (!data.embeddings || data.embeddings.length !== texts.length) {
        throw new Error(
          `E5 returned ${data.embeddings?.length ?? 0} embeddings for ${texts.length} texts`
        );
      }

      // Auto-detect dimensions and model from first successful response
      if (detectedDimensions === null && data.embeddings.length > 0) {
        detectedDimensions = data.embeddings[0].length;
        detectedModel = data.model || `e5-${detectedDimensions}d`;
      }

      return data.embeddings.map(e => new Float32Array(e));

    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('E5 embedding failed after all retries');
}

/**
 * Probe the E5 endpoint to detect dimensions.
 * Called once during init to determine the correct vector column size.
 */
export async function probeE5Dimensions(): Promise<number> {
  if (detectedDimensions !== null) return detectedDimensions;
  const result = await embed('dimension probe');
  return result.length;
}

export function getE5Dimensions(): number {
  return detectedDimensions ?? 384; // multilingual-e5-small default
}

export function getE5Model(): string {
  return detectedModel;
}

// Exports matching embedding.ts interface
export const EMBEDDING_MODEL = 'e5';
export const EMBEDDING_DIMENSIONS = 384; // static default; runtime uses getE5Dimensions()
