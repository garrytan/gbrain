/**
 * Versioned search-contract pinning.
 *
 * A search contract names the embedding space and the retrieval behavior that
 * make persisted vectors and cached results compatible. The pin is opt-in and
 * lives in the DB config plane at `search.contract.v1`. Once pinned, ordinary
 * runtime entrypoints fail closed when their resolved contract drifts. Recovery
 * and deliberate migrations bypass the startup assertion and use the helpers
 * in this module to report or replace the pin explicitly.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { ResolvedColumn } from '../types.ts';
import { loadConfig, loadConfigWithEngine } from '../config.ts';
import { getEmbeddingModel, getEmbeddingDimensions } from '../ai/gateway.ts';
import { resolveEmbeddingColumn } from './embedding-column.ts';
import {
  loadSearchModeConfig,
  resolveSearchMode,
  type ResolvedSearchKnobs,
} from './mode.ts';

export const SEARCH_CONTRACT_V1_KEY = 'search.contract.v1';
export const SEARCH_CONTRACT_VERSION = 1 as const;

export type EmbeddingInputSemantics =
  | 'symmetric'
  | 'query_document'
  | 'query_passage';

export interface SearchContractV1 {
  version: 1;
  embedding: {
    model: string;
    dimensions: number;
    column: string;
    representation: 'vector' | 'halfvec';
    metric: 'cosine';
    input_semantics: EmbeddingInputSemantics;
  };
  retrieval: {
    mode: string;
    contextual_retrieval: string;
    contextual_retrieval_disabled: boolean;
  };
  reranker: {
    enabled: boolean;
    model: string;
    top_n_in: number;
    top_n_out: number | null;
    timeout_ms: number;
    failure_policy: 'fail_open';
    autocut: boolean;
    autocut_jump: number;
  };
}

export interface SearchContractCheck {
  status: 'unpinned' | 'match' | 'drift' | 'invalid';
  current: SearchContractV1;
  pinned: SearchContractV1 | null;
  current_fingerprint: string;
  pinned_fingerprint: string | null;
  differences: string[];
  error?: string;
}

/**
 * The provider/model side of the retrieval space. This mirrors the input-type
 * routing implemented in ai/dims.ts and gateway compatibility shims.
 */
export function embeddingInputSemantics(model: string): EmbeddingInputSemantics {
  const normalized = model.toLowerCase();
  if (normalized.startsWith('zeroentropyai:zembed-1')) return 'query_document';
  if (normalized.startsWith('voyage:')) return 'query_document';
  if (normalized.startsWith('minimax:embo-01')) return 'query_document';
  if (normalized.startsWith('nvidia:')) return 'query_passage';
  return 'symmetric';
}

export function buildSearchContractV1(
  column: ResolvedColumn,
  knobs: ResolvedSearchKnobs,
  embeddingModel = column.embeddingModel,
  embeddingDimensions = column.dimensions,
): SearchContractV1 {
  return {
    version: SEARCH_CONTRACT_VERSION,
    embedding: {
      model: embeddingModel,
      dimensions: embeddingDimensions,
      column: column.name,
      representation: column.type,
      metric: 'cosine',
      input_semantics: embeddingInputSemantics(embeddingModel),
    },
    retrieval: {
      mode: knobs.resolved_mode,
      contextual_retrieval: knobs.contextual_retrieval,
      contextual_retrieval_disabled: knobs.contextual_retrieval_disabled,
    },
    reranker: {
      enabled: knobs.reranker_enabled,
      model: knobs.reranker_model,
      top_n_in: knobs.reranker_top_n_in,
      top_n_out: knobs.reranker_top_n_out,
      timeout_ms: knobs.reranker_timeout_ms,
      failure_policy: 'fail_open',
      autocut: knobs.autocut,
      autocut_jump: knobs.autocut_jump,
    },
  };
}

export function serializeSearchContractV1(contract: SearchContractV1): string {
  // The builder and parser both produce this fixed field order. Avoid a generic
  // recursive sorter: the schema itself owns canonicalization.
  return JSON.stringify(contract);
}

