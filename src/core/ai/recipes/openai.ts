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
      // OpenAI embeddings endpoint hard-caps a single request at 300k tokens
      // total across all `input` items. Without these, large gbrain page
      // batches (e.g. dense Discord transcripts, code-heavy pages) blow up
      // with "maximum request size is 300000 tokens per request".
      //
      // chars_per_token=3 is conservative for transcript/code content where
      // tiktoken averages ~3 chars/token rather than the default 4. Combined
      // with a 220k token budget and 0.8 safety factor → effective ceiling
      // ~176k tokens, well under the 300k hard cap with headroom for
      // tokenizer drift.
      max_batch_tokens: 220000,
      chars_per_token: 3,
      safety_factor: 0.8,
    },
    expansion: {
      models: ['gpt-5.2', 'gpt-4o-mini'],
      cost_per_1m_tokens_usd: 0.15,
      price_last_verified: '2026-04-20',
    },
    chat: {
      models: ['gpt-5.2', 'gpt-4o-mini'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      cost_per_1m_input_usd: 1.25, // gpt-5.2 baseline
      cost_per_1m_output_usd: 10.0,
      price_last_verified: '2026-04-20',
    },
  },
  setup_hint: 'Get an API key at https://platform.openai.com/api-keys, then `export OPENAI_API_KEY=...`',
};
