/**
 * Migration tests for v0.19.0 schema changes:
 *   v25 — pages.page_kind CHECK constraint
 *   v26 — content_chunks code metadata columns + partial indexes
 *
 * Runs against PGLite (no external Postgres required). Verifies:
 *   - Schema reflects the new columns after initSchema
 *   - Default values are applied (page_kind='markdown' for existing rows)
 *   - CHECK constraint rejects invalid values
 *   - Indexes exist and the partial-WHERE clauses are correct
 *   - MIGRATIONS array shape for v25/v26 matches the expected pattern
 */

import { describe, test, expect } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';

describe('MIGRATIONS array shape', () => {
  test('v25 and v26 are present and ordered', () => {
    const v25 = MIGRATIONS.find(m => m.version === 25);
    const v26 = MIGRATIONS.find(m => m.version === 26);
    expect(v25).toBeDefined();
    expect(v26).toBeDefined();
    expect(v25!.name).toBe('pages_page_kind');
    expect(v26!.name).toBe('content_chunks_code_metadata');
  });

  test('v25 uses NOT VALID + VALIDATE pattern on Postgres', () => {
    const v25 = MIGRATIONS.find(m => m.version === 25)!;
    expect(v25.sqlFor?.postgres).toContain('NOT VALID');
    expect(v25.sqlFor?.postgres).toContain('VALIDATE CONSTRAINT');
  });

  test('v25 PGLite variant uses simple ALTER (no NOT VALID semantics)', () => {
    const v25 = MIGRATIONS.find(m => m.version === 25)!;
    expect(v25.sqlFor?.pglite).toContain('ADD COLUMN IF NOT EXISTS page_kind');
    expect(v25.sqlFor?.pglite).not.toContain('NOT VALID');
  });

  test('v26 adds all five expected columns', () => {
    const v26 = MIGRATIONS.find(m => m.version === 26)!;
    expect(v26.sql).toContain('ADD COLUMN IF NOT EXISTS language');
    expect(v26.sql).toContain('ADD COLUMN IF NOT EXISTS symbol_name');
    expect(v26.sql).toContain('ADD COLUMN IF NOT EXISTS symbol_type');
    expect(v26.sql).toContain('ADD COLUMN IF NOT EXISTS start_line');
    expect(v26.sql).toContain('ADD COLUMN IF NOT EXISTS end_line');
  });

  test('v26 creates partial indexes only for non-null rows', () => {
    const v26 = MIGRATIONS.find(m => m.version === 26)!;
    expect(v26.sql).toContain('idx_chunks_symbol_name');
    expect(v26.sql).toContain('WHERE symbol_name IS NOT NULL');
    expect(v26.sql).toContain('idx_chunks_language');
    expect(v26.sql).toContain('WHERE language IS NOT NULL');
  });
});

describe('PGLite fresh-install schema reflects v0.19.0', () => {
  test('pages.page_kind exists with default markdown', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const { rows } = await (engine as any).db.query(`
        SELECT column_name, data_type, column_default
        FROM information_schema.columns
        WHERE table_name = 'pages' AND column_name = 'page_kind'
      `);
      expect(rows.length).toBe(1);
      expect(rows[0].column_default).toContain("'markdown'");
    } finally {
      await engine.disconnect();
    }
  });

  test('content_chunks has code metadata columns, all nullable', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const { rows } = await (engine as any).db.query(`
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'content_chunks'
          AND column_name IN ('language','symbol_name','symbol_type','start_line','end_line')
        ORDER BY column_name
      `);
      expect(rows.length).toBe(5);
      for (const r of rows) {
        expect(r.is_nullable).toBe('YES');
      }
    } finally {
      await engine.disconnect();
    }
  });

  test('pages.page_kind CHECK constraint rejects invalid values', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      // Direct INSERT that bypasses the putPage enum helper, to hit the CHECK.
      await expect(
        (engine as any).db.query(
          `INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth)
           VALUES ('default', 'test-bad', 'note', 'bogus-kind', 'Bad', '')`,
        ),
      ).rejects.toThrow();
    } finally {
      await engine.disconnect();
    }
  });

  test('putPage writes page_kind=markdown by default', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      await engine.putPage('test/md', {
        type: 'note',
        title: 'Markdown page',
        compiled_truth: 'hello',
      });
      const { rows } = await (engine as any).db.query(
        `SELECT page_kind FROM pages WHERE slug = $1`,
        ['test/md'],
      );
      expect(rows[0].page_kind).toBe('markdown');
    } finally {
      await engine.disconnect();
    }
  });

  test('putPage writes page_kind=code when specified', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      await engine.putPage('test-code-ts', {
        type: 'code',
        page_kind: 'code',
        title: 'src/foo.ts',
        compiled_truth: 'export function foo() {}',
      });
      const { rows } = await (engine as any).db.query(
        `SELECT page_kind FROM pages WHERE slug = $1`,
        ['test-code-ts'],
      );
      expect(rows[0].page_kind).toBe('code');
    } finally {
      await engine.disconnect();
    }
  });

  test('upsertChunks round-trips code metadata', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      await engine.putPage('test-code-foo', {
        type: 'code',
        page_kind: 'code',
        title: 'foo.ts',
        compiled_truth: 'export function foo() {}',
      });
      await engine.upsertChunks('test-code-foo', [
        {
          chunk_index: 0,
          chunk_text: '[TypeScript] foo.ts:1-3 function foo\n\nexport function foo() {}',
          chunk_source: 'compiled_truth',
          language: 'typescript',
          symbol_name: 'foo',
          symbol_type: 'function',
          start_line: 1,
          end_line: 3,
        },
      ]);
      const { rows } = await (engine as any).db.query(`
        SELECT language, symbol_name, symbol_type, start_line, end_line
        FROM content_chunks
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'test-code-foo')
      `);
      expect(rows.length).toBe(1);
      expect(rows[0].language).toBe('typescript');
      expect(rows[0].symbol_name).toBe('foo');
      expect(rows[0].symbol_type).toBe('function');
      expect(rows[0].start_line).toBe(1);
      expect(rows[0].end_line).toBe(3);
    } finally {
      await engine.disconnect();
    }
  });

  test('upsertChunks on markdown chunk leaves code metadata NULL', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      await engine.putPage('test-md', {
        type: 'note',
        title: 'Markdown',
        compiled_truth: 'hello world',
      });
      await engine.upsertChunks('test-md', [
        { chunk_index: 0, chunk_text: 'hello world', chunk_source: 'compiled_truth' },
      ]);
      const { rows } = await (engine as any).db.query(`
        SELECT language, symbol_name, symbol_type, start_line, end_line
        FROM content_chunks
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'test-md')
      `);
      expect(rows[0].language).toBeNull();
      expect(rows[0].symbol_name).toBeNull();
      expect(rows[0].symbol_type).toBeNull();
      expect(rows[0].start_line).toBeNull();
      expect(rows[0].end_line).toBeNull();
    } finally {
      await engine.disconnect();
    }
  });
});
