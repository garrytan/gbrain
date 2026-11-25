/**
 * The skill resolver's embedding calls (vectors.ts), made over plain HTTPS to
 * the brain's own embedding provider: Voyage, OpenAI or Google. Like the
 * picker's chat call (router-http.ts) it loads no AI gateway and no SDK, so
 * the hook lane's worker and the library bundle stay engine-free.
 *
 * The embedder is the brain's: `embedding_model` ("<provider>:<model>") and
 * `embedding_dimensions` from `<home>/config.json`, unless
 * `embedding_disabled` is true. Its key comes from the environment, else
 * from config.json (voyage_api_key, openai_api_key, google_api_key, with the
 * GEMINI_API_KEY alias; the canonical fold is src/core/ai/provider-env.ts).
 * OPENAI_BASE_URL and GOOGLE_GENERATIVE_AI_BASE_URL, then config.json
 * provider_base_urls.<provider>, point a provider at a proxy. Any other
 * provider has no vectors (EMBED_SKIP_CODES unsupported_provider).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const EMBED_PROVIDERS = ['voyage', 'openai', 'google'] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];
/** Why a catalog or a turn has no vectors. */
export const EMBED_SKIP_CODES = ['no_embedder', 'embedding_disabled', 'unsupported_provider', 'missing_key', 'provider_error', 'timeout', 'bad_reply', 'not_this_harness', 'project_scope', 'too_many_skills', 'stale_vectors', 'not_needed', 'unmeasured_model'] as const;
export type EmbedSkipCode = (typeof EMBED_SKIP_CODES)[number];
export type InputType = 'query' | 'document';

/** The brain's embedder as config.json names it: model is "<provider>:<id>"; dims is embedding_dimensions when set. */
export interface Embedder { provider: EmbedProvider; id: string; model: string; dims: number | null; baseUrl: string | null }
export interface EmbedRequest { provider: EmbedProvider; id: string; dims: number | null; texts: string[]; inputType: InputType; signal: AbortSignal; baseUrl: string | null }

let testTransport: ((req: EmbedRequest) => Promise<number[][]>) | null = null;
/** Tests only: answer every embedding call with `fn` (null restores the network). */
export function __setEmbedTransportForTests(fn: ((req: EmbedRequest) => Promise<number[][]>) | null): void { testTransport = fn; }

const CONFIG_CAP_BYTES = 1024 * 1024;
const KEY: Record<EmbedProvider, [string, string]> = {
  voyage: ['voyage_api_key', 'VOYAGE_API_KEY'],
  openai: ['openai_api_key', 'OPENAI_API_KEY'],
  google: ['google_api_key', 'GOOGLE_GENERATIVE_AI_API_KEY'],
};
const BASE_URL_ENV: Partial<Record<EmbedProvider, string>> = { openai: 'OPENAI_BASE_URL', google: 'GOOGLE_GENERATIVE_AI_BASE_URL' };
const DEFAULT_BASE: Record<EmbedProvider, string> = { voyage: 'https://api.voyageai.com', openai: 'https://api.openai.com', google: 'https://generativelanguage.googleapis.com' };

function readConfig(home: string): Record<string, unknown> | null {
  try {
    const text = readFileSync(join(home, 'config.json'), 'utf8');
    if (text.length > CONFIG_CAP_BYTES) return null;
    const j = JSON.parse(text) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : null;
  } catch { return null; } // silent-read-ok: no readable config.json means no embedder; the build and the turn report no_embedder
}

/** The brain's embedder, or why there is none. Reads config.json only. */
export function readEmbedder(home: string, env: NodeJS.ProcessEnv): Embedder | { skip: EmbedSkipCode } {
  const cfg = readConfig(home);
  const model = typeof cfg?.embedding_model === 'string' ? cfg.embedding_model.trim() : '';
  if (!cfg || !model) return { skip: 'no_embedder' };
  if (cfg.embedding_disabled === true) return { skip: 'embedding_disabled' };
  const at = model.indexOf(':');
  const provider = model.slice(0, at).toLowerCase();
  const id = model.slice(at + 1);
  if (at < 1 || !id || !(EMBED_PROVIDERS as readonly string[]).includes(provider)) return { skip: 'unsupported_provider' };
  const p = provider as EmbedProvider;
  const dims = Number.isInteger(cfg.embedding_dimensions) && (cfg.embedding_dimensions as number) > 0 ? cfg.embedding_dimensions as number : null;
  const urls = cfg.provider_base_urls && typeof cfg.provider_base_urls === 'object' ? cfg.provider_base_urls as Record<string, unknown> : {};
  const envName = BASE_URL_ENV[p];
  const fromEnv = envName ? env[envName] : undefined;
  const baseUrl = fromEnv || (typeof urls[p] === 'string' && urls[p] ? urls[p] as string : null);
  return { provider: p, id, model: `${p}:${id}`, dims, baseUrl };
}

