/**
 * BACKWARD-COMPATIBILITY SHIM
 *
 * The embedding implementation moved to `src/core/embedding/` as a provider layer
 * (OpenAIProvider, OllamaProvider, factory, service). This file re-exports the
 * public surface so existing imports keep working without churn:
 *
 *   import { embed, embedBatch } from '../core/embedding.ts';
 *
 * New code should import from `./embedding/index.ts` directly to access
 * createProvider, EmbeddingProvider, OllamaProvider, etc.
 *
 * Test mocks (`mock.module('../src/core/embedding.ts', () => ({ embedBatch }))`)
 * continue to intercept the call chain at this shim, so existing tests work unchanged.
 */

export { embed, embedBatch } from './embedding/service.ts';
