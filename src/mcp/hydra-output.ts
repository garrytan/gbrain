/** Agent-facing cloud Markdown; HTTP's existing JSON body remains compatible with older thin clients. */
import { redactRetrievalOutput } from '../core/search/output-redaction.ts';
import type { ToolResult } from './dispatch.ts';

export function applyHydraMarkdown(out: ToolResult, result: unknown, meta: Record<string, unknown>, transport: string | undefined): ToolResult {
  const retrieval = meta.retrieval as { hydradb?: { markdown?: string } } | undefined;
  const provider = retrieval?.hydradb ?? meta.hydradb as { markdown?: string } | undefined;
  if (typeof provider?.markdown !== 'string') return out;
  let text = redactRetrievalOutput([{ chunk_text: provider.markdown }], {}).results[0]!.chunk_text;
  const facts = (result as { facts?: Array<{ fact: string }> } | null)?.facts;
  if (facts?.length) text += '\n\n## Saved facts\n\n' + facts.map(f => `- ${f.fact}`).join('\n');
  if (transport === 'stdio') {
    out.structuredContent = { result };
    out.content[0] = { type: 'text', text };
  } else {
    out.content.splice(1, 0, { type: 'text', text });
  }
  return out;
}
