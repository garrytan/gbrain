import type { ResolvedColumn, SearchResult } from '../types.ts';

export interface MemoryCueSettings {
  generationEnabled: boolean;
  sourceIds: string[];
  readMode: 'off' | 'shadow' | 'on';
  pushEnabled: boolean;
  weight: number;
  minSimilarity: number | null;
  pushMinSimilarity: number | null;
  families: MemoryCueFamily[];
}

export const MEMORY_CUE_SOURCE_LIMIT = 1000;
export const MEMORY_CUE_FAMILIES = ['scene', 'horizon', 'bridge'] as const;
export type MemoryCueFamily = typeof MEMORY_CUE_FAMILIES[number];
export interface MemoryCueCandidate {
  result: SearchResult;
  evidence?: SearchResult[];
  cueId: string;
  family: MemoryCueFamily;
  similarity: number;
  cueText: string;
  generation: string;
}
export interface MemoryCueRecall {
  candidates: MemoryCueCandidate[];
  status: 'ready' | 'empty' | 'skipped' | 'degraded';
  reason?: string;
}
export interface MemoryCueBuildOptions {
  sourceIds: string[];
  pageLimit?: number;
  windowLimit?: number;
  includeBridge?: boolean;
}
export interface MemoryCueBuildReceipt {
  buildId: string;
  jobId: number;
  budgetOwnerJobId: number;
  status: string;
}
export interface MemoryCueProviders {
  generate(input: { evidence: string; includeBridge: boolean; model: string; signal?: AbortSignal }): Promise<{ output: unknown; actualUsd: number }>;
  embed(texts: string[], column: ResolvedColumn, signal?: AbortSignal): Promise<Float32Array[]>;
}
export interface CueOutput {
  family: MemoryCueFamily;
  relation: string;
  quote: string;
  quoteStart?: number;
  text: string;
}
export interface CueWindow {
  index: number;
  text: string;
  spans: Array<{ chunkId: number; text: string; start: number; separatorBefore: string }>;
}
export interface CueGroundingSpan {
  chunk_id: number;
  start: number;
  end: number;
  separator: string;
}
export const MAX_CUE_GROUNDING_CHUNKS = 3;
export const MAX_CUE_GROUNDING_SPANS = 4;
export const MEMORY_CUE_PROMPT_VERSION = 'situation-v5';
