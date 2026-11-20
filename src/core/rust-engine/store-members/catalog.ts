/**
 * Catalog probes (docs/designs/RUST_ENGINE_INTERFACES.md, "catalog probes (core)"): the doctor checks, migration
 * probes and session settings that ask Postgres about itself. The Rust store keeps no Postgres catalog, so each probe
 * either gets a fixed answer or answers from the capability of the family that owns the table it asks about.
 *
 * Each site keeps its SQL and asks `answersFromCatalog(engine)` first. That is true only for an engine that reports a
 * capability set without `raw_sql` (the Rust engine). An object without a capability set, such as a transaction handle
 * or a test fake, counts as raw SQL, so PGLite and Postgres run the same SQL as before.
 *
 * Nothing here is a store member: the answers need no store call. The module imports types only.
 */
import type { Capability, EngineCapabilities } from '../../engine-capabilities.ts';

/** True when the engine answers catalog probes from this module instead of running Postgres catalog SQL. */
export function answersFromCatalog(engine: object | null | undefined): boolean {
  const caps = (engine as { capabilities?: EngineCapabilities } | null | undefined)?.capabilities;
  return caps instanceof Set && !caps.has('raw_sql');
}

/** Whether the engine reports `capability`. False for an engine with no capability set. */
export function reportsCapability(engine: object, capability: Capability): boolean {
  const caps = (engine as { capabilities?: EngineCapabilities }).capabilities;
  return caps instanceof Set && caps.has(capability);
}

/**
 * The family capability that owns each table a `to_regclass` / `information_schema.tables` probe asks about. A table
 * whose family has no capability yet (the write gate tables of the proposed `trust` family) maps to null: the probe
 * answers "absent" until that family lands and reports one.
 */
export const TABLE_CAPABILITY: Readonly<Record<string, Capability | null>> = {
  link_relationships: 'links',
  links: 'links',
  facts: 'facts',
  fact_relink_attempts: 'facts',
  persistence_requests: 'persistence_journal',
  persistence_worktrees: 'persistence_journal',
  write_gate_holds: null,
  write_gate_receipts: null,
  mcp_request_log_rollup: null,
};

/**
 * A family table "exists" on Rust only when its family reports its capability. The table name may carry a `public.`
 * schema prefix. A table this map does not name is absent: a probe never gets a "present" it did not earn.
 */
export function catalogTableExists(engine: object, table: string): boolean {
  const name = table.replace(/^public\./, '');
  const capability = TABLE_CAPABILITY[name];
  return capability != null && reportsCapability(engine, capability);
}

/** Why a doctor check about Postgres internals is skipped on this engine. */
export type CatalogSkipReason =
  | 'no_sql_functions'
  | 'no_relation_catalog'
  | 'no_planner'
  | 'no_jsonb_storage'
  | 'no_row_policies'
  | 'no_server_settings'
  | 'no_relation_sizes'
  | 'store_keyed_pages'
  | 'utf8_store'
  | 'capability_not_reported';

const SKIP_TEXT: Readonly<Record<CatalogSkipReason, string>> = {
  no_sql_functions: 'the Rust store has no SQL functions',
  no_relation_catalog: 'the Rust store has no Postgres catalog, and the relation catalog (rust/catalog/relations.json) does not exist yet',
  no_planner: 'the Rust store has no query planner or Postgres indexes',
  no_jsonb_storage: 'the Rust store keeps no Postgres JSONB columns',
  no_row_policies: 'the Rust store has no row policies or event triggers',
  no_server_settings: 'the Rust store has no Postgres server settings',
  no_relation_sizes: 'the Rust store reports no table sizes, so the size is not measured',
  store_keyed_pages: 'the Rust store keys every page by source and slug itself, so there is no upsert index to check',
  utf8_store: 'the Rust store keeps all text as UTF-8 and has no server encoding',
  capability_not_reported: 'the engine does not report the capability this check needs',
};

/** The doctor check a skipped catalog probe reports: the PGLite skip shape (keyword-plan, vector-plan), never a pass. */
export interface CatalogSkipCheck {
  name: string;
  status: 'ok';
  message: string;
  details: { outcome: 'skipped'; reason: CatalogSkipReason; capability?: Capability };
}

export function catalogSkipCheck(name: string, reason: CatalogSkipReason, capability?: Capability): CatalogSkipCheck {
  const why = capability ? `${SKIP_TEXT[reason]} (${capability})` : SKIP_TEXT[reason];
  return {
    name,
    status: 'ok',
    message: `Skipped: not applicable on this engine; ${why}.`,
    details: capability ? { outcome: 'skipped', reason, capability } : { outcome: 'skipped', reason },
  };
}
