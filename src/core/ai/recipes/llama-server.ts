import type { Recipe } from '../types.ts';
import { probeLlamaServer } from '../probes.ts';

/**
 * llama.cpp's `llama-server` (also published as `@llama.cpp/llama-server`).
 * It exposes OpenAI-compatible chat and embedding endpoints, depending on
 * how the server is launched. Distinct from Ollama: different default port
 * (8080), different model-management story (you launch it with
 * `--model <path>`; the server serves whatever model was passed).
 *
 * The embedding touchpoint ships with `models: []` because the model identity
 * is whatever the user launched llama-server with. Users MUST pass
 * `--embedding-model llama-server:<id>` and `--embedding-dimensions <N>`.
 * The chat touchpoint follows the same user-provided model identity. Its
 * prompt-cache capability reflects llama-server's default `--cache-prompt`
 * behavior; a deployment launched with `--no-cache-prompt` must not use this
 * recipe as a cache-capable subagent route.
 *
 * Reference: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 */
export const llamaServer: Recipe = {
  id: 'llama-server',
  name: 'llama.cpp llama-server (local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:8080/v1',
  auth_env: {
    required: [],
    optional: ['LLAMA_SERVER_BASE_URL', 'LLAMA_SERVER_API_KEY'],
    setup_url:
      'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
  },
  touchpoints: {
    embedding: {
      models: [], // user-driven; whatever model the server was launched with
      user_provided_models: true,
      default_dims: 0, // forces explicit --embedding-dimensions
      trust_custom_dims: true, // #2271: user knows the launched model's native dim
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-05-10',
      // llama-server enforces a hard request-COUNT cap equal to its launch
      // batch size (`--batch-size`, default 32): it rejects requests with
      // more inputs with `batch size N > maximum allowed batch size 32`.
      // The token-budget split can't bound item count, so cap it here. A
      // server launched with a larger `-b` can raise this. v0.32 (#779).
      max_batch_items: 32,
    },
    chat: {
      // The model id is the value supplied to llama-server's --alias flag.
      models: [],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: true,
      // The launched server's --ctx-size is deployment-specific. Keep the
      // recipe conservative and let the gateway's standard fallback apply.
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-08-11',
    },
  },
  /**
   * Probe via the OpenAI-compatible /v1/models endpoint. Caller passes the
   * resolved baseURL (from cfg.base_urls['llama-server'] or env), so the
   * probe agrees with what the gateway will actually call. Falls back to
   * env / localhost:8080 when called without an argument.
   */
  async probe(baseURL?: string) {
    const url = baseURL ?? process.env.LLAMA_SERVER_BASE_URL ?? 'http://localhost:8080/v1';
    const result = await probeLlamaServer(url);
    if (!result.reachable) {
      return {
        ready: false,
        hint: `llama-server not reachable at ${url}. Start it with \`llama-server --model <path> --alias <id> --jinja --cache-prompt\` (omit --embeddings for chat) or set LLAMA_SERVER_BASE_URL.`,
      };
    }
    if (!result.models_endpoint_valid) {
      return {
        ready: false,
        hint: `llama-server reached but /v1/models returned an unexpected shape: ${result.error ?? 'unknown'}.`,
      };
    }
    return { ready: true };
  },
  setup_hint:
    'Install/build llama.cpp, then `llama-server --model <gguf-path> --alias <id> --jinja --cache-prompt` for chat or add `--embeddings` for embeddings. Set LLAMA_SERVER_BASE_URL for a non-default port.',
};
