export const MINIMAX_CHAT_MODELS = ['MiniMax-M3', 'MiniMax-M2.7'] as const;

export const MINIMAX_ENDPOINTS = {
  global_en: {
    openai_base_url: 'https://api.minimax.io/v1',
    anthropic_base_url: 'https://api.minimax.io/anthropic',
  },
  cn_zh: {
    openai_base_url: 'https://api.minimaxi.com/v1',
    anthropic_base_url: 'https://api.minimaxi.com/anthropic',
  },
} as const;

export const MINIMAX_CHAT_PRICING = {
  input: 0.3,
  output: 1.2,
  verified_at: '2026-07-08',
} as const;
