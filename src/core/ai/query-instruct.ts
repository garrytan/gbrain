/** Qwen's documented query-only template; document vectors remain unchanged. */
import { isQwen3EmbeddingModel } from './dims.ts';

export const DEFAULT_QUERY_INSTRUCT =
  'Given a web search query, retrieve relevant passages that answer the query';

/** Empty/whitespace explicitly disables client formatting for server-templated endpoints. */
export function queryInstructionForModel(
  modelId: string,
  env: Record<string, string | undefined> | undefined,
): string | undefined {
  if (!isQwen3EmbeddingModel(modelId)) return undefined;
  const task = env?.GBRAIN_QUERY_INSTRUCT ?? DEFAULT_QUERY_INSTRUCT;
  return task.trim() === '' ? undefined : task;
}

export function applyQueryInstruction(
  texts: string[],
  modelId: string,
  inputType: 'query' | 'document' | undefined,
  env: Record<string, string | undefined> | undefined,
): string[] {
  if (inputType !== 'query') return texts;
  const instruction = queryInstructionForModel(modelId, env);
  return instruction === undefined ? texts : texts.map(text => `Instruct: ${instruction}\nQuery: ${text ?? ''}`);
}
