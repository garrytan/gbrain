/**
 * The three catalog reads of the engine graduation inventory (persistence/graduation-inventory.ts): the relation
 * set, the recorded schema version and the foreign keys. Each ran through executeRaw; SQL once for both engines.
 *
 * The Rust engine answers from the store's own facts instead (rust-engine/store-members/graduation-catalog.ts): its
 * keyspace list for the relation set, the schema version it was opened with, and a named refusal for the foreign
 * keys, because the store checks each family's references in code and keeps no list of them.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One relation of the current schema: tables, partitioned and foreign tables are `table`, views and matviews `view`. */
export interface CatalogRelation { relation: string; kind: 'table' | 'view' }

/** One top-level key tag of the Rust store (rust/crates/gbrain-store/src/keyspaces.rs). */
export interface CatalogKeyspace {
  tag: string;
  family: string;
  records: string;
  kinds: Array<{ kind: number; name: string }>;
}

/** What a brain's store is made of: SQL relations, or the Rust store's keyspaces. Never an empty stand-in. */
export type CatalogRelations =
  | { store: 'sql'; relations: CatalogRelation[] }
  | { store: 'keyspaces'; formatVersion: number; keyspaces: CatalogKeyspace[] };

/** One foreign key constraint of the current schema, with its columns in key order. */
export interface CatalogForeignKey { name: string; child: string; parent: string; childColumns: string[]; parentColumns: string[] }

/** Tables, partitioned tables, views, materialized views and foreign tables in the current schema, by name. */
export async function listCatalogRelations(engine: Raw): Promise<CatalogRelations> {
  const rows = await engine.executeRaw<{ relname: string; relkind: string }>(`SELECT c.relname, c.relkind::text AS relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
    ORDER BY c.relname COLLATE "C"`);
  return { store: 'sql', relations: rows.map(r => ({ relation: r.relname, kind: r.relkind === 'v' || r.relkind === 'm' ? 'view' : 'table' })) };
}

/** The schema version the brain records (`config.version`); null when it records none. */
export async function readCatalogSchemaVersion(engine: Raw): Promise<number | null> {
  const [row] = await engine.executeRaw<{ value: string }>("SELECT value FROM config WHERE key='version'");
  return row ? Number(row.value) : null;
}

/** Every foreign key constraint in the current schema, by child relation then name. */
export async function listCatalogForeignKeys(engine: Raw): Promise<CatalogForeignKey[]> {
  const rows = await engine.executeRaw<{ name: string; child: string; parent: string; child_cols: string; parent_cols: string }>(`SELECT c.conname AS name,
      ch.relname AS child, pa.relname AS parent,
      (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n)::text AS child_cols,
      (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n)::text AS parent_cols
    FROM pg_constraint c JOIN pg_class ch ON ch.oid=c.conrelid JOIN pg_class pa ON pa.oid=c.confrelid
    JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE c.contype='f' AND n.nspname=current_schema()
    ORDER BY ch.relname COLLATE "C", c.conname COLLATE "C"`);
  return rows.map(r => ({ name: r.name, child: r.child, parent: r.parent, childColumns: JSON.parse(r.child_cols), parentColumns: JSON.parse(r.parent_cols) }));
}
