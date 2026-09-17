/** Native TypeSafe lifecycle; the existing standard/Voyage reranker stays intact. */
import { RerankError, type RerankInput, type RerankResult } from './gateway.ts';
import type { BudgetTracker } from '../budget/budget-tracker.ts';
import { buildTypeSafeRerankBatches, executeTypeSafeRerankBatches, TypeSafeResponseError } from './rerank-typesafe.ts';

interface TypeSafeGatewayDeps {
  model: string;
  modelId: string;
  maxPayloadBytes: number;
  defaultTimeoutMs: number;
  tracker: BudgetTracker | null;
  send: (body: string, signal: AbortSignal) => Promise<Response>;
  isPolicyError: (error: unknown) => boolean;
}

export async function rerankTypeSafe(input: RerankInput, deps: TypeSafeGatewayDeps): Promise<RerankResult[]> {
  let batches;
  try { batches = buildTypeSafeRerankBatches(deps.modelId, input.query, input.documents); }
  catch { throw new RerankError('TypeSafe rerank: query/document pair exceeds context budget', 'payload_too_large'); }
  if (batches.some(batch => Buffer.byteLength(batch.body, 'utf8') > deps.maxPayloadBytes)) {
    throw new RerankError('TypeSafe rerank: request exceeds payload byte cap', 'payload_too_large');
  }
  deps.tracker?.reserve({ modelId: deps.model, estimatedInputTokens: batches.reduce((n, batch) => n + batch.estimatedInputTokens, 0),
    maxOutputTokens: 0, kind: 'rerank', label: 'gateway.rerank' });
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(new Error('rerank timed out')), input.timeoutMs ?? deps.defaultTimeoutMs);
  const callerAbort = () => ctrl.abort(input.signal!.reason);
  if (input.signal?.aborted) callerAbort();
  else input.signal?.addEventListener('abort', callerAbort, { once: true });
  let inputTokens = 0;
  try {
    return await executeTypeSafeRerankBatches(batches, async body => {
      ctrl.signal.throwIfAborted();
      const response = await deps.send(body, ctrl.signal);
      if (!response.ok) {
        const status = response.status;
        const reason = status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : status >= 500 ? 'network' : 'unknown';
        // Provider errors can echo candidate evidence. Preserve status only.
        throw new RerankError(`rerank HTTP ${status}`, reason, status);
      }
      try { return await response.json(); }
      catch (error) {
        if (error instanceof SyntaxError) throw new RerankError('TypeSafe rerank: malformed JSON', 'unknown');
        throw error;
      }
    }, ctrl.signal, tokens => { inputTokens += tokens; }, input.topN);
  } catch (error) {
    if (deps.isPolicyError(error)) throw error;
    if (error instanceof RerankError) throw error;
    if (error instanceof TypeSafeResponseError) throw new RerankError(error.message, 'unknown');
    if (ctrl.signal.aborted) throw new RerankError('TypeSafe rerank: request aborted', input.signal?.aborted ? 'unknown' : 'timeout');
    throw new RerankError('TypeSafe rerank: transport failed', 'network');
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', callerAbort);
    try { deps.tracker?.record({ modelId: deps.model, inputTokens, outputTokens: 0, kind: 'rerank', label: 'gateway.rerank' }); }
    catch { /* Cost overages surface on the next admission, as in the existing gateway. */ }
  }
}
