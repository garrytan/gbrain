import type { Recipe } from '../types.ts';

/**
 * Google Vertex AI (Gemini embedding via ADC).
 *
 * Authentication: Application Default Credentials (ADC) through google-auth-library.
 * On GCE, automatically uses metadata service token. Locally, run
 * `gcloud auth application-default login` to populate
 * ~/.config/gcloud/application_default_credentials.json.
 *
 * Differs from the `google` recipe (which uses GOOGLE_GENERATIVE_AI_API_KEY
 * via AI Studio) — Vertex AI is GCP project-scoped and supports ADC instead
 * of a static API key. Suitable for production deployments that already have
 * a GCP service account or run on Compute Engine / GKE.
 */
export const googleVertex: Recipe = {
  id: 'google-vertex',
  name: 'Google Vertex AI',
  tier: 'native',
  implementation: 'native-google-vertex',
  auth_env: {
    required: ['GBRAIN_VERTEX_PROJECT'],
    optional: ['GBRAIN_VERTEX_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'],
    setup_url: 'https://cloud.google.com/vertex-ai',
  },
  touchpoints: {
    embedding: {
      models: ['gemini-embedding-001'],
      default_dims: 1536,
      dims_options: [128, 256, 512, 768, 1536, 3072],
    },
  },
  setup_hint: 'Set GBRAIN_VERTEX_PROJECT (and optional GBRAIN_VERTEX_LOCATION). On GCE this is auto via metadata service; locally run `gcloud auth application-default login`.',
};