/** The key for the embedder's provider, or null when none is configured. */
export function embedKey(provider: EmbedProvider, home: string, env: NodeJS.ProcessEnv): string | null {
  if (testTransport) return 'test';
  const [configKey, name] = KEY[provider];
  const fromEnv = env[name] || (provider === 'google' ? env.GEMINI_API_KEY : undefined);
  if (fromEnv) return fromEnv;
  const v = readConfig(home)?.[configKey];
  return typeof v === 'string' && v ? v : null;
}

/** A provider's HTTP error answer, with its status. */
export class EmbedHttpError extends Error {
  constructor(readonly status: number) { super(`embedding provider answered HTTP ${status}`); }
}

const VOYAGE_DIMS = new Set([256, 512, 1024, 2048]);
const VOYAGE_FLEX = /^voyage-(4|4-large|4-lite|code-4|3-large|3\.5|3\.5-lite|code-3)$/;
const OPENAI_FLEX = /^text-embedding-3-(small|large)$/;

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Record<string, any>> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal, redirect: 'error' });
  if (!res.ok) throw new EmbedHttpError(res.status);
  return await res.json() as Record<string, any>;
}

const root = (baseUrl: string | null, provider: EmbedProvider) => (baseUrl || DEFAULT_BASE[provider]).replace(/\/+$/, '').replace(/\/v1(beta)?$/, '');

/** One embedding call: one vector per text, in order. Throws on a network or HTTP error, an abort, or a reply without one vector per text. */
export async function embedTexts(req: EmbedRequest, key: string): Promise<number[][]> {
  const vectors = testTransport ? await testTransport(req) : await embedOverHttp(req, key);
  if (!Array.isArray(vectors) || vectors.length !== req.texts.length || vectors.some(v => !Array.isArray(v) || v.length === 0 || v.length !== vectors[0]!.length || v.some(x => typeof x !== 'number' || !Number.isFinite(x)))) throw new Error('bad_reply');
  return vectors;
}

/** The provider call itself, without the test transport. */
export async function embedOverHttp(req: EmbedRequest, key: string): Promise<number[][]> {
  const base = root(req.baseUrl, req.provider);
  if (req.provider === 'voyage') {
    const j = await post(`${base}/v1/embeddings`, { authorization: `Bearer ${key}` }, {
      model: req.id, input: req.texts, input_type: req.inputType,
      ...(req.dims && VOYAGE_FLEX.test(req.id) && VOYAGE_DIMS.has(req.dims) ? { output_dimension: req.dims } : {}),
    }, req.signal);
    return ((j.data ?? []) as any[]).slice().sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)).map(d => d?.embedding);
  }
  if (req.provider === 'openai') {
    const j = await post(`${base}/v1/embeddings`, { authorization: `Bearer ${key}` }, {
      model: req.id, input: req.texts, ...(req.dims && OPENAI_FLEX.test(req.id) ? { dimensions: req.dims } : {}),
    }, req.signal);
    return ((j.data ?? []) as any[]).slice().sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)).map(d => d?.embedding);
  }
  const model = encodeURIComponent(req.id);
  const j = await post(`${base}/v1beta/models/${model}:batchEmbedContents`, { 'x-goog-api-key': key }, {
    requests: req.texts.map(text => ({
      model: `models/${req.id}`, content: { parts: [{ text }] }, taskType: req.inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
      ...(req.dims ? { outputDimensionality: req.dims } : {}),
    })),
  }, req.signal);
  return ((j.embeddings ?? []) as any[]).map(e => e?.values);
}
