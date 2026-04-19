/**
 * FORK: Shared retry utilities for embedding providers.
 * Extracted from openai-embedder.ts and gemini-embedder.ts to avoid duplication.
 */

export function exponentialDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
