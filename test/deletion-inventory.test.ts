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
import { DELETION_INVENTORY, DELETION_INVENTORY_BY_TABLE, RUST_STORE_INVENTORY } from '../src/core/deletion-inventory.ts';

let engine: PGLiteEngine;
const TEXT_BEARING = ['text', 'varchar', 'bpchar', 'jsonb', 'json', 'bytea', '_text', '_varchar', 'tsvector', 'vector', 'halfvec'];

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

/** The store's keyspace catalog, read from its source: each tag of KEYSPACES, or each kind for a tag that lists them. */
function rustCatalog(): string[] {
  const read = (p: string) => readFileSync(new URL(`../rust/crates/gbrain-store/src/${p}`, import.meta.url), 'utf8');
  const consts = new Map<string, string>();
  for (const m of read('keys.rs').matchAll(/pub const (\w+): u8 = (?:b'(.)'|(0x[0-9A-Fa-f]+));/g)) consts.set(m[1]!, m[2] ?? m[3]!);
  const src = read('keyspaces.rs').replace(/\s+/g, ' ');
  const kindLists = new Map<string, string[]>();
  for (const m of src.matchAll(/pub const (\w+_KINDS): &\[KeyKind\] = &\[(.*?)\];/g)) {
    kindLists.set(m[1]!, [...m[2]!.matchAll(/k\( ?(0x[0-9A-Fa-f]+|keys::\w+), ?"(\w+)",? ?\)/g)]
      .map(k => `${Number(k[1]!.startsWith('keys::') ? consts.get(k[1]!.slice(6)) : k[1])}/${k[2]}`));
  }
  const body = src.slice(src.indexOf('pub const KEYSPACES'));
  const out: string[] = [];
  for (const m of body.matchAll(/tag: keys::(\w+), family: "(\w+)".*?kinds: (\w+_KINDS)|ks\( ?keys::(\w+), ?"(\w+)"/g)) {
    const tag = consts.get((m[1] ?? m[4])!)!;
    if (m[3]) for (const kind of kindLists.get(m[3])!) out.push(`${tag}/${kind}`);
    else out.push(`${tag}//${m[5]}`);
  }
  return out;
}

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

  test('every Rust store keyspace and record kind has one entry, A 0x06 to 0x0A included', () => {
    const catalog = rustCatalog();
    expect(catalog.length).toBeGreaterThan(70);
    expect(RUST_STORE_INVENTORY.map(e => `${e.tag}/${e.kind ?? ''}/${e.name}`)).toEqual(catalog);
    expect(RUST_STORE_INVENTORY.filter(e => e.tag === 'A' && e.kind! >= 0x06).map(e => e.tables)).toEqual(
      [['take_horizons'], ['take_nudge_log'], ['take_proposals'], ['take_proposals'], ['extract_rollup_7d']]);
  });

  test('each Rust entry names inventory tables, or says why it has none', () => {
    for (const e of RUST_STORE_INVENTORY) {
      const label = `${e.tag}/${e.kind ?? ''}`;
      expect({ label, unknown: e.tables.filter(t => !DELETION_INVENTORY_BY_TABLE.has(t)) }).toEqual({ label, unknown: [] });
      expect({ label, tablesOrReason: e.tables.length > 0 !== (e.none !== undefined) }).toEqual({ label, tablesOrReason: true });
      if (e.none) expect(['probed_reported', 'text_free_ledger', 'secret_material', 'no_memory_text']).toContain(e.none.reason);
    }
    // The stores purge sweeps on SQL keep a Rust keyspace each.
    // M also keeps each page's sanitized search timeline text (pages.rs, page_search_timeline), so it shares the pages class.
    expect(RUST_STORE_INVENTORY.find(e => e.tag === 'M')?.tables).toContain('pages');
    const kept = new Set(RUST_STORE_INVENTORY.flatMap(e => e.tables));
    for (const table of ['facts', 'takes', 'pages', 'content_chunks', 'page_versions', 'persistence_requests']) expect(kept.has(table)).toBe(true);
  });

  test('AGENTS.md still says never promise physical erasure', () => {
    expect(readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8')).toMatch(/never promise physical erasure/i);
  });
});
