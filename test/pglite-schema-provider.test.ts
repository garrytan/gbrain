/**
 * FORK: Tests for getPGLiteSchema() — the provider-aware schema factory.
 *
 * Pure function: no DB, no network, no mocks needed.
 */

import { describe, it, expect } from 'bun:test';
import { getPGLiteSchema, PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';

describe('getPGLiteSchema', () => {
  it('defaults to OpenAI dimensions and model', () => {
    const sql = getPGLiteSchema();
    expect(sql).toContain('vector(1536)');
    expect(sql).toContain("'embedding_model', 'text-embedding-3-large'");
    expect(sql).toContain("'embedding_dimensions', '1536'");
  });

  it('substitutes Gemini model and 768 dims', () => {
    const sql = getPGLiteSchema(768, 'gemini-embedding-001');
    expect(sql).toContain('vector(768)');
    // Config row values replaced
    expect(sql).toContain("'embedding_model', 'gemini-embedding-001'");
    expect(sql).toContain("'embedding_dimensions', '768'");
    // Vector column dimension replaced
    expect(sql).not.toContain('vector(1536)');
    // Config row dimension value replaced
    expect(sql).not.toContain("'embedding_dimensions', '1536'");
    // Config row model value replaced (note: column DEFAULT 'text-embedding-3-large' is separate and stays)
    expect(sql).not.toContain("'embedding_model', 'text-embedding-3-large'");
  });

  it('substitutes OpenAI-compat 1536-dim Gemini (no ALTER TABLE needed)', () => {
    const sql = getPGLiteSchema(1536, 'gemini-embedding-001');
    // Dims stay at 1536 — no schema change needed
    expect(sql).toContain('vector(1536)');
    // Config row model changes to Gemini
    expect(sql).toContain("'embedding_model', 'gemini-embedding-001'");
    expect(sql).toContain("'embedding_dimensions', '1536'");
    // Config row model value replaced
    expect(sql).not.toContain("'embedding_model', 'text-embedding-3-large'");
  });

  it('substitutes custom dim (256)', () => {
    const sql = getPGLiteSchema(256, 'gemini-embedding-001');
    expect(sql).toContain('vector(256)');
    expect(sql).toContain("'embedding_dimensions', '256'");
    expect(sql).not.toContain('vector(1536)');
    expect(sql).not.toContain("'embedding_dimensions', '1536'");
  });

  it('substitutes all 3 replacement targets', () => {
    const sql = getPGLiteSchema(3072, 'gemini-embedding-001');
    // All 3 targets replaced
    expect(sql).toContain('vector(3072)');
    expect(sql).toContain("'embedding_model', 'gemini-embedding-001'");
    expect(sql).toContain("'embedding_dimensions', '3072'");
    // Old config row values gone
    expect(sql).not.toContain('vector(1536)');
    expect(sql).not.toContain("'embedding_model', 'text-embedding-3-large'");
    expect(sql).not.toContain("'embedding_dimensions', '1536'");
  });

  it('base SQL is unchanged (only the 3 targets are swapped)', () => {
    const dflt = getPGLiteSchema(1536, 'text-embedding-3-large');
    expect(dflt).toBe(PGLITE_SCHEMA_SQL);
  });
});
