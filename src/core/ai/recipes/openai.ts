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
      // gpt-5.6-luna leads because it's the current-generation high-volume
      // tier ($0.20/M input after the 2026-07-30 price cut). gpt-4o-mini is
      // nominally cheaper ($0.15/M in, $0.60/M out) but two generations
      // legacy — the same next-to-retire class this refresh exists to purge
      // from defaults; it stays second as a fallback while OpenAI keeps it
      // on the live sheet.
      models: ['gpt-5.6-luna', 'gpt-4o-mini'],
      cost_per_1m_tokens_usd: 0.20,
      price_last_verified: '2026-08-08',
    },
    chat: {
      // gpt-5.2 dropped off OpenAI's live price sheet with the GPT-5.6
      // family GA (2026-07-09) — removed so the default-slot guard tests
      // can't validate defaults against a dead model. Terra is the
      // balanced mainline tier (same price class gpt-5.2 occupied); Luna
      // is high-volume; Sol is the frontier tier. The chat list is
      // 5.6-only: max_context_tokens below is touchpoint-wide, so listing
      // the legacy 128K gpt-4o-mini here would over-report its window 8x
      // to any future pre-flight consumer (it stays in expansion, where
      // prompts are tiny and it's still on the live sheet).
      models: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 1000000, // GPT-5.6 advertises 1.05M; pinned at 1.0M as a deliberate conservative floor
      cost_per_1m_input_usd: 2.00, // gpt-5.6-terra baseline
      cost_per_1m_output_usd: 12.0,
      price_last_verified: '2026-08-08',
    },
  },
  setup_hint: 'Get an API key at https://platform.openai.com/api-keys, then `export OPENAI_API_KEY=...`',
};
