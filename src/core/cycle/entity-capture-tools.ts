import type { ToolDef } from '../minions/types.ts';

export function captureDiscoveryInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const cap = name === 'list_pages' ? 20 : name === 'search' || name === 'query' ? 5 : null;
  if (cap === null) return input;
  const requested = Number(input.limit);
  return { ...input, limit: Number.isFinite(requested) && requested > 0 ? Math.max(1, Math.min(Math.floor(requested), cap)) : cap };
}

export function captureDiscoveryOutput(name: string, output: unknown): unknown {
  if (!['search', 'query', 'list_pages'].includes(name) || !Array.isArray(output)) return output;
  return output.map(row => {
    if (!row || typeof row !== 'object') return row;
    const value = row as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const field of ['slug', 'source_id', 'title', 'type', 'page_id', 'chunk_index', 'score', 'updated_at', 'deleted_at']) {
      if (value[field] !== undefined) result[field] = value[field];
    }
    const text = value.chunk_text ?? value.content ?? value.text ?? value.compiled_truth ?? value.chunk_content;
    if (typeof text === 'string') result.excerpt = text.slice(0, 700);
    return result;
  });
}

export function boundedEntityCaptureTools(tools: ToolDef[]): ToolDef[] {
  return tools.map(tool => {
    const name = tool.name.replace(/^brain_/, '');
    if (!['search', 'query', 'list_pages'].includes(name)) return tool;
    return {
      ...tool,
      description: `${tool.description} Entity discovery returns bounded identity summaries; use get_page before updating an existing page and list_pages offset to inspect more candidates.`,
      async execute(input, ctx) {
        const params = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        return captureDiscoveryOutput(name, await tool.execute(captureDiscoveryInput(name, params), ctx));
      },
    };
  });
}
