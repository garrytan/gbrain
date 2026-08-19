/**
 * Query-side instruction template for asymmetric instruction-tuned embedding
 * models.
 *
 * Qwen3-Embedding is trained with an `Instruct: {task}\nQuery:{query}`
 * template on the QUERY side only; documents are embedded raw. The model
 * card reports a 1-5% retrieval drop when the query-side instruction is
 * omitted. The existing `inputType: 'query'` signal only feeds the
 * wire-level `input_type` field (dims.ts), which the openai-compatible
 * endpoints serving these models don't have — the signal silently dropped
 * and every query was embedded document-side. This closes the gap at the
 * text layer instead: gateway.embed() runs applyQueryInstruct() on the
 * input texts immediately before the MAX_CHARS cap.
 *
 * Document/index side and every stored artifact stay untouched (the same
 * input-only invariant as the contextual-retrieval wrapper in
 * embedding-context.ts) — existing brains need NO re-embedding, because
 * raw document-side vectors are already this model family's correct usage.
 *
 * Scope: the qwen3-embedding family only — the SAME match as
 * dimsProviderOptions' Matryoshka branch (isQwen3EmbeddingModel is shared
 * with dims.ts so the two never drift). Hosted Qwen3 derivatives with a
 * server-side instruct parameter (e.g. DashScope text-embedding-v4) have
 * different model ids and are untouched. nomic-embed-text has the same
 * class of gap but requires BOTH-side prefixes (an existing-corpus
 * re-embed/migration), so it is deliberately out of scope here.
 *
 * GBRAIN_QUERY_INSTRUCT overrides the task sentence — retrieval quality is
 * corpus/language-sensitive (a Korean-heavy corpus measured a Korean task
 * sentence significantly ahead of this English default); an empty string
 * disables the template entirely (operational kill switch). Read per call —
 * a deliberate, narrow exception to the C3 no-env-at-call-time rule: this
 * is an operational toggle, not provider config, and per-call reads keep
 * one-shot CLI A/B runs and tests seam-free. The effective sentence folds
 * into the query-cache key via embedding.effectiveQueryInstruct() →
 * queryInstructFor() below.
 */

import { isQwen3EmbeddingModel } from './dims.ts';
import { parseModelId } from './model-resolver.ts';

const QUERY_INSTRUCT_DEFAULT =
  'Given a web search query, retrieve relevant passages that answer the query';

function resolveQueryInstruct(): string {
  const task = process.env.GBRAIN_QUERY_INSTRUCT ?? QUERY_INSTRUCT_DEFAULT;
  return task.trim() === '' ? '' : task;
}

/**
 * Prepend the model card's query-side template. No-op unless
 * inputType === 'query' AND the model id is in the qwen3-embedding family
 * AND the template is not disabled — documents and every other model pass
 * through untouched.
 */
export function applyQueryInstruct(
  texts: string[],
  modelId: string,
  inputType: 'query' | 'document' | undefined,
): string[] {
  if (inputType !== 'query' || !isQwen3EmbeddingModel(modelId)) return texts;
  const task = resolveQueryInstruct();
  if (task === '') return texts;
  return texts.map(t => `Instruct: ${task}\nQuery:${t ?? ''}`);
}

/**
 * The effective query-side instruction for a 'provider:model' string —
 * undefined when the model takes no text template or the template is
 * disabled. Mirrors every applyQueryInstruct() decision, so it is the
 * cache-key feed: hybridSearch folds it into the query-cache knobs hash
 * (via embedding.effectiveQueryInstruct) so a cache row written under one
 * instruction is never served to a lookup under another (the instruction
 * changes what embedQuery() produces — the same contamination class as the
 * v=11 input_type fix and #2825's hardExcludes). Never throws: an
 * unresolvable model string just means "no template".
 */
export function queryInstructFor(modelString: string): string | undefined {
  try {
    const { modelId } = parseModelId(modelString);
    if (!isQwen3EmbeddingModel(modelId)) return undefined;
    const task = resolveQueryInstruct();
    return task === '' ? undefined : task;
  } catch {
    return undefined;
  }
}
