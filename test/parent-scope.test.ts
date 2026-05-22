/**
 * v0.20.0 Cathedral II Layer 6 (A3) — parent-scope + nested-chunk tests.
 *
 * The v0.19.0 chunker emits one chunk per top-level AST node, so a class
 * with three methods ships as ONE chunk. A3 extends the chunker to emit
 * each method as its own chunk carrying `parentSymbolPath: ['ClassName']`,
 * and slims the class-level parent chunk to its declaration + member list.
 * The chunk header gets a `(in ClassName)` suffix so the embedding
 * captures scope context.
 *
 * Validates: (1) the class emits as N+1 chunks (parent + N methods),
 * (2) each method chunk has the parent path populated, (3) the header
 * line reflects scope, (4) round-trips through upsertChunks intact.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { chunkCodeText } from '../src/core/chunkers/code.ts';

describe('Layer 6 (A3) — nested-chunk emission (TypeScript class)', () => {
  const source = `
export class BrainEngine {
  searchKeyword(query: string) {
    return this.runQuery(query);
  }

  searchVector(emb: Float32Array) {
    return this.runVec(emb);
  }

  getPage(slug: string) {
    return this.cache.get(slug);
  }
}
`.trim();

  test('emits parent + one chunk per method', async () => {
    const chunks = await chunkCodeText(source, 'src/brain.ts');
    // 1 parent (BrainEngine) + 3 methods = 4 chunks
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    const symbols = chunks.map(c => c.metadata.symbolName);
    expect(symbols).toContain('BrainEngine');
    expect(symbols).toContain('searchKeyword');
    expect(symbols).toContain('searchVector');
    expect(symbols).toContain('getPage');
  });

  test('method chunks carry parentSymbolPath = [ClassName]', async () => {
    const chunks = await chunkCodeText(source, 'src/brain.ts');
    const method = chunks.find(c => c.metadata.symbolName === 'searchKeyword');
    expect(method).toBeDefined();
    expect(method!.metadata.parentSymbolPath).toEqual(['BrainEngine']);
  });

  test('parent chunk has empty parentSymbolPath (top-level)', async () => {
    const chunks = await chunkCodeText(source, 'src/brain.ts');
    const parent = chunks.find(c => c.metadata.symbolName === 'BrainEngine');
    expect(parent).toBeDefined();
    expect(parent!.metadata.parentSymbolPath).toEqual([]);
  });

  test('method chunk header includes scope suffix', async () => {
    const chunks = await chunkCodeText(source, 'src/brain.ts');
    const method = chunks.find(c => c.metadata.symbolName === 'searchKeyword');
    expect(method!.text).toContain('(in BrainEngine)');
  });

  test('parent chunk body contains member digest, not full bodies', async () => {
    const chunks = await chunkCodeText(source, 'src/brain.ts');
    const parent = chunks.find(c => c.metadata.symbolName === 'BrainEngine');
    // Parent body slim: has declaration + Members list, NOT full method bodies.
    expect(parent!.text).toContain('Members:');
    // runQuery / runVec are nested-method bodies — they belong to the
    // separately-emitted method chunks, not the parent's member digest.
    expect(parent!.text).not.toContain('runQuery');
  });
});

describe('Layer 6 (A3) — Python class', () => {
  const source = `
class UserService:
    def get_user(self, uid):
        return self.store.get(uid)

    def save_user(self, user):
        self.store.put(user.id, user)
`.trim();

  test('emits class + 2 method chunks with parent path', async () => {
    const chunks = await chunkCodeText(source, 'src/user_service.py');
    const symbols = chunks.map(c => c.metadata.symbolName);
    expect(symbols).toContain('UserService');
    expect(symbols).toContain('get_user');
    expect(symbols).toContain('save_user');

    const method = chunks.find(c => c.metadata.symbolName === 'get_user');
    expect(method!.metadata.parentSymbolPath).toEqual(['UserService']);
  });
});

describe('Layer 6 (A3) — Ruby class + module (Rubyist coverage)', () => {
  const source = `
module Admin
  class UsersController
    def render
      "rendering"
    end

    def find_all
      []
    end
  end
end
`.trim();

  test('emits nested Ruby methods with their class as parent', async () => {
    const chunks = await chunkCodeText(source, 'app/controllers/admin/users_controller.rb');
    const symbols = chunks.map(c => c.metadata.symbolName);
    expect(symbols).toContain('UsersController');
    expect(symbols).toContain('render');
    expect(symbols).toContain('find_all');

    const render = chunks.find(c => c.metadata.symbolName === 'render');
    // At minimum the immediate parent class shows up; full
    // qualified-name (Admin::UsersController#render) lands in Layer 5.
    expect(render!.metadata.parentSymbolPath).toContain('UsersController');
  });
});

describe('Layer 6 (A3) — top-level function unchanged', () => {
  test('standalone function emits one chunk with empty parent path', async () => {
    const source = 'export function parse(input: string) { return input; }';
    const chunks = await chunkCodeText(source, 'src/parse.ts');
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.metadata.symbolName).toBe('parse');
    expect(chunks[0]!.metadata.parentSymbolPath).toEqual([]);
  });
});

describe('Layer 6 (A3) — parent_symbol_path round-trips through upsertChunks', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    await engine.putPage('src-brain-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'src/brain.ts (typescript)',
      compiled_truth: 'export class BrainEngine { search() { return 42; } }',
      timeline: '',
    });
    await engine.upsertChunks('src-brain-ts', [
      {
        chunk_index: 0,
        chunk_text: '[TypeScript] src/brain.ts:1-1 class BrainEngine\n\nexport class BrainEngine { ... }',
        chunk_source: 'compiled_truth',
        language: 'typescript',
        symbol_name: 'BrainEngine',
        symbol_type: 'class',
      },
      {
        chunk_index: 1,
        chunk_text: '[TypeScript] src/brain.ts:1-1 method search (in BrainEngine)\n\nsearch() { return 42; }',
        chunk_source: 'compiled_truth',
        language: 'typescript',
        symbol_name: 'search',
        symbol_type: 'method',
        parent_symbol_path: ['BrainEngine'],
      },
    ]);
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('parent_symbol_path persists as text[] and survives round-trip', async () => {
    const chunks = await engine.getChunks('src-brain-ts');
    expect(chunks.length).toBe(2);
    const method = chunks.find(c => c.symbol_name === 'search');
    expect(method).toBeDefined();
    expect(method!.parent_symbol_path).toEqual(['BrainEngine']);

    const klass = chunks.find(c => c.symbol_name === 'BrainEngine');
    // Class-level chunk: parent path is null in the DB (no enclosing scope).
    expect(klass!.parent_symbol_path == null || (klass!.parent_symbol_path as string[]).length === 0).toBe(true);
  });
});
