import { describe, it, expect } from 'bun:test';
import { parseExpectedColumns, simplifyColumnDef, detectMissingColumns } from '../src/core/schema-verify.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * Minimal executeRaw-only stub: routes on which information_schema view the
 * SQL targets (schema-verify.ts's two queries never touch anything else).
 * Not a shared test helper — narrow enough that a one-off stub here is
 * clearer than adding a new file for a single caller (gbrain#4421).
 */
function stubEngine(opts: {
  tables: string[];
  columns: Array<{ table_name: string; column_name: string }>;
}): BrainEngine {
  return {
    executeRaw: async (sql: string) => {
      if (sql.includes('information_schema.tables')) {
        return opts.tables.map(table_name => ({ table_name })) as unknown[];
      }
      if (sql.includes('information_schema.columns')) {
        return opts.columns as unknown[];
      }
      throw new Error(`stubEngine.executeRaw: unexpected query: ${sql}`);
    },
  } as unknown as BrainEngine;
}

describe('parseExpectedColumns', () => {
  it('extracts columns from all major tables', () => {
    const columns = parseExpectedColumns();

    // Should find columns from known tables
    const tables = new Set(columns.map(c => c.table));
    expect(tables.has('pages')).toBe(true);
    expect(tables.has('content_chunks')).toBe(true);
    expect(tables.has('links')).toBe(true);
    expect(tables.has('sources')).toBe(true);
    expect(tables.has('minion_jobs')).toBe(true);
    expect(tables.has('files')).toBe(true);

    // Should find specific columns that have historically been missed by PgBouncer
    const columnKeys = new Set(columns.map(c => `${c.table}.${c.column}`));
    expect(columnKeys.has('content_chunks.symbol_type')).toBe(true);
    expect(columnKeys.has('content_chunks.start_line')).toBe(true);
    expect(columnKeys.has('content_chunks.end_line')).toBe(true);
    expect(columnKeys.has('content_chunks.parent_symbol_path')).toBe(true);
    expect(columnKeys.has('content_chunks.doc_comment')).toBe(true);
    expect(columnKeys.has('content_chunks.symbol_name_qualified')).toBe(true);
    expect(columnKeys.has('content_chunks.search_vector')).toBe(true);

    // pages columns
    expect(columnKeys.has('pages.slug')).toBe(true);
    expect(columnKeys.has('pages.source_id')).toBe(true);
    expect(columnKeys.has('pages.page_kind')).toBe(true);
    expect(columnKeys.has('pages.search_vector')).toBe(true);

    // sources columns
    expect(columnKeys.has('sources.chunker_version')).toBe(true);
  });

  it('does not include CONSTRAINT lines as columns', () => {
    const columns = parseExpectedColumns();
    const colNames = columns.map(c => c.column);

    // These are constraint names, not column names
    expect(colNames).not.toContain('constraint');
    expect(colNames).not.toContain('unique');
    expect(colNames).not.toContain('check');
    expect(colNames).not.toContain('primary');
    expect(colNames).not.toContain('foreign');
  });

  it('returns non-empty definitions for all columns', () => {
    const columns = parseExpectedColumns();
    for (const col of columns) {
      expect(col.definition.length).toBeGreaterThan(0);
    }
  });
});

describe('detectMissingColumns', () => {
  it('reports missing when the ledger-expected column is absent from the live table (gbrain#4421 repro)', async () => {
    // Positive control: content_chunks exists (so it's in-scope) but its
    // actual columns don't include embedded_text_hash — the exact drift
    // that made `gbrain doctor` report schema_version=ok while `gbrain
    // import` failed on every file with "column ... does not exist".
    const engine = stubEngine({
      tables: ['content_chunks'],
      columns: [{ table_name: 'content_chunks', column_name: 'chunk_text' }],
    });
    const result = await detectMissingColumns(engine);
    expect(result.missing).toContainEqual({ table: 'content_chunks', column: 'embedded_text_hash' });
  });

  it('reports no missing columns when the live table matches every expected column (negative control)', async () => {
    const expected = parseExpectedColumns();
    const contentChunksCols = expected.filter(c => c.table === 'content_chunks');
    const engine = stubEngine({
      tables: ['content_chunks'],
      columns: contentChunksCols.map(c => ({ table_name: 'content_chunks', column_name: c.column })),
    });
    const result = await detectMissingColumns(engine);
    expect(result.missing).toEqual([]);
    expect(result.checked).toBe(contentChunksCols.length);
  });

  it('skips tables that do not exist yet (fresh-install / not-yet-migrated tables are not false positives)', async () => {
    const engine = stubEngine({ tables: [], columns: [] });
    const result = await detectMissingColumns(engine);
    expect(result.checked).toBe(0);
    expect(result.missing).toEqual([]);
  });
});

describe('simplifyColumnDef', () => {
  it('strips REFERENCES clauses', () => {
    const result = simplifyColumnDef(
      "TEXT NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE"
    );
    expect(result).toBe("TEXT NOT NULL DEFAULT 'default'");
  });

  it('strips CHECK constraints', () => {
    const result = simplifyColumnDef(
      "TEXT NOT NULL DEFAULT 'markdown' CHECK (page_kind IN ('markdown','code'))"
    );
    expect(result).toBe("TEXT NOT NULL DEFAULT 'markdown'");
  });

  it('preserves simple type + NOT NULL + DEFAULT', () => {
    const result = simplifyColumnDef("INTEGER NOT NULL DEFAULT 0");
    expect(result).toBe("INTEGER NOT NULL DEFAULT 0");
  });

  it('strips UNIQUE keyword', () => {
    const result = simplifyColumnDef("TEXT NOT NULL UNIQUE");
    expect(result).toBe("TEXT NOT NULL");
  });

  it('handles complex REFERENCES with ON DELETE and ON UPDATE', () => {
    const result = simplifyColumnDef(
      "INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE"
    );
    expect(result).toBe("INTEGER NOT NULL");
  });

  it('handles bare type', () => {
    const result = simplifyColumnDef("TEXT");
    expect(result).toBe("TEXT");
  });

  it('handles vector type', () => {
    const result = simplifyColumnDef("vector(1536)");
    expect(result).toBe("vector(1536)");
  });

  it('handles TSVECTOR type', () => {
    const result = simplifyColumnDef("TSVECTOR");
    expect(result).toBe("TSVECTOR");
  });

  it('handles array types', () => {
    const result = simplifyColumnDef("TEXT[]");
    expect(result).toBe("TEXT[]");
  });
});
