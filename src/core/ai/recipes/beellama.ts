import type { Recipe } from '../types.ts';

/**
 * Beellama — self-hosted llama.cpp serving Qwen3.6-27B-Q5_K_S on Unraid.
 *
 * Two deployment modes, both controlled by env (no hard-coded hostnames):
 *
 *   1) LAN-direct  — gbrain shares a network with the Unraid host.
 *      BEELLAMA_BASE_URL=http://192.168.x.x:8060/v1
 *      No CF-Access env vars; resolveDefaultHeaders returns {}.
 *
 *   2) Tunneled    — gbrain runs on a VPS / remote machine and reaches beellama
 *      via Cloudflare Tunnel + Access service token.
 *      BEELLAMA_BASE_URL=https://<your-tunnel-host>/v1
 *      BEELLAMA_CF_ACCESS_CLIENT_ID=<service-token-client-id>
 *      BEELLAMA_CF_ACCESS_CLIENT_SECRET=<service-token-client-secret>
 *
 * The beellama llama.cpp server has no bearer auth of its own (`--api-key`
 * unset), so Authorization is a dummy `Bearer no-auth-required` that the upstream
 * ignores; real authn (when needed) is the CF-Access header pair injected by
 * resolveDefaultHeaders.
 *
 * Chat usage: `gbrain config set chat_model beellama:Qwen3.6-27B-Q5_K_S.gguf`.
 *
 * Capability notes:
 *   - supports_tools: true — beellama emits well-formed OpenAI tool_calls.
 *   - supports_subagent_loop: false — Qwen3.6 tool-call stability across long
 *     subagent replays is not yet verified end-to-end with gbrain's Minions.
 *     Flip to true after you've pinned it with a subagent-gateway-path E2E.
 */
export const beellama: Recipe = {
  id: 'beellama',
  name: 'Beellama (self-hosted llama.cpp / Qwen3.6-27B)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  // No base_url_default on purpose: the URL is deployment-specific (LAN IP vs
  // tunnel hostname) and the user MUST set BEELLAMA_BASE_URL. resolveAuth
  // throws AIConfigError when the URL is missing.
  auth_env: {
    required: ['BEELLAMA_BASE_URL'],
    optional: [
      'BEELLAMA_CF_ACCESS_CLIENT_ID',
      'BEELLAMA_CF_ACCESS_CLIENT_SECRET',
    ],
  },
  touchpoints: {
    chat: {
      models: ['Qwen3.6-27B-Q5_K_S.gguf'],
      supports_tools: true,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 32768,
      // Self-hosted: electricity, not tokens.
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-06-12',
    },
  },
  resolveOpenAICompatConfig(env) {
    const baseURL = env.BEELLAMA_BASE_URL;
    if (!baseURL) {
      // Mirrors how other openai-compat recipes signal missing config.
      throw new Error(
        'beellama: BEELLAMA_BASE_URL is not set. Add it to /root/.config/api-keys.env, ' +
          'e.g. BEELLAMA_BASE_URL=http://192.168.1.101:8060/v1 (LAN) or ' +
          'BEELLAMA_BASE_URL=https://your-tunnel-host/v1 (Cloudflare Tunnel).',
      );
    }
    return { baseURL };
  },
  resolveAuth(_env) {
    // beellama's llama.cpp server runs without --api-key; the gateway still
    // needs SOME bearer to satisfy the OpenAI SDK contract. Real authn on
    // the tunneled path rides on resolveDefaultHeaders below.
    return { headerName: 'Authorization', token: 'Bearer no-auth-required' };
  },
  resolveDefaultHeaders(env): Record<string, string> {
    const id = env.BEELLAMA_CF_ACCESS_CLIENT_ID;
    const secret = env.BEELLAMA_CF_ACCESS_CLIENT_SECRET;
    if (id && secret) {
      return {
        'CF-Access-Client-Id': id,
        'CF-Access-Client-Secret': secret,
      };
    }
    if (id || secret) {
      throw new Error(
        'beellama: set BOTH BEELLAMA_CF_ACCESS_CLIENT_ID and BEELLAMA_CF_ACCESS_CLIENT_SECRET, ' +
          'or neither (LAN-direct mode).',
      );
    }
    return {};
  },
  setup_hint:
    'Set BEELLAMA_BASE_URL in /root/.config/api-keys.env (LAN: http://<unraid>:8060/v1, ' +
    'tunnel: https://<host>/v1 + BEELLAMA_CF_ACCESS_CLIENT_ID/SECRET). Then ' +
    '`gbrain config set chat_model beellama:Qwen3.6-27B-Q5_K_S.gguf`.',
};
