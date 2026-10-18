/**
 * #5575 CEO-22: the deletion-target inventory classifies every text-bearing
 * column. A migration that adds a text, JSON, bytes, array, lexeme or vector
 * column to any table fails here until the column is listed (and its table
 * classified as swept, retained_inactive or out_of_scope with a reason).
 * Also pins the docs promise: AGENTS.md still says never promise physical erasure.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { DELETION_INVENTORY, DELETION_INVENTORY_BY_TABLE } from '../src/core/deletion-inventory.ts';

let engine: PGLiteEngine;
const TEXT_BEARING = ['text', 'varchar', 'bpchar', 'jsonb', 'json', 'bytea', '_text', '_varchar', 'tsvector', 'vector', 'halfvec'];

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

describe('deletion inventory', () => {
  test('every text-bearing column of a fresh schema is classified, and no entry names a missing table', async () => {
    const rows = await engine.executeRaw<{ t: string; c: string }>(`SELECT c.table_name AS t, c.column_name AS c FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema AND t.table_type='BASE TABLE'
      WHERE c.table_schema='public' AND c.udt_name=ANY($1::text[]) ORDER BY 1,2`, [TEXT_BEARING]);
    const missing = rows.filter(r => !DELETION_INVENTORY_BY_TABLE.get(r.t)?.columns.includes(r.c)).map(r => `${r.t}.${r.c}`);
    expect(missing).toEqual([]);
    const tables = new Set(rows.map(r => r.t));
    expect(DELETION_INVENTORY.filter(e => !tables.has(e.table)).map(e => e.table)).toEqual([]);
  });

  test('entries are well-formed: probed stores name probe columns they list; new purge stores are classified', () => {
    for (const entry of DELETION_INVENTORY) {
      expect(['swept', 'retained_inactive', 'out_of_scope']).toContain(entry.class);
      if (entry.class === 'out_of_scope') expect(['probed_reported', 'text_free_ledger', 'secret_material', 'no_memory_text']).toContain(entry.reason);
      if (entry.reason === 'probed_reported') {
        expect(entry.probe?.length).toBeGreaterThan(0);
        for (const col of entry.probe!) expect(entry.columns).toContain(col);
      }
    }
    for (const table of ['fact_purges', 'take_purges', 'page_purges', 'derivation_inputs', 'needs_rederive']) {
      expect(DELETION_INVENTORY_BY_TABLE.get(table)?.reason).toBe('text_free_ledger');
    }
    for (const table of ['facts', 'takes', 'pages', 'content_chunks', 'page_versions', 'persistence_requests']) {
      expect(DELETION_INVENTORY_BY_TABLE.get(table)?.class).toBe('swept');
    }
  });

  test('AGENTS.md still says never promise physical erasure', () => {
    expect(readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8')).toMatch(/never promise physical erasure/i);
  });
});
