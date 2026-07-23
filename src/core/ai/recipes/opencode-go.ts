import type { Recipe } from '../types.ts';

/**
 * Reasoning models (qwen3.5-plus, deepseek-v4-pro) return chain-of-thought
 * in a separate `reasoning_content` field, leaving `content` empty on
 * pure-reasoning turns. The AI SDK's openai-compatible adapter reads only
 * `content`, so the model appears to answer with nothing. This transport
 * shim promotes `reasoning_content` into `content` when `content` is empty,
 * before the adapter parses the body. Fail-open: any error returns the
 * original response.
 *
 * Non-streaming JSON chat completions only.
 */
// Cast through `unknown` because TS's `typeof fetch` includes a `preconnect`
// member the arrow function does not implement.
export const reasoningContentCompatFetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const res = await fetch(input as any, init as any);
  try {
    if (!res.ok) return res;
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('application/json')) return res;
    const json = await res.clone().json();
    const choices = Array.isArray(json?.choices) ? json.choices : [];
    let modified = false;
    for (const choice of choices) {
      const msg = choice?.message;
      if (!msg) continue;
      // A tool-call turn legitimately carries content:null — the answer is the
      // tool call, not text. Only promote on a terminal text turn.
      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      const content = msg.content;
      const reasoning = msg.reasoning_content;
      const contentEmpty = content == null || (typeof content === 'string' && content.trim() === '');
      if (!hasToolCalls && contentEmpty && typeof reasoning === 'string' && reasoning.trim() !== '') {
        msg.content = reasoning;
        modified = true;
      }
    }
    if (!modified) return res;
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(JSON.stringify(json), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } catch {
    return res;
  }
}) as unknown as typeof fetch;

/**
 * OpenCode Go — low-cost subscription ($10/mo) providing curated open models
 * via an OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Full model catalog: https://opencode.ai/zen/go/v1/models
 * API key: OPENCODE_GO_API_KEY — subscribe at https://opencode.ai/auth
 * Endpoint docs: https://opencode.ai/docs/go/
 */
export const opencodeGo: Recipe = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://opencode.ai/zen/go/v1',
  auth_env: {
    required: ['OPENCODE_GO_API_KEY'],
    setup_url: 'https://opencode.ai/auth',
  },
  touchpoints: {
    chat: {
      models: [
        'deepseek-v4-flash',
        'deepseek-v4-pro',
        'glm-5',
        'glm-5.1',
        'glm-5.2',
        'grok-4.5',
        'kimi-k2.5',
        'kimi-k2.6',
        'kimi-k2.7-code',
        'kimi-k3',
        'minimax-m2.5',
        'minimax-m2.7',
        'minimax-m3',
        'mimo-v2-omni',
        'mimo-v2-pro',
        'mimo-v2.5',
        'mimo-v2.5-pro',
        'qwen3.5-plus',
        'qwen3.6-plus',
        'qwen3.7-max',
        'qwen3.7-plus',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 200_000,
      // Pricing: deepseek-v4-flash baseline (cheapest; other models vary)
      cost_per_1m_input_usd: 0.14,
      cost_per_1m_output_usd: 0.28,
      price_last_verified: '2026-07-17',
    },
  },
  compat: { fetch: reasoningContentCompatFetch },
  setup_hint:
    'Subscribe at https://opencode.ai/auth ($5 first month, $10/mo after), then `export OPENCODE_GO_API_KEY=...`. Use `opencode-go:<model-id>` strings (e.g. opencode-go:deepseek-v4-pro).',
};
