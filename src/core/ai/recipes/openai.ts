import type { Recipe } from '../types.ts';

export const openai: Recipe = {
  id: 'openai',
  name: 'OpenAI',
  tier: 'native',
  implementation: 'native-openai',
  auth_env: {
    required: ['OPENAI_API_KEY'],
    optional: ['OPENAI_ORG_ID', 'OPENAI_PROJECT'],
    setup_url: 'https://platform.openai.com/api-keys',
  },
  touchpoints: {
    embedding: {
      models: ['text-embedding-3-large', 'text-embedding-3-small'],
      default_dims: 1536,
      dims_options: [256, 512, 768, 1024, 1536, 3072],
      cost_per_1m_tokens_usd: 0.13,
      price_last_verified: '2026-04-20',
      // OpenAI per-request hard cap is 300K tokens. Free/Tier-1 TPM is 1M.
      // Cap batches conservatively at 100K to handle token-dense content
      // (Discord/Slack markdown+JSON tokenizes at ~chars/2.7, not the chars/4
      // estimate the batcher uses). 100K estimated = ~150K real tokens worst-case,
      // safely under both the 300K per-request and 1M TPM ceilings.
      max_batch_tokens: 100_000,
    },
    expansion: {
      models: ['gpt-5.6-luna', 'gpt-4o-mini'],
      cost_per_1m_tokens_usd: 1.00, // gpt-5.6-luna baseline
      price_last_verified: '2026-08-17',
    },
    chat: {
      // STATIC FALLBACK ONLY — the runtime default is discovered from the
      // account's own /v1/models via src/core/ai/openai-latest.ts (ranked by
      // the same tier grammar), so this list matters only before the first
      // keyed connect or when discovery is disabled/offline. Order is not
      // semantic (the ranker classifies by suffix); keep it current-ish at
      // release time, not perfectly.
      // gpt-5.2 stays listed: the cross-modal + takes-quality eval judge
      // panels pin it for baseline reproducibility, and their recipe-
      // consistency guards require panel models to be listed entry points.
      models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2', 'gpt-4o-mini'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 1_050_000, // gpt-5.6 family window (GA 2026-07-09)
      cost_per_1m_input_usd: 2.50, // gpt-5.6-terra baseline (the reasoning-tier default)
      cost_per_1m_output_usd: 15.0,
      price_last_verified: '2026-08-17',
    },
  },
  setup_hint: 'Get an API key at https://platform.openai.com/api-keys, then `export OPENAI_API_KEY=...`',
};
