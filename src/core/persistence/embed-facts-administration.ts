import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { embedStaleFacts } from '../embed-facts.ts';
import { validateEmbedFactsOptions } from '../embed-facts-options.ts';
import { OperationError } from '../ops/contract.ts';
import { EmbeddingDisabledError } from '../embedding-dim-check.ts';
import { currentVerifiedLocalWriter } from './identity.ts';

export async function runAuthenticatedFactEmbedding(engine: BrainEngine, params: Record<string, unknown>, selectedConfig: GBrainConfig | null = null): Promise<Record<string, unknown>> {
  const verified = currentVerifiedLocalWriter();
  if (!verified || verified.remote || verified.principal.kind !== 'local_cli') {
    throw new OperationError('permission_denied', 'Fact embedding repair requires a current trusted CLI registration');
  }
  if (Object.keys(params).some(key => key !== 'options')) {
    throw new OperationError('invalid_params', 'Fact embedding repair requires typed options');
  }
  const options = validateEmbedFactsOptions(params.options);
  const controller = new AbortController();
  let work: ReturnType<typeof embedStaleFacts> | undefined;
  const unregister = engine.registerBeforeDisconnect(async () => {
    controller.abort();
    await work?.catch(() => {});
  });
  try {
    work = embedStaleFacts(engine, { ...options, signal: controller.signal }, selectedConfig);
    return { ...await work };
  } catch (error) {
    if (error instanceof EmbeddingDisabledError) throw new OperationError('embedding_disabled', error.message);
    throw error;
  } finally { unregister(); }
}
