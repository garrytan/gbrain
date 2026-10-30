import type { Recipe } from '../types.ts';

/**
 * Vertex uses the Node SDK with an explicit gcloud-backed OAuth client.
 * Project, location, account and executable are deliberately explicit
 * configuration, not inferred from an API-key provider or a proxy endpoint.
 */
export const vertex: Recipe = {
  id: 'vertex',
  name: 'Google Vertex AI',
  tier: 'native',
  implementation: 'native-vertex',
  auth_env: {
    required: [
      'GOOGLE_VERTEX_PROJECT',
      'GOOGLE_VERTEX_LOCATION',
      'GOOGLE_VERTEX_ACCOUNT',
      'GOOGLE_VERTEX_GCLOUD_PATH',
    ],
    setup_url: 'https://cloud.google.com/docs/authentication/provide-credentials-adc',
  },
  touchpoints: {
    embedding: {
      models: ['gemini-embedding-001', 'gemini-embedding-2'],
      default_model: 'gemini-embedding-001',
      default_dims: 768,
      dims_options: [768],
      max_input_tokens: {
        'gemini-embedding-001': 2048,
        'gemini-embedding-2': 8192,
      },
      max_input_chars: 8000,
      max_batch_items: 1,
      chars_per_token: 4,
      cost_per_1m_tokens_usd: 0.15,
      price_last_verified: '2026-09-30',
    },
  },
  setup_hint:
    'Set google_vertex_project, google_vertex_location, google_vertex_account and an absolute google_vertex_gcloud_path for the authorized gcloud account.',
};
