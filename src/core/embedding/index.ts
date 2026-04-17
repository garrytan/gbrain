/**
 * Public surface of the embedding layer.
 *
 * Most callers want `embed` / `embedBatch` from `./service.ts`.
 * `gbrain doctor` and `gbrain init` use `createProvider` + `getActiveProvider` to introspect.
 */

export type { EmbeddingProvider, ProviderConfig, HealthCheckResult } from './provider.ts';
export { createProvider, resolveConfig, listProviders } from './factory.ts';
export {
  embed,
  embedBatch,
  setProvider,
  getActiveProvider,
  getEmbeddingModel,
  getEmbeddingDimensions,
} from './service.ts';
export { OpenAIProvider } from './providers/openai.ts';
export { OllamaProvider, OllamaError } from './providers/ollama.ts';
