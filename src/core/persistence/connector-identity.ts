/**
 * Stable connector identity (#5686).
 *
 * A connector checkpoint, its admission `configHash`, the publication change
 * check and the attachments preview key all derive from the PARSED connector
 * config, never from raw `sources.config`: the cycle writes bookkeeping stamps
 * (`last_source_cycle_at`, `last_full_cycle_at`) into that blob after every
 * run, and other writers pin keys there too. The digest covers every parsed
 * leaf except an explicit list of credential-delivery fields, so a field added
 * to a parser later joins the identity by default. The resolved account a
 * credential belongs to is checked separately against the connector state
 * pin (`connector-state.ts`), because excluded credential fields can change
 * which account a sweep reads.
 */
import { digest } from './digest.ts';
import { parseGoogleSourceConfig } from '../google/source-config.ts';
import { parseGitHubSourceConfig } from '../github-source-config.ts';
import type { GitHubSourceConfig } from '../github-source.ts';
import type { GoogleSourceConfig } from '../google/types.ts';

export type ConnectorKind = 'google' | 'github';

/** A managed Google or GitHub connector source (`sources.config.kind`). */
export function isConnectorSourceKind(kind: unknown): kind is ConnectorKind { return kind === 'google' || kind === 'github'; }
export type ConnectorConfig = GoogleSourceConfig | GitHubSourceConfig;
type LeafClass = 'identity' | 'excluded';
type Rule = LeafClass | ((config: GitHubSourceConfig) => LeafClass);

const underAuto = (config: GitHubSourceConfig): LeafClass => config.scope === 'auto' ? 'identity' : 'excluded';

/**
 * Every leaf each parser returns, classified. The unit test enumerates parser
 * output and fails on a leaf missing here; an unlisted leaf still joins the
 * identity at runtime, never the exclusion list.
 */
export const CONNECTOR_LEAF_RULES: { google: Record<string, LeafClass>; github: Record<string, Rule> } = {
  google: {
    account: 'identity', services: 'identity', historyDays: 'identity', calendarId: 'identity', dir: 'identity',
    access: 'excluded', tokenCommand: 'excluded', tokenEnv: 'excluded',
  },
  github: {
    scope: 'identity', repos: 'identity', dir: 'identity',
    // Under `scope: auto` the repo set is whatever the authenticated identity can see.
    tokenEnv: config => config.scope === 'auto' && !config.app ? 'identity' : 'excluded',
    app: underAuto, 'app.appId': underAuto, 'app.installId': underAuto, 'app.pemPath': 'excluded',
  },
};

/** Leaf paths of a parsed config: nested objects flatten to dotted keys; arrays and null are leaves. */
export function connectorConfigLeaves(config: object): Record<string, unknown> {
  const leaves: Record<string, unknown> = {};
  const walk = (value: Record<string, unknown>, prefix: string) => {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (child !== null && typeof child === 'object' && !Array.isArray(child)) walk(child as Record<string, unknown>, path);
      else leaves[path] = child;
    }
  };
  walk(config as Record<string, unknown>, '');
  return leaves;
}

export function classifyConnectorLeaf(kind: ConnectorKind, config: ConnectorConfig, path: string): LeafClass | undefined {
  const rule = (CONNECTOR_LEAF_RULES[kind] as Record<string, Rule>)[path];
  return typeof rule === 'function' ? rule(config as GitHubSourceConfig) : rule;
}

/** The identity-bearing leaves, canonicalized: set-valued lists sorted and de-duplicated. */
export function connectorIdentityLeaves(kind: ConnectorKind, config: ConnectorConfig): Record<string, unknown> {
  const identity: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(connectorConfigLeaves(config))) {
    if (classifyConnectorLeaf(kind, config, path) === 'excluded') continue;
    identity[path] = (path === 'services' || path === 'repos') && Array.isArray(value) ? [...new Set(value.map(String))].sort() : value;
  }
  return identity;
}

export interface ConnectorIdentity { kind: ConnectorKind; config: ConnectorConfig; digest: string }

export function parseConnectorConfig(kind: ConnectorKind, raw: Record<string, unknown>, localPath: string | null): ConnectorConfig {
  return kind === 'google' ? parseGoogleSourceConfig(raw, localPath ?? '') : parseGitHubSourceConfig(raw, localPath ?? '');
}

/** The parsed connector config plus its identity digest. The raw config is never an identity. */
export function connectorIdentity(kind: ConnectorKind, raw: Record<string, unknown>, localPath: string | null): ConnectorIdentity {
  const config = parseConnectorConfig(kind, raw, localPath);
  return { kind, config, digest: digest({ kind, identity: connectorIdentityLeaves(kind, config) }) };
}

export function connectorCheckpointKey(sourceId: string, incarnation: string, identity: Pick<ConnectorIdentity, 'kind' | 'digest'>): string {
  return digest({ sourceId, incarnation, connector: identity.kind, identity: identity.digest });
}

/** Legacy and current connector intent namespaces; every filter on connector kinds uses these. */
export const CONNECTOR_INTENT_PREFIXES = ['connector_v2_', 'managed_connector_'] as const;
export function isConnectorIntentKind(kind: unknown): boolean {
  return typeof kind === 'string' && CONNECTOR_INTENT_PREFIXES.some(prefix => kind.startsWith(prefix));
}
/** SQL predicate over a `persistence_requests` alias accepting both connector namespaces. */
export function connectorIntentSql(alias = 'persistence_requests'): string {
  return `(${alias}.intent->>'kind' LIKE 'connector\\_v2\\_%' OR ${alias}.intent->>'kind' LIKE 'managed\\_connector\\_%')`;
}
/** Checkpoint receipts in either namespace (the migration reads legacy ones). */
export const CONNECTOR_CHECKPOINT_KINDS = ['connector_v2_checkpoint', 'managed_connector_checkpoint'] as const;
