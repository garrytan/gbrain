import { join } from 'path';
import type { GBrainConfig, GBrainConfigInput, QueryRewriteProvider } from './config.ts';
import { configDir } from './config.ts';
import { resolveEmbeddingProvider, type EmbeddingProviderCapability } from './embedding/provider.ts';

const DEFAULT_LOCAL_REWRITE_MODEL = 'qwen2.5:3b';
const MAX_QUERIES = 3;
const MIN_WORDS = 3;
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'into', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'what', 'when', 'where', 'which', 'who',
  'why', 'with', 'can', 'should', 'could', 'would', 'find', 'show', 'tell', 'explain',
]);

export interface OfflineCapabilityStatus {
  supported: boolean;
  reason?: string;
}

export interface QueryRewriteCapability {
  mode: QueryRewriteProvider;
  available: boolean;
  implementation: 'none' | 'heuristic' | 'local-http';
  model: string | null;
  reason?: string;
}

export interface ResolvedQueryRewritePolicy {
  capability: QueryRewriteCapability;
  expand(query: string): Promise<string[]>;
}

export interface OfflineProfile {
  status: 'standard' | 'local_offline';
  offline: boolean;
  engine: { type: GBrainConfig['engine'] };
  embedding: EmbeddingProviderCapability;
  rewrite: QueryRewriteCapability;
  capabilities: {
    check_update: OfflineCapabilityStatus;
    files: OfflineCapabilityStatus;
  };
}

interface LocalRewriteRuntime {
  url: string;
  model: string;
  kind: 'ollama-generate' | 'json-http';
}

export function createLocalProfileConfig(databasePath?: string): GBrainConfigInput {
  return {
    engine: 'sqlite',
    database_path: databasePath ?? defaultLocalDatabasePath(),
    offline: true,
    embedding_provider: 'local',
    query_rewrite_provider: 'heuristic',
  };
}

export function defaultLocalDatabasePath(): string {
  return join(configDir(), 'brain.db');
}

export function isOfflineProfile(config?: GBrainConfig | null): boolean {
  return config?.engine === 'sqlite' && config.offline === true;
}

export function resolveOfflineProfile(config: GBrainConfig): OfflineProfile {
  const offline = isOfflineProfile(config);
  const embedding = resolveEmbeddingProvider({ config }).capability;
  const rewrite = resolveQueryRewritePolicy(config).capability;

  return {
    status: offline ? 'local_offline' : 'standard',
    offline,
    engine: { type: config.engine },
    embedding,
    rewrite,
    capabilities: {
      check_update: offline
        ? unsupportedCapability('check-update is disabled in the local/offline profile.')
        : supportedCapability(),
      files: offline
        ? unsupportedCapability('files/storage commands require Postgres raw database access and are not supported in sqlite/local mode.')
        : supportedCapability(),
    },
  };
}

export function getUnsupportedCapabilityReason(
  config: GBrainConfig,
  capability: keyof OfflineProfile['capabilities'],
): string | null {
  const profile = resolveOfflineProfile(config);
  const status = profile.capabilities[capability];
  return status.supported ? null : (status.reason || `${capability} is unsupported in the current profile.`);
}

export function resolveQueryRewritePolicy(config?: GBrainConfig | null): ResolvedQueryRewritePolicy {
  const mode: QueryRewriteProvider = config?.query_rewrite_provider ?? 'none';

  switch (mode) {
    case 'heuristic':
      return {
        capability: {
          mode,
          available: true,
          implementation: 'heuristic',
          model: null,
        },
        expand: async (query: string) => heuristicExpandQuery(query),
      };
    case 'local_llm': {
      const runtime = resolveLocalRewriteRuntime();
      if (!runtime) {
        return unavailableRewritePolicy(
          mode,
          'Local query rewrite runtime is not configured. Set GBRAIN_LOCAL_LLM_URL or OLLAMA_HOST.',
        );
      }

      return {
        capability: {
          mode,
          available: true,
          implementation: 'local-http',
          model: runtime.model,
        },
        expand: async (query: string) => localLlmExpandQuery(query, runtime),
      };
    }
    case 'none':
    default:
      return unavailableRewritePolicy(mode, 'Query rewrite is disabled (query_rewrite_provider="none").');
  }
}

