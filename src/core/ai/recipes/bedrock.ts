import type { Recipe } from '../types.ts';

/** Amazon Bedrock recipe. Requires AWS_REGION and Bedrock model access. */
export const bedrock: Recipe = {
  id: 'bedrock',
  name: 'Amazon Bedrock',
  tier: 'native',
  implementation: 'native-bedrock',
  auth_env: {
    required: ['AWS_REGION'],
    optional: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
    setup_url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html',
  },
  touchpoints: {
    embedding: {
      models: [
        'amazon.titan-embed-text-v2:0',   // 1536d, Matryoshka (256/512/1024/1536)
        'amazon.titan-embed-text-v1',      // 1536d fixed
        'cohere.embed-english-v3',         // 1024d
        'cohere.embed-multilingual-v3',    // 1024d, 100+ languages
      ],
      default_dims: 1536,
      dims_options: [256, 512, 1024, 1536],
      cost_per_1m_tokens_usd: 0.02,
      price_last_verified: '2026-06-03',
      max_batch_tokens: 8_000,
      chars_per_token: 4,
      safety_factor: 0.8,
    },
    reranker: {
      models: [
        'amazon.rerank-v1:0',
        'cohere.rerank-v3-5:0',
      ],
      default_model: 'amazon.rerank-v1:0',
      cost_per_1m_tokens_usd: 0.0,
      price_last_verified: '2026-06-03',
      max_payload_bytes: 5_000_000,
    },
    chat: {
      models: [
        'anthropic.claude-sonnet-4-5-20251101-v1:0',
        'anthropic.claude-sonnet-4-6-20260101-v1:0',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
        'us.anthropic.claude-sonnet-4-5-20251101-v1:0',
        'us.anthropic.claude-sonnet-4-6-20260101-v1:0',
        'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        'amazon.nova-pro-v1:0',
        'amazon.nova-lite-v1:0',
        'amazon.nova-micro-v1:0',
      ],
      supports_tools: true,
      supports_subagent_loop: false,
    },
  },
  setup_hint: [
    'Set AWS_REGION to your Bedrock-enabled region (e.g. us-east-1).',
    'Auth via keys: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY.',
    'Auth via IAM role: no env keys needed when running on EC2/ECS/Lambda.',
    'Enable model access in the AWS Bedrock console before first use.',
    'For subagent loops: gbrain config set agent.use_gateway_loop true',
  ].join(' '),
};
