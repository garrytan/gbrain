/** Evaluation-only Voyage planning. Production provider configuration stays in the gateway. */
import { estimateTokens } from '../../src/core/chunkers/token-estimate.ts';

export interface RerankBatchPlan {
  offset: number;
  count: number;
  inputTokens: number;
}

export const RERANK_TOKEN_ESTIMATE_BASIS =
  'cl100k_base with a 2x margin and individual-digit floor; not the provider tokenizer';

export function estimateRerankTokens(text: string, margin = 2): number {
  if (!Number.isFinite(margin) || margin < 1 || margin > 4) throw new Error('Invalid reranking token margin');
  return Math.max(Math.ceil(estimateTokens(text) * margin), (text.match(/\d/g) ?? []).length);
}

/**
 * Largest contiguous batches satisfying query/pair, document-count and aggregate
 * budgets. 600k aggregate and 8k query are application evaluation ceilings:
 * the legacy Voyage docs explicitly describe them for 2.5, not rerank-3.
 * Lower maxInputTokens for the operating budget accepted by the account.
 * A request token budget is separate from its per-minute rate allowance.
 */
export function planVoyageRerankBatches(query: string, documents: string[],
  maxInputTokens = 600_000, maxDocuments = 1000,
  countTokens: (text: string) => number = estimateRerankTokens): RerankBatchPlan[] {
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0 || maxInputTokens > 600_000 ||
      !Number.isInteger(maxDocuments) || maxDocuments <= 0 || maxDocuments > 1000) {
    throw new Error('Invalid Voyage evaluation token/document budget');
  }
  const queryTokens = countTokens(query);
  const documentTokens = documents.map(doc => countTokens(doc));
  if ([queryTokens, ...documentTokens].some(n => !Number.isSafeInteger(n) || n < 0)) {
    throw new Error('Invalid reranking token count');
  }
  if (queryTokens > 8000 || documentTokens.some(tokens => queryTokens + tokens > 32_000)) {
    throw new Error('Voyage query/document pair exceeds the evaluation context budget');
  }
  const plan: RerankBatchPlan[] = [];
  let offset = 0;
  while (offset < documents.length) {
    let count = 0, inputTokens = 0;
    while (offset + count < documents.length && count < maxDocuments) {
      const next = queryTokens + documentTokens[offset + count]!;
      if (inputTokens + next > maxInputTokens) break;
      inputTokens += next;
      count++;
    }
    if (!count) throw new Error('Voyage query/document pair exceeds the evaluation request token budget');
    plan.push({ offset, count, inputTokens });
    offset += count;
  }
  return plan;
}
