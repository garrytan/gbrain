/**
 * Embedding Service — multi-provider
 *
 * Provider priority:
 *   1. Gemini (GEMINI_API_KEY)  — gemini-embedding-001, 1536 dims, free tier
 *   2. OpenAI (OPENAI_API_KEY)  — text-embedding-3-large, 1536 dims
 *
 * Both produce 1536-dim vectors so the DB schema is unchanged.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

const DIMENSIONS = 1536;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

// ─── Provider detection ────────────────────────────────────────────────────
function getProvider(): 'gemini' | 'openai' {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  throw new Error(
    'No embedding API key found.\n' +
    'Set GEMINI_API_KEY (free tier) or OPENAI_API_KEY.\n' +
    'Get Gemini key: https://aistudio.google.com/apikey'
  );
}

// ─── Gemini ────────────────────────────────────────────────────────────────
let geminiClient: GoogleGenerativeAI | null = null;

function getGeminiClient(): GoogleGenerativeAI {
  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  }
  return geminiClient;
}

async function embedWithGemini(texts: string[]): Promise<Float32Array[]> {
  const client = getGeminiClient();
  const model = client.getGenerativeModel({ model: 'gemini-embedding-001' });
  const results: Float32Array[] = [];

  // Gemini doesn't support batch embed, process one by one
  for (const text of texts) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await model.embedContent({
          content: { role: 'user', parts: [{ text }] },
          taskType: 'RETRIEVAL_DOCUMENT' as any,
        });
        // gemini-embedding-001 returns 3072 dims by default; slice to 1536
        const values = result.embedding.values.slice(0, DIMENSIONS);
        results.push(new Float32Array(values));
        break;
      } catch (e: unknown) {
        if (attempt === MAX_RETRIES - 1) throw e;
        await sleep(exponentialDelay(attempt));
      }
    }
  }
  return results;
}

// ─── OpenAI ───────────────────────────────────────────────────────────────
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

async function embedWithOpenAI(texts: string[]): Promise<Float32Array[]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getOpenAIClient().embeddings.create({
        model: 'text-embedding-3-large',
        input: texts,
        dimensions: DIMENSIONS,
      });
      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => new Float32Array(d.embedding));
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;
      let delay = exponentialDelay(attempt);
      if (e instanceof OpenAI.APIError && e.status === 429) {
        const retryAfter = e.headers?.['retry-after'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) delay = parsed * 1000;
        }
      }
      await sleep(delay);
    }
  }
  throw new Error('OpenAI embedding failed after all retries');
}

// ─── Public API ───────────────────────────────────────────────────────────
export async function embed(text: string): Promise<Float32Array> {
  const truncated = text.slice(0, MAX_CHARS);
  const result = await embedBatch([truncated]);
  return result[0];
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const provider = getProvider();
  const results: Float32Array[] = [];

  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = provider === 'gemini'
      ? await embedWithGemini(batch)
      : await embedWithOpenAI(batch);
    results.push(...batchResults);
  }
  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function exponentialDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const EMBEDDING_MODEL = 'gemini-embedding-001 / text-embedding-3-large';
export const EMBEDDING_DIMENSIONS = DIMENSIONS;
