/**
 * Gateway hooks for the native Vertex AI embedding recipe (#729). The
 * gateway builds the provider from these settings, which carry an explicit
 * gcloud-account auth client (vertex-auth.ts) and never select Express
 * mode. Embedding inputs are shaped for the model and rejected, not
 * truncated, past the recipe's character ceiling.
 */
import type { GoogleVertexProviderSettings } from '@ai-sdk/google-vertex';
import { AIConfigError } from './errors.ts';
import type { Recipe } from './types.ts';
import { GcloudOAuth2Client } from './vertex-auth.ts';

/** Vertex provider settings from the gateway's immutable env snapshot. */
export function vertexProviderSettings(recipe: Recipe, env: Record<string, string | undefined>): GoogleVertexProviderSettings {
  const project = env.GOOGLE_VERTEX_PROJECT;
  const location = env.GOOGLE_VERTEX_LOCATION;
  const account = env.GOOGLE_VERTEX_ACCOUNT;
  const gcloudPath = env.GOOGLE_VERTEX_GCLOUD_PATH;
  if (!project || !location || !account || !gcloudPath) {
    throw new AIConfigError(
      'Vertex embedding requires GOOGLE_VERTEX_PROJECT, GOOGLE_VERTEX_LOCATION, GOOGLE_VERTEX_ACCOUNT and GOOGLE_VERTEX_GCLOUD_PATH.',
      recipe.setup_hint,
    );
  }
  // The Vertex SDK reads this ambient variable while constructing its
  // provider, independently of the gateway's immutable env snapshot.
  // Reject both locations so it cannot select Express mode.
  if (env.GOOGLE_VERTEX_API_KEY || process.env.GOOGLE_VERTEX_API_KEY) {
    throw new AIConfigError(
      'Vertex embedding refuses GOOGLE_VERTEX_API_KEY because it can select Express mode.',
      'Remove GOOGLE_VERTEX_API_KEY and use the configured gcloud OAuth account.',
    );
  }
  return {
    project,
    location,
    googleAuthOptions: { authClient: new GcloudOAuth2Client(gcloudPath, account) },
  };
}

/**
 * Shape embedding inputs for the model, then refuse any input past the
 * recipe's `max_input_chars`. Recipes without the field pass through.
 */
export function prepareEmbedInputs(
  recipe: Recipe,
  modelId: string,
  texts: string[],
  inputType: 'query' | 'document' | undefined,
): string[] {
  // Gemini Embedding 2 does not accept the taskType/title options used by
  // gemini-embedding-001. Its documented retrieval convention lives in the
  // content itself, before the gateway validates or accounts for the input.
  const prepared = recipe.id === 'vertex' && modelId === 'gemini-embedding-2'
    ? texts.map(text => {
      const content = text ?? '';
      return inputType === 'query'
        ? `task: search result | query: ${content}`
        : `title: none | text: ${content}`;
    })
    : texts;
  const maxInputChars = recipe.touchpoints.embedding?.max_input_chars;
  if (maxInputChars !== undefined && prepared.some(text => (text ?? '').length > maxInputChars)) {
    throw new AIConfigError(
      `${recipe.name} embedding input exceeds ${maxInputChars} characters and was not sent.`,
      'Split the input before embedding; this provider is configured to reject oversize inputs rather than truncate them.',
    );
  }
  return prepared;
}