function unavailableRewritePolicy(mode: QueryRewriteProvider, reason: string): ResolvedQueryRewritePolicy {
  return {
    capability: {
      mode,
      available: false,
      implementation: 'none',
      model: null,
      reason,
    },
    expand: async (query: string) => [normalizeWhitespace(query)],
  };
}

function supportedCapability(): OfflineCapabilityStatus {
  return { supported: true };
}

function unsupportedCapability(reason: string): OfflineCapabilityStatus {
  return { supported: false, reason };
}

function heuristicExpandQuery(query: string): string[] {
  const normalized = normalizeWhitespace(query);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS) return [normalized];

  const terms = words.map(cleanToken).filter(Boolean);
  const stripped = terms.filter(term => !STOPWORDS.has(term));
  const alternatives: string[] = [];

  if (stripped.length >= 2) {
    alternatives.push(stripped.join(' '));
  }

  if (stripped.length >= 3) {
    alternatives.push(stripped.slice(0, 3).join(' '));
  } else if (terms.length >= 2) {
    alternatives.push(terms.join(' '));
  }

  return dedupeQueries([normalized, ...alternatives]).slice(0, MAX_QUERIES);
}

async function localLlmExpandQuery(query: string, runtime: LocalRewriteRuntime): Promise<string[]> {
  const normalized = normalizeWhitespace(query);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS) return [normalized];

  let alternatives: string[] = [];

  if (runtime.kind === 'ollama-generate') {
    const response = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: runtime.model,
        stream: false,
        format: 'json',
        prompt: buildRewritePrompt(normalized),
      }),
    });

    if (!response.ok) {
      throw new Error(`Local query rewrite runtime returned ${response.status} ${response.statusText}`);
    }

    const payload = await response.json() as { response?: string };
    alternatives = extractAlternativeQueries(payload.response ?? '');
  } else {
    const response = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: runtime.model,
        input: buildRewritePrompt(normalized),
      }),
    });

    if (!response.ok) {
      throw new Error(`Local query rewrite runtime returned ${response.status} ${response.statusText}`);
    }

    const payload = await response.json() as {
      alternatives?: string[];
      queries?: string[];
      output?: string;
    };

    alternatives = Array.isArray(payload.alternatives)
      ? payload.alternatives.map(String)
      : Array.isArray(payload.queries)
        ? payload.queries.map(String)
        : extractAlternativeQueries(payload.output ?? '');
  }

  return dedupeQueries([normalized, ...alternatives]).slice(0, MAX_QUERIES);
}

function resolveLocalRewriteRuntime(): LocalRewriteRuntime | null {
  const configuredUrl = process.env.GBRAIN_LOCAL_LLM_URL;
  const model = process.env.GBRAIN_LOCAL_LLM_MODEL || DEFAULT_LOCAL_REWRITE_MODEL;

  if (configuredUrl) {
    return {
      url: configuredUrl,
      model,
      kind: 'json-http',
    };
  }

  if (process.env.OLLAMA_HOST || process.env.GBRAIN_LOCAL_LLM_MODEL) {
    const host = withTrailingSlash(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
    return {
      url: new URL('/api/generate', host).toString(),
      model,
      kind: 'ollama-generate',
    };
  }

  return null;
}

function buildRewritePrompt(query: string): string {
  return [
    'Return JSON with an "alternatives" array containing exactly 2 alternative search queries.',
    'Keep them concise, semantically close, and suitable for retrieval.',
    `Original query: ${query}`,
  ].join('\n');
}

function extractAlternativeQueries(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as { alternatives?: unknown; queries?: unknown };
    if (Array.isArray(parsed.alternatives)) {
      return parsed.alternatives.map(String);
    }
    if (Array.isArray(parsed.queries)) {
      return parsed.queries.map(String);
    }
  } catch {
    // Fall through to line parsing.
  }

  return raw
    .split(/\n+/)
    .map(line => line.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_QUERIES - 1);
}

function dedupeQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const query of queries) {
    const normalized = normalizeWhitespace(query);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped;
}

function cleanToken(token: string): string {
  return token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