export function searchContractFingerprint(contract: SearchContractV1): string {
  return createHash('sha256')
    .update(serializeSearchContractV1(contract))
    .digest('hex')
    .slice(0, 16);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseSearchContractV1(raw: string): SearchContractV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = requireObject(parsed, 'contract');
  const embedding = requireObject(root.embedding, 'embedding');
  const retrieval = requireObject(root.retrieval, 'retrieval');
  const reranker = requireObject(root.reranker, 'reranker');

  if (root.version !== SEARCH_CONTRACT_VERSION) {
    throw new Error(`unsupported version ${String(root.version)} (expected 1)`);
  }
  if (typeof embedding.model !== 'string' || !embedding.model.includes(':')) {
    throw new Error('embedding.model must be a provider:model string');
  }
  if (!Number.isInteger(embedding.dimensions) || (embedding.dimensions as number) <= 0) {
    throw new Error('embedding.dimensions must be a positive integer');
  }
  if (typeof embedding.column !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(embedding.column)) {
    throw new Error('embedding.column must be a lowercase SQL identifier');
  }
  if (embedding.representation !== 'vector' && embedding.representation !== 'halfvec') {
    throw new Error('embedding.representation must be vector or halfvec');
  }
  if (embedding.metric !== 'cosine') throw new Error('embedding.metric must be cosine');
  if (!['symmetric', 'query_document', 'query_passage'].includes(String(embedding.input_semantics))) {
    throw new Error('embedding.input_semantics is invalid');
  }
  if (typeof retrieval.mode !== 'string' || typeof retrieval.contextual_retrieval !== 'string' ||
      typeof retrieval.contextual_retrieval_disabled !== 'boolean') {
    throw new Error('retrieval fields are invalid');
  }
  if (typeof reranker.enabled !== 'boolean' || typeof reranker.model !== 'string' ||
      !Number.isInteger(reranker.top_n_in) || (reranker.top_n_in as number) <= 0 ||
      !(reranker.top_n_out === null ||
        (Number.isInteger(reranker.top_n_out) && (reranker.top_n_out as number) > 0)) ||
      !Number.isInteger(reranker.timeout_ms) || (reranker.timeout_ms as number) <= 0 ||
      reranker.failure_policy !== 'fail_open' ||
      typeof reranker.autocut !== 'boolean' || typeof reranker.autocut_jump !== 'number' ||
      !Number.isFinite(reranker.autocut_jump) || reranker.autocut_jump < 0 || reranker.autocut_jump > 1) {
    throw new Error('reranker fields are invalid');
  }

  return parsed as SearchContractV1;
}

export function diffSearchContracts(
  pinned: SearchContractV1,
  current: SearchContractV1,
): string[] {
  const differences: string[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
      for (const key of [...keys].sort()) {
        walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (!Object.is(a, b)) differences.push(`${path}: pinned=${JSON.stringify(a)} current=${JSON.stringify(b)}`);
  };
  walk(pinned, current, '');
  return differences;
}

export async function resolveSearchContractV1(engine: BrainEngine): Promise<SearchContractV1> {
  const merged = await loadConfigWithEngine(engine, loadConfig());
  const cfg = merged ?? ({ engine: engine.kind } as const);
  const column = resolveEmbeddingColumn(undefined, cfg);
  const knobs = resolveSearchMode(await loadSearchModeConfig(engine));

  // Gateway resolution is the write/query truth for the builtin embedding
  // column. A named alternate column carries its own provider + dimensions.
  const model = column.name === 'embedding' ? getEmbeddingModel() : column.embeddingModel;
  const dimensions = column.name === 'embedding' ? getEmbeddingDimensions() : column.dimensions;
  return buildSearchContractV1(column, knobs, model, dimensions);
}

export async function checkSearchContractV1(engine: BrainEngine): Promise<SearchContractCheck> {
  const current = await resolveSearchContractV1(engine);
  const currentFingerprint = searchContractFingerprint(current);
  const raw = await engine.getConfig(SEARCH_CONTRACT_V1_KEY);
  if (!raw) {
    return {
      status: 'unpinned', current, pinned: null,
      current_fingerprint: currentFingerprint, pinned_fingerprint: null,
      differences: [],
    };
  }
  let pinned: SearchContractV1;
  try {
    pinned = parseSearchContractV1(raw);
  } catch (error) {
    return {
      status: 'invalid', current, pinned: null,
      current_fingerprint: currentFingerprint, pinned_fingerprint: null,
      differences: [], error: error instanceof Error ? error.message : String(error),
    };
  }
  const differences = diffSearchContracts(pinned, current);
  return {
    status: differences.length === 0 ? 'match' : 'drift',
    current,
    pinned,
    current_fingerprint: currentFingerprint,
    pinned_fingerprint: searchContractFingerprint(pinned),
    differences,
  };
}

export class SearchContractDriftError extends Error {
  readonly code = 'search_contract_drift';
  readonly check: SearchContractCheck;

  constructor(check: SearchContractCheck) {
    const detail = check.status === 'invalid'
      ? `Pinned contract is invalid: ${check.error}`
      : `Resolved search behavior differs from the pinned contract:\n  ${check.differences.join('\n  ')}`;
    super(
      `GBrain Search Contract v1 drift detected. ${detail}\n` +
      'Refusing to mix embedding/search spaces. Inspect with `gbrain search contract check`.\n' +
      'For a deliberate model migration, use `gbrain migrate embeddings`; then re-pin explicitly.',
    );
    this.name = 'SearchContractDriftError';
    this.check = check;
  }
}

export async function assertSearchContractV1(engine: BrainEngine): Promise<void> {
  const check = await checkSearchContractV1(engine);
  if (check.status === 'drift' || check.status === 'invalid') {
    throw new SearchContractDriftError(check);
  }
}
