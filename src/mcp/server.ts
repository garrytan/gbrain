import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { BrainEngine } from '../core/engine.ts';
import { parseMarkdown, serializeMarkdown } from '../core/markdown.ts';
import { hybridSearch } from '../core/search/hybrid.ts';
import { expandQuery } from '../core/search/expansion.ts';
import { chunkText } from '../core/chunkers/recursive.ts';
import { embedBatch } from '../core/embedding.ts';
import type { ChunkInput } from '../core/types.ts';

export async function startMcpServer(engine: BrainEngine) {
  const server = new Server(
    { name: 'gbrain', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler('tools/list' as any, async () => ({
    tools: getToolDefinitions(),
  }));

  server.setRequestHandler('tools/call' as any, async (request: any) => {
    const { name, arguments: params } = request.params;
    try {
      const result = await handleToolCall(engine, name, params || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function handleToolCall(
  engine: BrainEngine,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (tool) {
    case 'get_page': {
      const slug = params.slug as string;
      const page = await engine.getPage(slug);
      if (!page) return { error: `Page not found: ${slug}` };
      const tags = await engine.getTags(slug);
      return { ...page, tags };
    }

    case 'put_page': {
      const slug = params.slug as string;
      const content = params.content as string;
      const parsed = parseMarkdown(content, slug + '.md');

      const existing = await engine.getPage(slug);
      if (existing) await engine.createVersion(slug);

      const page = await engine.putPage(slug, {
        type: parsed.type,
        title: parsed.title,
        compiled_truth: parsed.compiled_truth,
        timeline: parsed.timeline,
        frontmatter: parsed.frontmatter,
      });

      for (const tag of parsed.tags) await engine.addTag(slug, tag);

      // Chunk and embed
      const chunks: ChunkInput[] = [];
      if (parsed.compiled_truth.trim()) {
        for (const c of chunkText(parsed.compiled_truth)) {
          chunks.push({ chunk_index: chunks.length, chunk_text: c.text, chunk_source: 'compiled_truth' });
        }
      }
      if (parsed.timeline.trim()) {
        for (const c of chunkText(parsed.timeline)) {
          chunks.push({ chunk_index: chunks.length, chunk_text: c.text, chunk_source: 'timeline' });
        }
      }
      if (chunks.length > 0) {
        try {
          const embeddings = await embedBatch(chunks.map(c => c.chunk_text));
          for (let i = 0; i < chunks.length; i++) {
            chunks[i].embedding = embeddings[i];
          }
        } catch { /* non-fatal */ }
        await engine.upsertChunks(slug, chunks);
      }

      return { slug: page.slug, status: existing ? 'updated' : 'created' };
    }

    case 'delete_page': {
      await engine.deletePage(params.slug as string);
      return { status: 'deleted' };
    }

    case 'list_pages': {
      const pages = await engine.listPages({
        type: params.type as any,
        tag: params.tag as string,
        limit: (params.limit as number) || 50,
      });
      return pages.map(p => ({ slug: p.slug, type: p.type, title: p.title, updated_at: p.updated_at }));
    }

    case 'search': {
      return engine.searchKeyword(params.query as string, { limit: (params.limit as number) || 20 });
    }

    case 'query': {
      return hybridSearch(engine, params.query as string, {
        limit: (params.limit as number) || 20,
        expansion: true,
        expandFn: expandQuery,
      });
    }

    case 'add_tag': {
      await engine.addTag(params.slug as string, params.tag as string);
      return { status: 'ok' };
    }

    case 'remove_tag': {
      await engine.removeTag(params.slug as string, params.tag as string);
      return { status: 'ok' };
    }

    case 'get_tags': {
      return engine.getTags(params.slug as string);
    }

    case 'add_link': {
      await engine.addLink(
        params.from as string,
        params.to as string,
        params.context as string || '',
        params.link_type as string || '',
      );
      return { status: 'ok' };
    }

    case 'remove_link': {
      await engine.removeLink(params.from as string, params.to as string);
      return { status: 'ok' };
    }

    case 'get_links': {
      return engine.getLinks(params.slug as string);
    }

    case 'get_backlinks': {
      return engine.getBacklinks(params.slug as string);
    }

    case 'traverse_graph': {
      return engine.traverseGraph(params.slug as string, (params.depth as number) || 5);
    }

    case 'add_timeline_entry': {
      await engine.addTimelineEntry(params.slug as string, {
        date: params.date as string,
        source: params.source as string || '',
        summary: params.summary as string,
        detail: params.detail as string || '',
      });
      return { status: 'ok' };
    }

    case 'get_timeline': {
      return engine.getTimeline(params.slug as string);
    }

    case 'get_stats': {
      return engine.getStats();
    }

    case 'get_health': {
      return engine.getHealth();
    }

    case 'get_versions': {
      return engine.getVersions(params.slug as string);
    }

    case 'revert_version': {
      await engine.createVersion(params.slug as string);
      await engine.revertToVersion(params.slug as string, params.version_id as number);
      return { status: 'reverted' };
    }

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

function getToolDefinitions() {
  return [
    { name: 'get_page', description: 'Read a page by slug', inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
    { name: 'put_page', description: 'Write/update a page (markdown with frontmatter)', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, content: { type: 'string', description: 'Full markdown content with YAML frontmatter' } }, required: ['slug', 'content'] } },
    { name: 'delete_page', description: 'Delete a page', inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
    { name: 'list_pages', description: 'List pages with optional filters', inputSchema: { type: 'object', properties: { type: { type: 'string' }, tag: { type: 'string' }, limit: { type: 'number' } } } },
    { name: 'search', description: 'Keyword search using full-text search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
    { name: 'query', description: 'Hybrid search with vector + keyword + multi-query expansion', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
    { name: 'add_tag', description: 'Add tag to page', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, tag: { type: 'string' } }, required: ['slug', 'tag'] } },
    { name: 'remove_tag', description: 'Remove tag from page', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, tag: { type: 'string' } }, required: ['slug', 'tag'] } },
    { name: 'get_tags', description: 'List tags for a page', inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
    { name: 'add_link', description: 'Create link between pages', inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, link_type: { type: 'string' }, context: { type: 'string' } }, required: ['from', 'to'] } },
    { name: 'remove_link', description: 'Remove link between pages', inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
    { name: 'get_links', description: 'List outgoing links from a page', inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
    { name: 'get_backlinks', description: 'List incoming links to a page', inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
    { name: 'traverse_graph', description: 'Traverse link graph from a page', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, depth: { type: 'number', description: 'Max traversal depth (default 5)' } }, required: ['slug'] } },
    { name: 'add_timeline_entry', description: 'Add timeline entry to a page', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, date: { type: 'string' }, summary: { type: 'string' }, detail: { type: 'string' }, source: { type: 'string' } }, required: ['slug', 'date', 'summary'] } },
    { name: 'get_timeline', description: 'Get timeline entries for a page', inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
    { name: 'get_stats', description: 'Brain statistics (page count, chunk count, etc.)', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_health', description: 'Brain health dashboard (embed coverage, stale pages, orphans)', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_versions', description: 'Page version history', inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
    { name: 'revert_version', description: 'Revert page to a previous version', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, version_id: { type: 'number' } }, required: ['slug', 'version_id'] } },
  ];
}
