/**
 * The engine graduation inventory's catalog reads on the Rust engine (engine-sql/graduation-catalog.ts holds the SQL
 * engines' statements). The store has no SQL relations, so each read answers from the store's own facts
 * (rust/docs/store/keyspaces.md): its keyspace list, the schema version it was opened with, and a named refusal for
 * the foreign keys, because each family checks its references in code and the store keeps no list of them.
 *
 * Export only BrainEngine members from this file.
 */
import type { CatalogForeignKey, CatalogKeyspace, CatalogRelations } from '../../engine-sql/graduation-catalog.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

interface StoreKeyspaceCatalog { format_version: number; keyspaces: CatalogKeyspace[] }

export const listCatalogRelations: StoreMember<[], CatalogRelations> = async (brain) => {
  const catalog = await storeCall({ member: 'listCatalogRelations' }, () => brain.keyspaces()) as StoreKeyspaceCatalog;
  return { store: 'keyspaces', formatVersion: catalog.format_version, keyspaces: catalog.keyspaces };
};

export const readCatalogSchemaVersion: StoreMember<[], number | null> = async (brain) => {
  const info = await storeCall({ member: 'readCatalogSchemaVersion' }, () => brain.info()) as { schema_version?: number | null };
  return typeof info.schema_version === 'number' ? info.schema_version : null;
};

export const listCatalogForeignKeys: StoreMember<[], CatalogForeignKey[]> = async () =>
  refuseMember('listCatalogForeignKeys', 'the store checks each family\'s references in code and keeps no list of them');
