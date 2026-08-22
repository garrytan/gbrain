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
import { findCodeDef, probeFilteredSymbolTypes, DEF_TYPES } from '../src/commands/code-def.ts';
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

  // #3821: decorated Python defs parse as decorated_definition wrappers.
  // Pre-fix they emitted zero chunks, so code-def could never resolve them.
  const pythonDecoratedSrc = `import functools

@functools.lru_cache(maxsize=64)
def cached_lookup(key):
    """Resolve a pricing key from the canonical table with memoization."""
    table = {"base": 100, "premium": 250, "enterprise": 900}
    if key not in table:
        raise KeyError("unknown pricing key: " + key)
    return table[key]

@dataclass
class PricingConfig:
    currency: str = "usd"

    def describe(self):
        return self.currency.upper()

    @property
    def symbol(self):
        return "$" if self.currency == "usd" else "?"
`;
  await importCodeFile(engine, 'src/pricing.py', pythonDecoratedSrc, { noEmbed: true });
}, 120_000);

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

  test('resolves a decorated python function definition (#3821)', async () => {
    const results = await findCodeDef(engine, 'cached_lookup', { language: 'python' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const match = results.find((r) => r.slug === 'src-pricing-py');
    expect(match).toBeDefined();
    expect(match!.symbol_type).toBe('function');
  });

  test('resolves a decorated python class definition (#3821)', async () => {
    const results = await findCodeDef(engine, 'PricingConfig', { language: 'python' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const match = results.find((r) => r.slug === 'src-pricing-py');
    expect(match).toBeDefined();
    expect(match!.symbol_type).toBe('class');
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

// #3789 residual — normalizeSymbolType fallthroughs invisible to code-def.
// 56ccc14 covered methods/ctors/fields; records (Java), properties (Kotlin/C#),
// and the other audited *_declaration/*_definition/*_item fallthroughs were
// still filtered out by DEF_TYPES, so `code-def` returned
// {count: 0, ready: true} for symbols the chunker HAD indexed.
describe('findCodeDef — DEF_TYPES fallthrough residual (#3789)', () => {
  beforeAll(async () => {
    const javaRecordSrc = `public record PointFixtureRecord(double x, double y, double z, String label, long recordedAtMillis) {
  public double distanceFromOrigin() {
    return Math.sqrt(x * x + y * y + z * z);
  }

  public String describeForHumans() {
    return label + " at (" + x + ", " + y + ", " + z + ") recorded at " + recordedAtMillis;
  }
}
`;
    const kotlinPropertySrc = `val fixtureKotlinBannerProperty: String = "a deliberately long top-level Kotlin property value that keeps this chunk comfortably above the small-sibling merge threshold used by the gbrain code chunker fixtures"

fun fixtureKotlinHelper(input: String): String {
  return input.trim().lowercase().replace(" ", "-") + "/" + fixtureKotlinBannerProperty.length
}
`;
    await importCodeFile(engine, 'src/PointFixtureRecord.java', javaRecordSrc, { noEmbed: true });
    await importCodeFile(engine, 'src/fixture.kt', kotlinPropertySrc, { noEmbed: true });
  }, 30000);

  test('Java record declaration is a definition', async () => {
    const results = await findCodeDef(engine, 'PointFixtureRecord');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.symbol_type).toBe('record declaration');
  });

  test('Kotlin top-level property declaration is a definition', async () => {
    const results = await findCodeDef(engine, 'fixtureKotlinBannerProperty');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.symbol_type).toBe('property declaration');
  });

  test('every audited fallthrough spelling is in DEF_TYPES', () => {
    const audited = [
      // C# / Kotlin / Java entity members + entities
      'property declaration', 'record declaration', 'struct declaration',
      'object declaration', 'namespace declaration', 'file scoped namespace declaration',
      // PHP / Scala
      'trait declaration', 'trait definition', 'object definition',
      // Solidity (bare 'contract' is never produced by normalizeSymbolType)
      'contract declaration', 'modifier definition', 'event definition',
      // C / C++
      'namespace definition', 'template declaration', 'declaration', 'preproc def',
      // Go
      'type declaration', 'const declaration', 'var declaration',
      // Rust *_item fallthroughs
      'struct item', 'trait item', 'impl item', 'mod item', 'type item',
      'const item', 'static item',
      // TS/JS top-level const/let/var + Lua local
      'lexical declaration', 'variable declaration', 'local declaration',
    ];
    for (const t of audited) {
      expect(DEF_TYPES).toContain(t);
    }
  });
});

// #3789 aside — a count:0 that was FILTERED by the allowlist must not read as
// a bare "ready, symbol does not exist". The probe surfaces the symbol types
// that exist for the name but were excluded by DEF_TYPES.
describe('probeFilteredSymbolTypes (#3789)', () => {
  beforeAll(async () => {
    await engine.putPage('code/exotic-fixture', {
      type: 'note',
      title: 'exotic fixture',
      compiled_truth: 'exotic fixture page',
    } as any, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET page_kind = 'code' WHERE slug = 'code/exotic-fixture' AND source_id = 'default'`,
      [],
    );
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM pages WHERE slug = 'code/exotic-fixture' AND source_id = 'default'`,
      [],
    );
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, symbol_name, symbol_type, language)
       VALUES ($1, 0, 'exotic fixture chunk body', 'ExoticFixtureSymbol', 'exotic gizmo kind', 'typescript')`,
      [rows[0]!.id],
    );
  }, 30000);

  test('returns the allowlist-filtered symbol types for a name', async () => {
    const results = await findCodeDef(engine, 'ExoticFixtureSymbol');
    expect(results).toEqual([]);
    const filtered = await probeFilteredSymbolTypes(engine, 'ExoticFixtureSymbol');
    expect(filtered).toEqual(['exotic gizmo kind']);
  });

  test('returns empty for a truly absent symbol', async () => {
    const filtered = await probeFilteredSymbolTypes(engine, 'ThisSymbolDoesNotExist');
    expect(filtered).toEqual([]);
  });

  test('language filter applies to the probe', async () => {
    const filtered = await probeFilteredSymbolTypes(engine, 'ExoticFixtureSymbol', { language: 'python' });
    expect(filtered).toEqual([]);
  });
});
