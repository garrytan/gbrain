/**
 * v0.21.0 Cathedral II — Layer 1 Foundation migration tests.
 *
 * Asserts the v27 migration ships the expected DDL so downstream layers
 * (A1 edge extractor, A3 parent-scope, 1b chunk-grain FTS, SP-1 chunker_version
 * gate, etc.) have the columns + tables + trigger they depend on.
 *
 * Structural-only: runs against the MIGRATIONS registry without executing SQL.
 * E2E migration-application is covered by test/e2e/cathedral-ii.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { MIGRATIONS } from '../src/core/migrate.ts';

describe('v0.21.0 Cathedral II — Layer 1 Foundation', () => {
  const v27 = MIGRATIONS.find(m => m.version === 27);

  test('v27 migration exists in registry', () => {
    expect(v27).toBeDefined();
    expect(v27?.name).toBe('cathedral_ii_foundation');
  });

  test('adds parent_symbol_path column to content_chunks (A3)', () => {
    expect(v27!.sql).toMatch(/ADD COLUMN IF NOT EXISTS parent_symbol_path TEXT\[\]/);
  });

  test('adds doc_comment column to content_chunks (A4)', () => {
    expect(v27!.sql).toMatch(/ADD COLUMN IF NOT EXISTS doc_comment TEXT/);
  });

  test('adds symbol_name_qualified column to content_chunks (A1)', () => {
    expect(v27!.sql).toMatch(/ADD COLUMN IF NOT EXISTS symbol_name_qualified TEXT/);
  });

  test('adds search_vector column to content_chunks (1b chunk-grain FTS)', () => {
    expect(v27!.sql).toMatch(/ADD COLUMN IF NOT EXISTS search_vector TSVECTOR/);
  });

  test('creates GIN index on content_chunks.search_vector', () => {
    expect(v27!.sql).toMatch(/CREATE INDEX.*idx_chunks_search_vector.*GIN\(search_vector\)/s);
  });

  test('adds sources.chunker_version column (SP-1 fix)', () => {
    expect(v27!.sql).toMatch(/ALTER TABLE sources/);
    expect(v27!.sql).toMatch(/ADD COLUMN IF NOT EXISTS chunker_version TEXT/);
  });

  test('creates code_edges_chunk table with FK CASCADE (SP-2 chunk lifecycle)', () => {
    expect(v27!.sql).toMatch(/CREATE TABLE IF NOT EXISTS code_edges_chunk/);
    expect(v27!.sql).toMatch(/from_chunk_id.*REFERENCES content_chunks\(id\) ON DELETE CASCADE/s);
    expect(v27!.sql).toMatch(/to_chunk_id.*REFERENCES content_chunks\(id\) ON DELETE CASCADE/s);
  });

  test('code_edges_chunk has UNIQUE constraint on (from_chunk_id, to_chunk_id, edge_type)', () => {
    expect(v27!.sql).toMatch(/UNIQUE \(from_chunk_id, to_chunk_id, edge_type\)/);
  });

  test('code_edges_chunk.source_id is TEXT matching sources.id (codex F4)', () => {
    // Verify source_id is TEXT type (not UUID) and FKs to sources(id) CASCADE.
    expect(v27!.sql).toMatch(/source_id\s+TEXT REFERENCES sources\(id\) ON DELETE CASCADE/);
  });

  test('creates code_edges_symbol table for unresolved refs (codex 1.3b UNION-on-read)', () => {
    expect(v27!.sql).toMatch(/CREATE TABLE IF NOT EXISTS code_edges_symbol/);
    // Note: unresolved edges have no to_chunk_id column — only qualified name.
    expect(v27!.sql).toMatch(/code_edges_symbol.*to_symbol_qualified.*TEXT NOT NULL/s);
  });

  test('code_edges_symbol UNIQUE on (from_chunk_id, to_symbol_qualified, edge_type)', () => {
    expect(v27!.sql).toMatch(/UNIQUE \(from_chunk_id, to_symbol_qualified, edge_type\)/);
  });

  test('creates chunk_search_vector trigger function (plpgsql)', () => {
    expect(v27!.sql).toMatch(/CREATE OR REPLACE FUNCTION update_chunk_search_vector/);
    expect(v27!.sql).toMatch(/LANGUAGE plpgsql/);
  });

  test('trigger weights doc_comment + symbol_name_qualified at A, chunk_text at B', () => {
    // Doc-comment weight A (above body) means NL queries hit docstrings first.
    expect(v27!.sql).toMatch(/setweight\(to_tsvector\('english', COALESCE\(NEW\.doc_comment, ''\)\), 'A'\)/);
    expect(v27!.sql).toMatch(/setweight\(to_tsvector\('english', COALESCE\(NEW\.symbol_name_qualified, ''\)\), 'A'\)/);
    expect(v27!.sql).toMatch(/setweight\(to_tsvector\('english', COALESCE\(NEW\.chunk_text, ''\)\), 'B'\)/);
  });

  test('trigger fires BEFORE INSERT OR UPDATE OF specific columns (not every update)', () => {
    // BEFORE INSERT OR UPDATE OF <specific columns> is the efficient shape:
    // embedding refreshes don't re-run the FTS vector build.
    expect(v27!.sql).toMatch(/BEFORE INSERT OR UPDATE OF chunk_text, doc_comment, symbol_name_qualified/);
    expect(v27!.sql).toMatch(/FOR EACH ROW EXECUTE FUNCTION update_chunk_search_vector/);
  });

  test('migration is idempotent (uses IF NOT EXISTS + DROP IF EXISTS)', () => {
    // Column adds use IF NOT EXISTS.
    expect(v27!.sql).toMatch(/ADD COLUMN IF NOT EXISTS parent_symbol_path/);
    // Table creates use IF NOT EXISTS.
    expect(v27!.sql).toMatch(/CREATE TABLE IF NOT EXISTS code_edges_chunk/);
    // Trigger uses DROP IF EXISTS + CREATE.
    expect(v27!.sql).toMatch(/DROP TRIGGER IF EXISTS chunk_search_vector_trigger/);
  });

  test('Cathedral II Layer 1 registers migration v27 at or below the current head', () => {
    // Cathedral II adds additional migrations in later layers (v28 for the
    // Layer 3 chunk-FTS backfill, etc.). Assert v27 exists and is the
    // foundation migration, but don't pin "v27 is the latest" since the
    // MIGRATIONS array grows as Cathedral II layers land.
    const v27 = MIGRATIONS.find(m => m.version === 27);
    expect(v27).toBeDefined();
    expect(v27!.name).toBe('cathedral_ii_foundation');
    const maxVersion = Math.max(...MIGRATIONS.map(m => m.version));
    expect(maxVersion).toBeGreaterThanOrEqual(27);
  });
});
