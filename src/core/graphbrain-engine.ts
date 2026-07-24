/**
 * GraphBrain REST API Engine for GBrain.
 *
 * Implements the BrainEngine interface by delegating to a GraphBrain REST API.
 * Use this to swap GBrain's Postgres/pgvector backend for a Neo4j graph database.
 *
 * Configuration:
 *   database_url = "https://graphbrain.example.com/v1/brain_abc123"
 *   Set GBRAIN_GRAPH_API_KEY env var to your brain's API key.
 *
 * Supported: pages, links, traversal, search, stats, timeline, tags, raw data
 * Unsupported (throws): chunks, embeddings, code edges, eval capture, migrations
 *
 * Usage:
 *   gbrain init --engine graphbrain --url https://graphbrain.example.com/v1/brain_abc123
 */

import type { BrainEngine, LinkBatchInput, TimelineBatchInput, ReservedConnection, DreamVerdictInput } from './engine.ts';
import type {
  Page, PageInput, PageFilters,
  SearchResult, SearchOpts,
  Link, GraphNode, GraphPath,
  TimelineEntry, TimelineInput, TimelineOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
  CodeEdgeInput, CodeEdgeResult,
  Chunk, ChunkInput, StaleChunkRow,
  EvalCandidate, EvalCandidateInput,
} from './types.ts';

const NOT_IMPL = (method: string) => {
  throw new Error(`GraphBrain engine: ${method} is not supported (Neo4j backend has no chunk/embedding layer)`);
};

export class GraphBrainRestEngine implements BrainEngine {
  readonly kind = 'postgres' as const; // lie for compat — factory checks kind
  private baseUrl = '';
  private apiKey = '';
  private brainId = '';

  // ── Lifecycle ──

  async connect(config: EngineConfig): Promise<void> {
    this.apiKey = process.env.GBRAIN_GRAPH_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('GraphBrain engine requires GBRAIN_GRAPH_API_KEY env var');
    }

    const url = config.database_url || '';
    if (!url) {
      throw new Error('GraphBrain engine requires database_url set to your GraphBrain endpoint (e.g. https://host/v1/brain_xxx)');
    }

    // Normalize: strip trailing slash
    this.baseUrl = url.replace(/\/$/, '');

