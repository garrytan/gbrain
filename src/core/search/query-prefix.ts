/**
 * #5691 / #3783: the opt-in query instruction for instruction-style embedding
 * models. `embedding_query_prefix` lives in the brain's database config
 * (`gbrain config set embedding_query_prefix …`), so every mounted brain uses
 * its own value. Search reads it once per request and threads the exact bytes
 * to the query embedding and the query-cache key; keyword search and stored
 * document vectors never see it, and the gateway's global state is untouched.
 * There is no default: nothing is guessed from the model id at query time.
 */
import type { BrainEngine } from '../engine.ts';

export const EMBEDDING_QUERY_PREFIX_KEY = 'embedding_query_prefix';

export async function loadEmbeddingQueryPrefix(engine: BrainEngine): Promise<string> {
  if (typeof engine.getConfig !== 'function') return '';
  try {
    return (await engine.getConfig(EMBEDDING_QUERY_PREFIX_KEY)) ?? '';
  } catch {
    return '';
  }
}

/** Model families whose model cards ask for a query instruction, with the documented value. */
const QUERY_PREFIX_FAMILIES: ReadonlyArray<{ family: string; pattern: RegExp; value: string }> = [
  { family: 'Qwen3-Embedding', pattern: /qwen3[-_]?embed/,
    value: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:' },
  { family: 'e5', pattern: /(^|[/:_-])(multilingual-)?e5([-_.]|$)/, value: 'query: ' },
  { family: 'BGE', pattern: /(^|[/:_-])bge-(?!m3)/, value: 'Represent this sentence for searching relevant passages: ' },
  { family: 'nomic-embed', pattern: /nomic-embed/, value: 'search_query: ' },
];

export function suggestedQueryPrefix(embeddingModel: string): { family: string; value: string } | null {
  const id = embeddingModel.toLowerCase();
  const match = QUERY_PREFIX_FAMILIES.find(f => f.pattern.test(id));
  return match ? { family: match.family, value: match.value } : null;
}

/** A POSIX-shell argument that reproduces `value` byte for byte (ANSI-C quoting when it holds a newline). */
export function shellQuoteConfigValue(value: string): string {
  if (/[\n\r\t]/.test(value)) {
    return `$'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'`;
  }
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}
