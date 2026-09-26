/**
 * How each API connector source (Google/GitHub) holds its pages.
 *
 * - `connector_database`: managed persistence, no worktree binding. The sync
 *   imports straight into the database (connector-sync.ts beginConnectorSync);
 *   any directory left at local_path is a pre-activation cache, not the pages'
 *   canonical copy.
 * - `bound`: managed persistence with a binding. The connector publishes
 *   canonical files under the bound root and keeps the ordinary repository
 *   contract.
 * - `unmanaged`: persistence is off. The sweep materializes a Markdown cache
 *   of the provider API under local_path.
 *
 * File-lane audits (doctor db_only pages, backup coverage) read this instead
 * of inferring DB-only storage from which files happen to exist.
 */
import { getWorktreeBinding, managedPersistenceEnabled } from './ownership.ts';
import type { SqlEngine } from './model.ts';

export type ConnectorKind = 'google' | 'github';
export type ConnectorAuthority = 'connector_database' | 'bound' | 'unmanaged';

export function isConnectorKind(kind: unknown): kind is ConnectorKind {
  return kind === 'google' || kind === 'github';
}

/** Authority of each connector among the given sources; non-connectors are absent. */
export async function connectorAuthorities(
  engine: SqlEngine,
  sources: ReadonlyArray<{ id: string; kind: unknown }>,
): Promise<Map<string, ConnectorAuthority>> {
  const out = new Map<string, ConnectorAuthority>();
  const connectors = sources.filter(s => isConnectorKind(s.kind));
  if (connectors.length === 0) return out;
  const managed = await managedPersistenceEnabled(engine);
  for (const source of connectors) {
    // hostId null: only the source's binding row matters, not this host's path.
    out.set(source.id, !managed ? 'unmanaged'
      : await getWorktreeBinding(engine, source.id, null) ? 'bound' : 'connector_database');
  }
  return out;
}
