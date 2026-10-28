/**
 * The connector source kinds (`sources.config.kind`), with no imports so schema
 * migrations and SQL builders can use them without loading a connector. Every
 * kind list and kind branch reads these: a literal kind list elsewhere fails
 * test/connector-kind-routing.test.ts.
 */
export type ConnectorKind = 'google' | 'github' | 'meetings';

export const CONNECTOR_SOURCE_KINDS: readonly ConnectorKind[] = ['google', 'github', 'meetings'];
/** A connector source kind (`sources.config.kind`). */
export function isConnectorSourceKind(kind: unknown): kind is ConnectorKind { return CONNECTOR_SOURCE_KINDS.includes(kind as ConnectorKind); }
/** The `sources.config` key holding a connector source's directory. */
export function connectorDirKey(kind: ConnectorKind): string {
  switch (kind) {
    case 'google': return 'g_dir';
    case 'github': return 'gh_dir';
    case 'meetings': return 'm_dir';
    default: { const unhandled: never = kind; throw new Error(`Unhandled connector kind: ${String(unhandled)}`); }
  }
}
/** The connector kinds as a quoted SQL list (`'google','github','meetings'`): every SQL filter on connector kinds interpolates it. */
export const CONNECTOR_KINDS_SQL = CONNECTOR_SOURCE_KINDS.map(kind => `'${kind}'`).join(',');
