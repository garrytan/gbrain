/**
 * The query-expansion prompt `gateway.expand()` sends. Peeled from gateway.ts
 * so the eval call planner (src/eval/longmemeval/call-plan.ts) measures the
 * same template text the call sends, without importing the call itself.
 */
export function buildExpansionPrompt(query: string): string {
  return [
    'Rewrite the search query below into 3-4 different, related queries that would help find relevant documents. Respond with a JSON object in exactly this shape: {"queries": ["rewrite1", "rewrite2", "rewrite3"]}. The JSON key MUST be exactly "queries" (not "rewrites" or any other variation).',
    'Return ONLY the JSON object. Do NOT include the original query in the result.',
    'Each rewrite should emphasize different aspects, synonyms, or framings.',
    '',
    `Query: ${query}`,
  ].join('\n');
}
