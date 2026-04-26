/**
 * Embedding Service
 *
 * Supports OpenAI, OpenAI-compatible embedding APIs, and GitHub Copilot
 * Blackbird embeddings. Non-OpenAI providers can use different vector
 * dimensions, so existing pgvector columns may need migration before storing
 * or searching those embeddings.
 */

import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

export type EmbeddingProvider = 'openai' | 'openai-compatible' | 'copilot';

const OPENAI_MODEL = 'text-embedding-3-large';
const OPENAI_DIMENSIONS = 1536;
const COPILOT_MODEL = 'metis-1024-I16-Binary';
const COPILOT_DIMENSIONS = 1024;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const OPENAI_BATCH_SIZE = 100;
const OPENAI_COMPATIBLE_BATCH_SIZE = 100;
const COPILOT_BATCH_SIZE = 64;
const COPILOT_API_URL = 'https://api.github.com/embeddings';
const COPILOT_API_VERSION = '2025-05-01';

let openaiClient: OpenAI | null = null;

interface EmbeddingProviderConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  batchSize: number;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  const configured = process.env.GBRAIN_EMBEDDING_PROVIDER || process.env.EMBEDDING_PROVIDER;
  if (configured) {
    const provider = configured.toLowerCase();
    if (provider === 'copilot' || provider === 'github-copilot' || provider === 'blackbird') return 'copilot';
    if (provider === 'openai-compatible' || provider === 'openai_compatible' || provider === 'compatible' || provider === 'custom') {
      return 'openai-compatible';
    }
    return 'openai';
  }

  // Prefer Copilot automatically when OpenAI is not configured but the
  // GitHub Copilot CLI is already logged in.
  return !process.env.OPENAI_API_KEY && (process.env.GBRAIN_COPILOT_TOKEN || readCopilotCliToken())
    ? 'copilot'
    : 'openai';
}

export function getEmbeddingModel(): string {
  return getEmbeddingProviderConfig().model;
}

export function getEmbeddingDimensions(): number {
  return getEmbeddingProviderConfig().dimensions;
}

export const EMBEDDING_MODEL = getEmbeddingModel();
export const EMBEDDING_DIMENSIONS = getEmbeddingDimensions();

function getEmbeddingProviderConfig(): EmbeddingProviderConfig {
  const provider = getEmbeddingProvider();
  if (provider === 'copilot') {
    return {
      provider,
      model: process.env.GBRAIN_EMBEDDING_MODEL || process.env.GBRAIN_COPILOT_EMBEDDING_MODEL || COPILOT_MODEL,
      dimensions: parseDimensions(process.env.GBRAIN_EMBEDDING_DIMENSIONS, COPILOT_DIMENSIONS),
      batchSize: parseBatchSize(process.env.GBRAIN_EMBEDDING_BATCH_SIZE, COPILOT_BATCH_SIZE),
    };
  }

  if (provider === 'openai-compatible') {
    return {
      provider,
      model: process.env.GBRAIN_EMBEDDING_MODEL || OPENAI_MODEL,
      dimensions: parseDimensions(process.env.GBRAIN_EMBEDDING_DIMENSIONS, OPENAI_DIMENSIONS),
      batchSize: parseBatchSize(process.env.GBRAIN_EMBEDDING_BATCH_SIZE, OPENAI_COMPATIBLE_BATCH_SIZE),
    };
  }

  return {
    provider,
    model: process.env.GBRAIN_EMBEDDING_MODEL || process.env.GBRAIN_OPENAI_EMBEDDING_MODEL || OPENAI_MODEL,
    dimensions: parseDimensions(
      process.env.GBRAIN_EMBEDDING_DIMENSIONS || process.env.GBRAIN_OPENAI_EMBEDDING_DIMENSIONS,
      OPENAI_DIMENSIONS,
    ),
    batchSize: parseBatchSize(process.env.GBRAIN_EMBEDDING_BATCH_SIZE, OPENAI_BATCH_SIZE),
  };
}

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

export async function embed(text: string): Promise<Float32Array> {
  const truncated = text.slice(0, MAX_CHARS);
  const result = await embedBatch([truncated]);
  return result[0];
}

export interface EmbedBatchOptions {
  /**
   * Optional callback fired after each provider sub-batch completes.
   * CLI wrappers tick a reporter; Minion handlers can call
   * job.updateProgress here instead of hooking the per-page callback.
   */
  onBatchComplete?: (done: number, total: number) => void;
}

export async function embedBatch(
  texts: string[],
  options: EmbedBatchOptions = {},
): Promise<Float32Array[]> {
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];
  const { batchSize } = getEmbeddingProviderConfig();

  for (let i = 0; i < truncated.length; i += batchSize) {
    const batch = truncated.slice(i, i + batchSize);
    const batchResults = await embedBatchWithRetry(batch);
    results.push(...batchResults);
    options.onBatchComplete?.(results.length, truncated.length);
  }

  return results;
}

async function embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const config = getEmbeddingProviderConfig();
      if (config.provider === 'copilot') return await embedCopilotBatch(texts, config);
      if (config.provider === 'openai-compatible') return await embedOpenAICompatibleBatch(texts, config);
      return await embedOpenAIBatch(texts, config);
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;
      await sleep(getRetryDelay(e, attempt));
    }
  }

  throw new Error('Embedding failed after all retries');
}

async function embedOpenAIBatch(texts: string[], config: EmbeddingProviderConfig): Promise<Float32Array[]> {
  const response = await getOpenAIClient().embeddings.create({
    model: config.model,
    input: texts,
    dimensions: config.dimensions,
  });

  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => new Float32Array(d.embedding));
}

