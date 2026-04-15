import { describe, test, expect } from 'bun:test';
import { validateSlug, contentHash, importContentHash, rowToPage, rowToChunk, rowToSearchResult } from '../src/core/utils.ts';

describe('validateSlug', () => {
  test('accepts valid slugs', () => {
    expect(validateSlug('people/sarah-chen')).toBe('people/sarah-chen');
    expect(validateSlug('concepts/rag')).toBe('concepts/rag');
    expect(validateSlug('simple')).toBe('simple');
  });

  test('normalizes to lowercase', () => {
    expect(validateSlug('People/Sarah-Chen')).toBe('people/sarah-chen');
    expect(validateSlug('UPPER')).toBe('upper');
  });

  test('rejects empty slug', () => {
    expect(() => validateSlug('')).toThrow('Invalid slug');
  });

  test('rejects path traversal', () => {
    expect(() => validateSlug('../etc/passwd')).toThrow('path traversal');
    expect(() => validateSlug('test/../hack')).toThrow('path traversal');
  });

  test('rejects leading slash', () => {
    expect(() => validateSlug('/absolute/path')).toThrow('start with /');
  });
});

describe('contentHash', () => {
  test('returns deterministic hash', () => {
    const h1 = contentHash('hello', 'world');
    const h2 = contentHash('hello', 'world');
    expect(h1).toBe(h2);
  });

  test('changes when content changes', () => {
    const h1 = contentHash('hello', 'world');
    const h2 = contentHash('hello', 'changed');
    expect(h1).not.toBe(h2);
  });

  test('returns hex string', () => {
    const h = contentHash('test', '');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('importContentHash', () => {
  test('returns deterministic hash for full import state', () => {
    const input = {
      title: 'LLVM',
      type: 'system' as const,
      compiled_truth: 'Compiler infrastructure.',
      timeline: '',
      frontmatter: { repo: 'llvm/llvm-project', language: ['C++'] },
      tags: ['compiler', 'tooling'],
    };
    expect(importContentHash(input)).toBe(importContentHash(input));
  });

  test('normalizes tag order', () => {
    const h1 = importContentHash({
      title: 'LLVM',
      type: 'system',
      compiled_truth: 'Compiler infrastructure.',
      timeline: '',
      frontmatter: {},
      tags: ['tooling', 'compiler'],
    });
    const h2 = importContentHash({
      title: 'LLVM',
      type: 'system',
      compiled_truth: 'Compiler infrastructure.',
      timeline: '',
      frontmatter: {},
      tags: ['compiler', 'tooling'],
    });
    expect(h1).toBe(h2);
  });

  test('normalizes frontmatter key order recursively', () => {
    const h1 = importContentHash({
      title: 'LLVM',
      type: 'system',
      compiled_truth: 'Compiler infrastructure.',
      timeline: '',
      frontmatter: {
        codemap: [
          {
            pointers: [
              { symbol: 'Old::Symbol()', role: 'Original implementation', path: 'src/original.ts' },
            ],
            system: 'systems/llvm',
          },
        ],
        repo: 'llvm/llvm-project',
      },
      tags: [],
    });
    const h2 = importContentHash({
      title: 'LLVM',
      type: 'system',
      compiled_truth: 'Compiler infrastructure.',
      timeline: '',
      frontmatter: {
        repo: 'llvm/llvm-project',
        codemap: [
          {
            system: 'systems/llvm',
            pointers: [
              { path: 'src/original.ts', role: 'Original implementation', symbol: 'Old::Symbol()' },
            ],
          },
        ],
      },
      tags: [],
    });
    expect(h1).toBe(h2);
  });

  test('preserves Date frontmatter values instead of collapsing them', () => {
    const h1 = importContentHash({
      title: 'LLVM',
      type: 'system',
      compiled_truth: 'Compiler infrastructure.',
      timeline: '',
      frontmatter: { reviewed_at: new Date('2026-04-15T12:30:00-07:00') },
      tags: [],
    });
    const h2 = importContentHash({
      title: 'LLVM',
      type: 'system',
      compiled_truth: 'Compiler infrastructure.',
      timeline: '',
      frontmatter: { reviewed_at: new Date('2026-04-16T12:30:00-07:00') },
      tags: [],
    });
    expect(h1).not.toBe(h2);
  });
});

describe('rowToPage', () => {
  test('parses string frontmatter', () => {
    const page = rowToPage({
      id: 1, slug: 'test', type: 'concept', title: 'Test',
      compiled_truth: 'body', timeline: '',
      frontmatter: '{"key":"val"}',
      content_hash: 'abc', created_at: '2024-01-01', updated_at: '2024-01-01',
    });
    expect(page.frontmatter.key).toBe('val');
  });

  test('handles object frontmatter', () => {
    const page = rowToPage({
      id: 1, slug: 'test', type: 'concept', title: 'Test',
      compiled_truth: 'body', timeline: '',
      frontmatter: { key: 'val' },
      content_hash: 'abc', created_at: '2024-01-01', updated_at: '2024-01-01',
    });
    expect(page.frontmatter.key).toBe('val');
  });

  test('creates Date objects', () => {
    const page = rowToPage({
      id: 1, slug: 'test', type: 'concept', title: 'Test',
      compiled_truth: '', timeline: '', frontmatter: '{}',
      content_hash: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    });
    expect(page.created_at).toBeInstanceOf(Date);
    expect(page.updated_at).toBeInstanceOf(Date);
  });
});

describe('rowToChunk', () => {
  test('nulls embedding by default', () => {
    const chunk = rowToChunk({
      id: 1, page_id: 1, chunk_index: 0, chunk_text: 'text',
      chunk_source: 'compiled_truth', embedding: new Float32Array(10),
      model: 'test', token_count: 5, embedded_at: '2024-01-01',
    });
    expect(chunk.embedding).toBeNull();
  });

  test('includes embedding when requested', () => {
    const emb = new Float32Array(10).fill(0.5);
    const chunk = rowToChunk({
      id: 1, page_id: 1, chunk_index: 0, chunk_text: 'text',
      chunk_source: 'compiled_truth', embedding: emb,
      model: 'test', token_count: 5, embedded_at: '2024-01-01',
    }, true);
    expect(chunk.embedding).not.toBeNull();
  });
});

describe('rowToSearchResult', () => {
  test('coerces score to number', () => {
    const r = rowToSearchResult({
      slug: 'test', page_id: 1, title: 'Test', type: 'concept',
      chunk_text: 'text', chunk_source: 'compiled_truth',
      score: '0.95', stale: false,
    });
    expect(typeof r.score).toBe('number');
    expect(r.score).toBe(0.95);
  });
});
