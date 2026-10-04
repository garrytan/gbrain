import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { embedStaleFacts } from '../embed-facts.ts';
import { validateEmbedFactsOptions } from '../embed-facts-options.ts';
import { opError } from '../ops/contract.ts';
import { EmbeddingDisabledError } from '../embedding-dim-check.ts';
import { currentVerifiedLocalWriter } from './identity.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';

export async function runAuthenticatedFactEmbedding(engine: BrainEngine, params: Record<string, unknown>, selectedConfig: GBrainConfig | null = null): Promise<Record<string, unknown>> {
  const verified = currentVerifiedLocalWriter();
  if (!verified || verified.remote || verified.principal.kind !== 'local_cli') {
    throw trustedCliRequired('Fact embedding repair requires a current trusted CLI registration');
  }
  if (Object.keys(params).some(key => key !== 'options')) {
    throw opError('invalid_params', 'Fact embedding repair requires typed options',
      'Run the CLI command gbrain embed --stale --facts --source with --dry-run first; it builds the typed options this owner lane accepts.');
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
    if (error instanceof EmbeddingDisabledError) {
      throw opError('embedding_disabled', error.message,
        'Embeddings are disabled for this brain, so fact embeddings cannot be repaired and nothing was spent. Enabling an embedding provider is the user\'s decision because it can cost money.',
        { fix: readFix('Reports the brain\'s embedding readiness, read-only.', { argv: ['gbrain', 'doctor', '--only', 'embeddings', '--json'] }) });
    }
    throw error;
  } finally { unregister(); }
}