async function embedOpenAICompatibleBatch(texts: string[], config: EmbeddingProviderConfig): Promise<Float32Array[]> {
  const baseUrl = process.env.GBRAIN_EMBEDDING_BASE_URL || process.env.GBRAIN_OPENAI_COMPATIBLE_BASE_URL;
  if (!baseUrl) {
    throw new Error('OpenAI-compatible embedding provider requires GBRAIN_EMBEDDING_BASE_URL');
  }
  const apiKey = process.env.GBRAIN_EMBEDDING_API_KEY || process.env.GBRAIN_OPENAI_COMPATIBLE_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI-compatible embedding provider requires GBRAIN_EMBEDDING_API_KEY');
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'gbrain/0.9.2',
    },
    body: JSON.stringify({
      input: texts,
      model: config.model,
      dimensions: config.dimensions,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new EmbeddingRequestError(response.status, `OpenAI-compatible embeddings request failed: ${response.status} ${response.statusText}${body ? ` ${body}` : ''}`, response.headers.get('retry-after') || undefined);
  }

  const payload = await response.json() as { data?: { index?: number; embedding?: number[] }[] };
  if (!payload.data || payload.data.length !== texts.length) {
    throw new Error(`OpenAI-compatible embeddings response shape mismatch: expected ${texts.length}, got ${payload.data?.length ?? 0}`);
  }

  const sorted = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return sorted.map(item => {
    if (!item.embedding) throw new Error('OpenAI-compatible embeddings response missing embedding');
    return new Float32Array(item.embedding);
  });
}

async function embedCopilotBatch(texts: string[], config: EmbeddingProviderConfig): Promise<Float32Array[]> {
  const token = getCopilotToken();
  const response = await fetch(process.env.GBRAIN_COPILOT_EMBEDDING_URL || COPILOT_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-GitHub-Api-Version': COPILOT_API_VERSION,
      'X-GitHub-Request-ID': randomUUID(),
      'User-Agent': 'gbrain/0.9.2',
    },
    body: JSON.stringify({
      inputs: texts,
      model: config.model,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new EmbeddingRequestError(response.status, `Copilot embeddings request failed: ${response.status} ${response.statusText}${body ? ` ${body}` : ''}`, response.headers.get('retry-after') || undefined);
  }

  const payload = await response.json() as { embeddings?: { embedding?: number[] }[] };
  if (!payload.embeddings || payload.embeddings.length !== texts.length) {
    throw new Error(`Copilot embeddings response shape mismatch: expected ${texts.length}, got ${payload.embeddings?.length ?? 0}`);
  }

  return payload.embeddings.map(item => {
    if (!item.embedding) throw new Error('Copilot embeddings response missing embedding');
    return normalize(new Float32Array(item.embedding));
  });
}

function getCopilotToken(): string {
  const envToken = process.env.GBRAIN_COPILOT_TOKEN || process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (envToken) return envToken;

  const configToken = readCopilotCliToken();
  if (configToken) return configToken;

  throw new Error('Copilot embedding provider requires GBRAIN_COPILOT_TOKEN or a logged-in ~/.copilot/config.json');
}

function readCopilotCliToken(): string | null {
  try {
    const raw = readFileSync(join(homedir(), '.copilot', 'config.json'), 'utf-8');
    const withoutComments = raw.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    const config = JSON.parse(withoutComments) as { lastLoggedInUser?: { host?: string; login?: string }; copilotTokens?: Record<string, string> };
    const host = config.lastLoggedInUser?.host;
    const login = config.lastLoggedInUser?.login;
    if (host && login) {
      const preferred = config.copilotTokens?.[`${host}:${login}`];
      if (preferred) return preferred;
    }
    return Object.values(config.copilotTokens || {})[0] || null;
  } catch {
    return null;
  }
}

function getRetryDelay(e: unknown, attempt: number): number {
  let delay = exponentialDelay(attempt);

  if (e instanceof OpenAI.APIError && e.status === 429) {
    const retryAfter = e.headers?.['retry-after'];
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed)) delay = parsed * 1000;
    }
  }

  if (e instanceof EmbeddingRequestError && e.retryAfter) {
    const parsed = parseInt(e.retryAfter, 10);
    if (!isNaN(parsed)) delay = parsed * 1000;
  }

  return delay;
}

function parseDimensions(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid embedding dimensions: ${value}`);
  }
  return parsed;
}

function parseBatchSize(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid embedding batch size: ${value}`);
  }
  return parsed;
}

function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  }
  return vector;
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class EmbeddingRequestError extends Error {
  constructor(public status: number, message: string, public retryAfter?: string) {
    super(message);
    this.name = 'EmbeddingRequestError';
  }
}

/**
 * v0.20.0 Cathedral II Layer 8 (D1): USD cost per 1k tokens for
 * text-embedding-3-large. Used by `gbrain sync --all` cost preview and
 * the reindex-code backfill command to surface expected spend before
 * the agent/user accepts an expensive operation.
 *
 * Value: $0.00013 / 1k tokens as of 2026. Update when OpenAI changes
 * pricing. Single source of truth — every cost-preview surface reads
 * this constant, so a pricing change is a one-line edit.
 */
export const EMBEDDING_COST_PER_1K_TOKENS = 0.00013;

/** Compute USD cost estimate for embedding `tokens` at current model rate. */
export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * EMBEDDING_COST_PER_1K_TOKENS;
}
