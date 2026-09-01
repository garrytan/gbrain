import type { Recipe } from '../types.ts';
import { probeOpenAICompat } from '../probes.ts';

/**
 * LM Studio's OpenAI-compatible local server. Exposes `/v1/embeddings` and
 * `/v1/models` on default port 1234 (distinct from Ollama's 11434 and
 * llama-server's 8080).
 *
 * The env mapping (`LMSTUDIO_BASE_URL` in build-gateway-config.ts) and the
 * probe (probes.ts `probeLMStudio`, surfaced under `local_probes` by
 * `gbrain providers explain --json`) already existed; without a recipe,
 * `lmstudio:` model strings never resolved, so `gbrain providers list` had no
 * row to select and the mapped base URL reached nothing. types.ts's probe
 * contract already named this recipe as future work.
 *
 * Complementary to the keyless `OPENAI_BASE_URL` route (#4385), which points
 * the whole native-openai path — embedding, chat and expansion — at a local
 * OpenAI-compatible server. This recipe is the other half: LM Studio as its
 * own provider id, with its own base URL, so `openai:` stays pointed at
 * OpenAI.
 *
 * Like llama-server, this recipe ships with `models: []` because the model
 * identity is whatever the user loaded in the LM Studio app. They MUST pass
 * `--embedding-model lmstudio:<id>` and `--embedding-dimensions <N>`. The
 * wizard refuses to pick implicit defaults.
 *
 * Scoped to the embedding touchpoint. LM Studio also serves chat; a chat
 * touchpoint is a reasonable follow-up but is not needed to make the
 * embedding path work.
 *
 * Operational note for users, not a gbrain defect: a loaded LM Studio
 * instance can degrade into a state where embedding latency rises by orders
 * of magnitude while the endpoint still answers — so it passes the
 * reachability probe above but misses the query-embed deadline
 * (hybrid.ts `QUERY_EMBED_TIMEOUT_MS`, default 6s) on every query. The query
 * still returns, keyword-only, stamped `embed_timeout` in `degraded[]` with a
 * once-per-process stderr warning (the visibility #3882 added), so recall
 * drops without going unannounced. Reloading the model in LM Studio restores
 * normal latency; slower local hardware can raise
 * GBRAIN_QUERY_EMBED_TIMEOUT_MS.
 *
 * Reference: https://lmstudio.ai/docs/app/api/endpoints/openai
 */
export const lmstudio: Recipe = {
  id: 'lmstudio',
  name: 'LM Studio (local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:1234/v1',
  auth_env: {
    required: [],
    optional: ['LMSTUDIO_BASE_URL', 'LMSTUDIO_API_KEY'],
    setup_url: 'https://lmstudio.ai',
  },
  touchpoints: {
    embedding: {
      models: [], // user-driven; whatever model is loaded in LM Studio
      user_provided_models: true,
      default_dims: 0, // forces explicit --embedding-dimensions
      trust_custom_dims: true, // #2271: user knows the loaded model's native dim
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-08-28',
      // LM Studio's batch capacity depends on the loaded model + app config;
      // no static cap to declare.
      no_batch_cap: true,
    },
  },
  /**
   * Probe via the OpenAI-compatible /v1/models endpoint. Caller passes the
   * resolved baseURL (from cfg.base_urls['lmstudio'] or env) so the probe
   * agrees with what the gateway will actually call. Falls back to
   * env / localhost:1234 when called without an argument.
   */
  async probe(baseURL?: string) {
    const url = baseURL ?? process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1';
    const result = await probeOpenAICompat(url);
    if (!result.reachable) {
      return {
        ready: false,
        hint: `LM Studio not reachable at ${url}. Open LM Studio, load an embedding model, and start the local server (default port 1234), or set LMSTUDIO_BASE_URL.`,
      };
    }
    if (!result.models_endpoint_valid) {
      return {
        ready: false,
        hint: `LM Studio reached but /v1/models returned an unexpected shape: ${result.error ?? 'unknown'}.`,
      };
    }
    return { ready: true };
  },
  setup_hint:
    'Install LM Studio (https://lmstudio.ai), load an embedding model, start the local server (default port 1234). Set --embedding-model lmstudio:<id> + --embedding-dimensions <N>.',
};