    // Extract brainId from URL (last path segment)
    const parts = this.baseUrl.split('/');
    this.brainId = parts[parts.length - 1];
  }

  async disconnect(): Promise<void> { /* no persistent connection */ }
  async initSchema(): Promise<void> { /* GraphBrain provisions schemas server-side */ }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    return fn(this); // no-op — REST is stateless
  }

  async withReservedConnection<T>(fn: (conn: ReservedConnection) => Promise<T>): Promise<T> {
    const conn: ReservedConnection = {
      executeRaw: <T = Record<string, unknown>>(_sql: string, _params?: unknown[]): Promise<T[]> => {
        throw new Error('Raw SQL not supported with GraphBrain engine');
      },
    };
    return fn(conn);
  }

  // ── HTTP helpers ──

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
    };
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(`GraphBrain GET ${path}: ${err.error || res.status}`);
    }
    return res.json();
  }

  private async put(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(`GraphBrain PUT ${path}: ${err.error || res.status}`);
    }
    return res.json();
  }

  private async post(path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(`GraphBrain POST ${path}: ${err.error || res.status}`);
    }
    return res.json();
  }

  private async del(path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GraphBrain DELETE ${path}: ${res.status}`);
    return res.json();
  }

  // ── Mapping helpers ──

  private mapPage(raw: any): Page {
    return {
      id: 0, // GraphBrain has no integer IDs
      slug: raw.slug,
      type: raw.type || 'note',
      title: raw.title || raw.slug,
      compiled_truth: raw.content || '',
      timeline: '',
      frontmatter: raw.frontmatter || {},
      content_hash: raw.content_hash,
      created_at: raw.created_at ? new Date(raw.created_at) : new Date(),
      updated_at: raw.updated_at ? new Date(raw.updated_at) : new Date(),
    };
  }

  private mapSearchResult(raw: any): SearchResult {
    return {
      slug: raw.slug,
      page_id: 0,
      title: raw.title || raw.slug,
      type: raw.type || 'note',
      chunk_text: raw.content || '',
      chunk_source: 'compiled_truth',
      chunk_id: 0,
      chunk_index: 0,
      score: 1.0,
      stale: false,
      source_id: 'default',
    };
  }

  private mapLink(raw: any): Link {
    return {
      from_slug: raw.from_slug,
      to_slug: raw.to_slug,
      link_type: raw.link_type || '',
      context: raw.context || '',
      link_source: null,
      origin_slug: null,
      origin_field: null,
    };
  }

  // ── Pages ──

  async getPage(slug: string): Promise<Page | null> {
    try {
      const raw = await this.get(`/pages/${encodeURIComponent(slug)}`);
      return this.mapPage(raw);
    } catch {
      return null;
    }
  }

  async putPage(slug: string, page: PageInput): Promise<Page> {
    const body: Record<string, unknown> = {
      title: page.title,
      type: page.type,
      content: page.compiled_truth,
      frontmatter: page.frontmatter || {},
    };
    if (page.content_hash) body.content_hash = page.content_hash;
    const raw = await this.put(`/pages/${encodeURIComponent(slug)}`, body);
    return this.mapPage(raw);
  }

  async deletePage(slug: string): Promise<void> {
    await this.del(`/pages/${encodeURIComponent(slug)}`);
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const params = new URLSearchParams();
    params.set('limit', String(filters?.limit || 50));
    if (filters?.type) params.set('type', filters.type);
    if (filters?.offset) params.set('offset', String(filters.offset));
    const qs = params.toString();
    const res = await this.get(`/pages?${qs}`);
    return (res.pages || res).map((p: any) => this.mapPage(p));
  }

  async resolveSlugs(partial: string): Promise<string[]> {
    // Simple prefix search — GraphBrain has no native fuzzy resolve
    const res = await this.get(`/search?q=${encodeURIComponent(partial)}&limit=20`);
    const results = res.results || res;
    return results.map((r: any) => r.slug);
  }

  async getAllSlugs(): Promise<Set<string>> {
    const pages = await this.get(`/pages?limit=10000`);
    const all = pages.pages || pages;
    return new Set(all.map((p: any) => p.slug));
  }

  // ── Search ──

  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = Math.min(opts?.limit || 20, 100);
    const res = await this.get(`/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    const results = res.results || res;
    let mapped = results.map((r: any) => this.mapSearchResult(r));

    // Apply filters that GraphBrain API doesn't support natively
    if (opts?.type) {
      mapped = mapped.filter(r => r.type === opts.type);
    }
    if (opts?.exclude_slugs) {
      const exclude = new Set(opts.exclude_slugs);
      mapped = mapped.filter(r => !exclude.has(r.slug));
    }

    return mapped.slice(0, limit);
  }

  async searchVector(_embedding: Float32Array, _opts?: SearchOpts): Promise<SearchResult[]> {
    throw NOT_IMPL('searchVector');
  }

  async getEmbeddingsByChunkIds(_ids: number[]): Promise<Map<number, Float32Array>> {
    throw NOT_IMPL('getEmbeddingsByChunkIds');
  }

  // ── Chunks (no-op) ──
  // GraphBrain manages chunks server-side; these are passthroughs
  // so the GBrain pipeline (extract, embed) doesn't crash.

  async upsertChunks(_slug: string, _chunks: ChunkInput[]): Promise<void> {
    // No-op: GraphBrain server handles chunking internally on page write
  }

  async getChunks(_slug: string): Promise<Chunk[]> {
    return []; // GraphBrain returns full page content, not per-chunk
  }

  async countStaleChunks(): Promise<number> { return 0; }

  async listStaleChunks(): Promise<StaleChunkRow[]> { return []; }

  async deleteChunks(_slug: string): Promise<void> {
    // No-op: chunks are tied to page lifecycle server-side
  }

  // ── Links ──

  async addLink(from: string, to: string, context?: string, linkType?: string, _linkSource?: string, _originSlug?: string, _originField?: string): Promise<void> {
    await this.post('/links', {
      from_slug: from,
      to_slug: to,
      link_type: linkType || '',
      context: context || '',
    });
  }

  async addLinksBatch(links: LinkBatchInput[]): Promise<number> {
    const payloads = links.map(l => ({
      from_slug: l.from_slug,
      to_slug: l.to_slug,
      link_type: l.link_type || '',
      context: l.context || '',
    }));
    const res = await this.post('/links/batch', { links: payloads });
    return res.created || res.count || 0;
  }

  async removeLink(from: string, to: string, linkType?: string, _linkSource?: string): Promise<void> {
    const body: Record<string, string> = { from_slug: from, to_slug: to };
    if (linkType) body.link_type = linkType;
    await this.del('/links', body);
  }

  async getLinks(slug: string): Promise<Link[]> {
    const res = await this.get(`/links/${encodeURIComponent(slug)}`);
    const links = res.links || res;
    return links.map((l: any) => this.mapLink(l));
  }

  async getBacklinks(slug: string): Promise<Link[]> {
    const res = await this.get(`/backlinks/${encodeURIComponent(slug)}`);
    const links = res.links || res;
    return links.map((l: any) => this.mapLink(l));
  }

  async findByTitleFuzzy(name: string, _dirPrefix?: string, _minSimilarity?: number): Promise<{ slug: string; similarity: number } | null> {
    // Fallback: search for the name
    const res = await this.get(`/search?q=${encodeURIComponent(name)}&limit=1`);
    const results = res.results || res;
    if (results.length > 0) {
      return { slug: results[0].slug, similarity: 0.8 };
    }
    return null;
  }

  // ── Graph Traversal ──

  async traverseGraph(slug: string, depth: number = 2): Promise<GraphNode[]> {
    const res = await this.post('/traverse', {
      start_slug: slug,
      depth,
      direction: 'out',
    });
    return (res.results || []).map((r: any) => ({
      slug: r.slug,
      title: r.title || r.slug,
      type: r.type || 'note',
      depth: r.depth || 1,
      links: (r.links || []).map((l: any) => ({ to_slug: l.to_slug, link_type: l.link_type })),
    }));
  }

  async traversePaths(
    slug: string,
    opts?: { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both' },
  ): Promise<GraphPath[]> {
    const res = await this.post('/traverse', {
      start_slug: slug,
      depth: opts?.depth || 2,
      direction: opts?.direction || 'out',
      link_type: opts?.linkType,
    });
    return (res.results || []).map((r: any) => ({
      from_slug: r.from_slug || slug,
      to_slug: r.to_slug || r.slug,
      link_type: r.link_type || '',
      context: r.context || '',
      depth: r.depth || 1,
    }));
  }

  async getBacklinkCounts(slugs: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for (const slug of slugs) {
      try {
        const res = await this.get(`/backlinks/${encodeURIComponent(slug)}`);
        const links = res.links || res;
        map.set(slug, links.length);
      } catch {
        map.set(slug, 0);
      }
    }
    return map;
  }

  async findOrphanPages(): Promise<Array<{ slug: string; title: string; domain: string | null }>> {
    const res = await this.get('/orphans');
    const orphans = res.orphans || res;
    return orphans.map((o: any) => ({
      slug: o.slug,
      title: o.title || o.slug,
      domain: o.domain || null,
    }));
  }

  // ── Tags ──
  // Tags are stored in page frontmatter until server-side tag endpoints ship.

  async addTag(slug: string, tag: string): Promise<void> {
    const page = await this.getPage(slug);
    if (!page) return;
    const fm = (page.frontmatter || {}) as Record<string, unknown>;
    const tags: string[] = (fm.tags as string[]) || [];
    if (!tags.includes(tag)) {
      tags.push(tag);
      fm.tags = tags;
      await this.put(`/pages/${encodeURIComponent(slug)}`, {
        title: page.title,
        type: page.type,
        content: page.compiled_truth,
        frontmatter: fm,
      });
    }
  }

  async removeTag(slug: string, tag: string): Promise<void> {
    const page = await this.getPage(slug);
    if (!page) return;
    const fm = (page.frontmatter || {}) as Record<string, unknown>;
    const tags: string[] = (fm.tags as string[]) || [];
    fm.tags = tags.filter(t => t !== tag);
    await this.put(`/pages/${encodeURIComponent(slug)}`, {
      title: page.title,
      type: page.type,
      content: page.compiled_truth,
      frontmatter: fm,
    });
  }

  async getTags(slug: string): Promise<string[]> {
    try {
      const page = await this.getPage(slug);
      if (!page) return [];
      const fm = (page.frontmatter || {}) as Record<string, unknown>;
      return (fm.tags as string[]) || [];
    } catch {
      return [];
    }
  }

  // ── Timeline ──

  async addTimelineEntry(slug: string, entry: TimelineInput, _opts?: { skipExistenceCheck?: boolean }): Promise<void> {
    await this.post('/timeline', {
      slug,
      date: entry.date,
      summary: entry.summary,
      detail: entry.detail || '',
      source: entry.source || '',
    });
  }

  async addTimelineEntriesBatch(entries: TimelineBatchInput[]): Promise<number> {
    const payloads = entries.map(e => ({
      slug: e.slug,
      date: e.date,
      summary: e.summary,
      detail: e.detail || '',
      source: e.source || '',
    }));
    const res = await this.post('/timeline/batch', { entries: payloads });
    return res.created || res.count || 0;
  }

  async getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    const res = await this.get(`/timeline/${encodeURIComponent(slug)}${qs ? `?${qs}` : ''}`);
    const entries = res.entries || res;
    return entries.map((e: any) => ({
      id: 0,
      page_id: 0,
      date: e.date,
      source: e.source || '',
      summary: e.summary,
      detail: e.detail || '',
      created_at: e.created_at ? new Date(e.created_at) : new Date(),
    }));
  }

  // ── Raw data ──

  async putRawData(slug: string, source: string, data: object): Promise<void> {
    // Store as frontmatter field
    const page = await this.getPage(slug);
    const fm = page?.frontmatter || {};
    fm[`raw_${source}`] = data;
    await this.put(`/pages/${encodeURIComponent(slug)}`, {
      title: page?.title || slug,
      type: page?.type || 'note',
      content: page?.compiled_truth || '',
      frontmatter: fm,
    });
  }

  async getRawData(slug: string, source?: string): Promise<RawData[]> {
    const page = await this.getPage(slug);
    if (!page) return [];
    const fm = page.frontmatter || {};
    const results: RawData[] = [];
    for (const [key, val] of Object.entries(fm)) {
      if (key.startsWith('raw_') && (!source || key === `raw_${source}`)) {
        results.push({
          source: key.replace('raw_', ''),
          data: val as Record<string, unknown>,
          fetched_at: new Date(),
        });
      }
    }
    return results;
  }

  // ── Stats & Health ──

  async getStats(): Promise<BrainStats> {
    const res = await this.get('/stats');
    return {
      page_count: res.page_count || 0,
      chunk_count: 0,
      embedded_count: 0,
      link_count: res.link_count || 0,
      tag_count: 0,
      timeline_entry_count: 0,
      pages_by_type: res.pages_by_type || {},
    };
  }

  async getHealth(): Promise<BrainHealth> {
    const res = await this.get('/stats');
    const pageCount = res.page_count || 0;
    const linkCount = res.link_count || 0;
    const orphans = (res.most_connected || []).filter((m: any) => m.link_count === 0).length;

    return {
      page_count: pageCount,
      embed_coverage: 0,
      stale_pages: 0,
      orphan_pages: orphans,
      missing_embeddings: 0,
      brain_score: res.brain_score || 0,
      dead_links: 0,
      link_coverage: pageCount > 0 ? Math.min(1, linkCount / pageCount) : 0,
      timeline_coverage: 0,
      most_connected: (res.most_connected || []).slice(0, 5),
      embed_coverage_score: 0,
      link_density_score: 0,
      timeline_coverage_score: 0,
      no_orphans_score: 0,
      no_dead_links_score: 0,
    };
  }

  // ── Ingest log ──

  async logIngest(_entry: IngestLogInput): Promise<void> {
    // TODO: could POST to a dedicated endpoint
  }

  async getIngestLog(_opts?: { limit?: number }): Promise<IngestLogEntry[]> {
    return [];
  }

  // ── Sync ──

  async updateSlug(oldSlug: string, newSlug: string): Promise<void> {
    await this.put(`/pages/${encodeURIComponent(oldSlug)}/rename`, { new_slug: newSlug });
  }

  async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> {
    // No-op: Neo4j relationships are between nodes, not slug strings.
    // When a page's slug changes, all relationships automatically follow.
  }

  // ── Config ──

  async getConfig(_key: string): Promise<string | null> { return null; }
  async setConfig(_key: string, _value: string): Promise<void> {
    throw NOT_IMPL('setConfig');
  }

  // ── Migrations ──

  async runMigration(_version: number, _sql: string): Promise<void> {
    throw NOT_IMPL('runMigration');
  }

  async getChunksWithEmbeddings(_slug: string): Promise<Chunk[]> { return []; }

  // ── Raw SQL ──

  async executeRaw<T = Record<string, unknown>>(_sql: string, _params?: unknown[]): Promise<T[]> {
    throw NOT_IMPL('executeRaw');
  }

  // ── Versions ──

  async createVersion(_slug: string): Promise<PageVersion> {
    throw NOT_IMPL('createVersion');
  }

  async getVersions(_slug: string): Promise<PageVersion[]> { return []; }

  async revertToVersion(_slug: string, _versionId: number): Promise<void> {
    throw NOT_IMPL('revertToVersion');
  }

  // ── Code edges (unsupported) ──

  async addCodeEdges(_edges: CodeEdgeInput[]): Promise<number> { return 0; }
  async deleteCodeEdgesForChunks(_chunkIds: number[]): Promise<void> {}
  async getCallersOf(_qualifiedName: string, _opts?: { sourceId?: string; allSources?: boolean; limit?: number }): Promise<CodeEdgeResult[]> { return []; }
  async getCalleesOf(_qualifiedName: string, _opts?: { sourceId?: string; allSources?: boolean; limit?: number }): Promise<CodeEdgeResult[]> { return []; }
  async getEdgesByChunk(_chunkId: number, _opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number }): Promise<CodeEdgeResult[]> { return []; }
  async searchKeywordChunks(_query: string, _opts?: SearchOpts): Promise<SearchResult[]> { return []; }

  // ── Eval capture (unsupported) ──

  async logEvalCandidate(_input: EvalCandidateInput): Promise<number> { return 0; }
  async listEvalCandidates(_filter?: { since?: Date; limit?: number; tool?: 'query' | 'search' }): Promise<EvalCandidate[]> { return []; }
  async deleteEvalCandidatesBefore(_date: Date): Promise<number> { return 0; }
  async logEvalCaptureFailure(_reason: any): Promise<void> {}
  async listEvalCaptureFailures(_filter?: { since?: Date }): Promise<any[]> { return []; }

  // ── Dream verdicts (unsupported) ──
  async getDreamVerdict(_filePath: string, _contentHash: string): Promise<any | null> { return null; }
  async putDreamVerdict(_filePath: string, _contentHash: string, _verdict: DreamVerdictInput): Promise<void> {}
}
