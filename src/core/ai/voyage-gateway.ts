/**
 * Voyage embeddings routed through the Vercel AI Gateway (#6061). The gateway
 * ignores Voyage's root `output_dimension` and reads the width from
 * `providerOptions.voyage.outputDimension`, so a Matryoshka width other than
 * the model default came back at the default width. Voyage's own API rejects
 * `providerOptions` with HTTP 400, so the field is added only when the
 * request URL's hostname is exactly the gateway host: never a substring or
 * suffix match, never for api.voyageai.com or another proxy.
 */
import { AIConfigError } from './errors.ts';

export const VERCEL_AI_GATEWAY_HOST = 'ai-gateway.vercel.sh';

function requestHostname(input: RequestInfo | URL): string | null {
  try {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Set the Voyage width on an outbound body: root `output_dimension` always, the gateway field only for the gateway host. */
export function applyVoyageOutputDimension(body: Record<string, unknown>, input: RequestInfo | URL, dims: number): void {
  body.output_dimension = dims;
  if (requestHostname(input) !== VERCEL_AI_GATEWAY_HOST) return;
  const options = (body.providerOptions && typeof body.providerOptions === 'object' ? body.providerOptions : {}) as Record<string, unknown>;
  const voyage = (options.voyage && typeof options.voyage === 'object' ? options.voyage : {}) as Record<string, unknown>;
  body.providerOptions = { ...options, voyage: { ...voyage, outputDimension: dims } };
}

/**
 * The response carried a width other than the one requested. With a custom
 * base URL the likely cause is the proxy dropping the width parameter, not
 * the stored vectors, so the message says so before suggesting a migration.
 */
export function embeddingDimMismatchError(
  modelId: string, returned: number, expected: number, migrateCommand: string,
  route: { provider: string; baseUrl?: string; defaultBaseUrl?: string },
): AIConfigError {
  const migrate = `\`${migrateCommand}\``;
  const proxied = route.baseUrl !== undefined && route.baseUrl !== route.defaultBaseUrl;
  if (!proxied) {
    return new AIConfigError(`Embedding dim mismatch: model ${modelId} returned ${returned} but schema expects ${expected}.`, `Run ${migrate} or change models.`);
  }
  const host = requestHostname(route.baseUrl!) ?? route.baseUrl!;
  return new AIConfigError(
    `Embedding dim mismatch: model ${modelId} returned ${returned} but schema expects ${expected}. Requests go through ${host} (provider_base_urls.${route.provider}), not the provider's own API; a proxy that drops the requested width returns the model default. Nothing was written.`,
    `Check that the proxy forwards the requested embedding width (then \`gbrain doctor --only embedding_provider --probe --json\`); only if ${returned} dimensions is what you want, run ${migrate}.`,
  );
}
