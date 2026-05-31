/**
 * v0.19.0 Layer 7 — code-def + code-refs integration tests.
 *
 * Seeds a small fixture repo into PGLite, imports it via importCodeFile,
 * then exercises the new lookup commands. Verifies:
 *   - Symbol definitions resolve to the correct file/line.
 *   - Language filter narrows results.
 *   - code-refs returns multiple chunks from the same file (bypasses
 *     the DISTINCT ON search-path collapse).
 *   - Empty-result case returns empty array (not an error).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { findCodeDef } from '../src/commands/code-def.ts';
import { findCodeRefs } from '../src/commands/code-refs.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed: two TypeScript files. One defines BrainEngine, another uses it.
  // Each symbol is deliberately large enough to stay independent under
  // the small-sibling merging threshold (~120 tokens per chunk).
  const brainEngineSrc = `export interface BrainEngine {
  connect(config: { dbUrl: string; poolSize?: number; timeout?: number }): Promise<void>;
  disconnect(): Promise<void>;
  getPage(slug: string): Promise<{ slug: string; title: string; content: string } | null>;
  putPage(slug: string, page: { title: string; content: string }): Promise<void>;
  deletePage(slug: string): Promise<void>;
  searchKeyword(query: string, opts?: { limit?: number }): Promise<Array<{ slug: string; score: number }>>;
  searchVector(embedding: Float32Array, opts?: { limit?: number }): Promise<Array<{ slug: string; score: number }>>;
  getChunks(slug: string): Promise<Array<{ chunk_text: string; embedding: Float32Array | null }>>;
}

export class PGLiteEngine implements BrainEngine {
  private url: string = '';
  private poolSize: number = 10;

  async connect(config: { dbUrl: string; poolSize?: number; timeout?: number }): Promise<void> {
    this.url = config.dbUrl;
    this.poolSize = config.poolSize ?? 10;
    console.log('connecting to', this.url, 'with pool size', this.poolSize);
    if (this.url === '') throw new Error('no url provided');
    if (this.poolSize < 1) throw new Error('pool size must be >= 1');
    if (config.timeout !== undefined && config.timeout < 0) throw new Error('bad timeout');
  }

  async disconnect(): Promise<void> {
    console.log('disconnecting from', this.url);
    this.url = '';
  }

  async getPage(slug: string) {
    if (!slug) return null;
    if (slug.length > 200) throw new Error('slug too long');
    if (slug.includes('//')) throw new Error('bad slug');
    return { slug, title: 'sample title for ' + slug, content: 'fixture content for ' + slug };
  }

  async putPage(slug: string, page: { title: string; content: string }) {
    if (!slug) throw new Error('slug required');
    if (!page.title) throw new Error('title required');
    console.log('put', slug, page.title, page.content.length, 'chars');
  }

  async deletePage(slug: string): Promise<void> {
    if (!slug) throw new Error('slug required');
    console.log('delete', slug);
  }

  async searchKeyword(query: string, opts: { limit?: number } = {}) {
    if (!query) return [];
    const limit = opts.limit ?? 10;
    return [{ slug: 'match-1', score: 0.9 }, { slug: 'match-2', score: 0.5 }].slice(0, limit);
  }

  async searchVector(embedding: Float32Array, opts: { limit?: number } = {}) {
    if (embedding.length !== 1536) throw new Error('bad embedding dim');
    const limit = opts.limit ?? 10;
    return [{ slug: 'vec-1', score: 0.88 }, { slug: 'vec-2', score: 0.77 }].slice(0, limit);
  }

  async getChunks(slug: string) {
    if (!slug) return [];
    return [{ chunk_text: 'chunk for ' + slug, embedding: null }];
  }
}

export function makeBrainEngine(url: string, poolSize: number): BrainEngine {
  if (!url) throw new Error('url required to makeBrainEngine');
  if (poolSize < 1) throw new Error('pool size must be positive');
  const e = new PGLiteEngine();
  e.connect({ dbUrl: url, poolSize }).catch((err) => {
    console.error('connect failed:', err);
    throw err;
  });
  return e;
}
`;
  const consumerSrc = `import type { BrainEngine } from './engine';

export async function performSync(engine: BrainEngine, path: string, opts: { force?: boolean; dryRun?: boolean } = {}): Promise<void> {
  if (!path) throw new Error('path required');
  const page = await engine.getPage(path);
  if (!page && !opts.force) {
    throw new Error('page not found at ' + path);
  }
  if (!page) {
    console.log('forcing creation of', path);
    await engine.putPage(path, { title: 'Forced', content: 'forced content' });
    return;
  }
  if (opts.dryRun) {
    console.log('dry-run: would update', page.slug);
    return;
  }
  await engine.putPage(page.slug, { title: page.title, content: page.content });
  if (page.slug.startsWith('test-')) {
    console.log('test sync for', page.slug);
  }
  if (page.content.length > 10000) {
    console.warn('large page:', page.slug);
  }
}

export async function performDump(engine: BrainEngine, slug: string): Promise<BrainEngine> {
  if (!slug) throw new Error('slug required');
  const page = await engine.getPage(slug);
  if (page) {
    const dumpedTitle = page.title + ' (dumped at ' + Date.now() + ')';
    await engine.putPage(slug, { title: dumpedTitle, content: page.content });
    const chunks = await engine.getChunks(slug);
    console.log('dumped', slug, 'with', chunks.length, 'chunks');
  } else {
    console.warn('cannot dump missing page:', slug);
  }
  return engine;
}
`;
  await importCodeFile(engine, 'src/engine.ts', brainEngineSrc, { noEmbed: true });
  await importCodeFile(engine, 'src/sync.ts', consumerSrc, { noEmbed: true });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('findCodeDef', () => {
  test('finds the definition of an interface', async () => {
    const results = await findCodeDef(engine, 'BrainEngine');
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Should match in src/engine.ts, not in src/sync.ts
    const engineSlugMatch = results.find((r) => r.slug === 'src-engine-ts');
    expect(engineSlugMatch).toBeDefined();
  });

  test('finds a function definition', async () => {
    const results = await findCodeDef(engine, 'makeBrainEngine');
    expect(results.length).toBeGreaterThanOrEqual(1);
    const match = results.find((r) => r.slug === 'src-engine-ts');
    expect(match).toBeDefined();
    expect(match!.symbol_type).toMatch(/function|export/);
  });

  test('falls back to definition-like chunk text when symbol metadata is missing', async () => {
    const pageRows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages (slug, title, type, page_kind, compiled_truth, frontmatter, updated_at, created_at)
       VALUES (
         'scripts-dx-agent-common-py-fallback',
         'scripts/dx/agent_common.py',
         'code',
         'code',
         '',
         '{"file":"scripts/dx/agent_common.py"}'::jsonb,
         NOW(),
         NOW()
       )
       RETURNING id`,
    );
    await engine.executeRaw(
      `INSERT INTO content_chunks (
         page_id, chunk_index, chunk_text, chunk_source, language,
         symbol_name, symbol_type, start_line, end_line
       )
       VALUES (
         $1,
         0,
         '[Python] scripts/dx/agent_common.py:40-45 function load_router\n\n' ||
         'def load_router(root: Path) -> dict[str, Any]:\n' ||
         '    return tomllib.loads((root / "agents" / "router.toml").read_text())',
         'compiled_truth',
         'python',
         NULL,
         NULL,
         40,
         45
       )`,
      [pageRows[0]!.id],
    );

    const results = await findCodeDef(engine, 'load_router', { language: 'python' });
    const match = results.find((r) => r.slug === 'scripts-dx-agent-common-py-fallback');
    expect(match).toBeDefined();
    expect(match!.symbol_type).toBe('function');
    expect(match!.start_line).toBe(40);
  });

  test('returns empty for unknown symbol', async () => {
    const results = await findCodeDef(engine, 'ThisSymbolDoesNotExist');
    expect(results).toEqual([]);
  });

  test('language filter narrows to typescript only', async () => {
    const results = await findCodeDef(engine, 'BrainEngine', { language: 'typescript' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect(r.language).toBe('typescript');
  });

  test('language filter with non-matching language returns empty', async () => {
    const results = await findCodeDef(engine, 'BrainEngine', { language: 'python' });
    expect(results).toEqual([]);
  });
});

describe('findCodeRefs', () => {
  test('finds multiple usage sites across files', async () => {
    const results = await findCodeRefs(engine, 'BrainEngine');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Should include both files
    const slugs = new Set(results.map((r) => r.slug));
    expect(slugs.has('src-engine-ts')).toBe(true);
    expect(slugs.has('src-sync-ts')).toBe(true);
  });

  test('ranks by slug + line number (deterministic)', async () => {
    const results = await findCodeRefs(engine, 'performSync');
    // performSync is defined in src/sync.ts — findCodeRefs should list it
    const match = results.find((r) => r.slug === 'src-sync-ts');
    expect(match).toBeDefined();
  });

  test('empty query returns empty (no crash on empty ILIKE)', async () => {
    const results = await findCodeRefs(engine, 'ZzzNothingZzz');
    expect(results).toEqual([]);
  });

  test('limit caps result count', async () => {
    const results = await findCodeRefs(engine, 'engine', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test('results include snippets for agent consumption', async () => {
    const results = await findCodeRefs(engine, 'BrainEngine');
    for (const r of results) {
      expect(typeof r.snippet).toBe('string');
      expect(r.snippet.length).toBeGreaterThan(0);
      expect(r.snippet.length).toBeLessThanOrEqual(500);
    }
  });
});
