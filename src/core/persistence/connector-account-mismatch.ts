/**
 * #6803: a connector source whose credential resolves to a different account
 * than its pin (`connector_account_changed`) cannot import anything until the
 * operator repins it. The refused run records the mismatch in the source's
 * connector state (`account_mismatch`); autopilot reads it here and classifies
 * the source unavailable-path instead of dispatching a sync and a cycle for it
 * every interval. A sync that passes the account check clears the record, and
 * a changed connector config re-arms the source for one more automatic try.
 */
import type { BrainEngine } from '../engine.ts';
import { digest } from './digest.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { connectorIdentity, isConnectorSourceKind, type ConnectorKind } from './connector-identity.ts';
import { CONNECTOR_STATE_OP, connectorStateKey, type ConnectorAccountMismatch } from './connector-state.ts';

/**
 * #6803: the whole parsed connector config, credential settings included
 * (`g_token_command`, `gh_token_env`, ...), unlike the identity digest. A
 * change to it is an operator repin attempt, so autopilot tries the source once more.
 */
export function connectorConfigDigest(config: object): string {
  return digest(config);
}

/**
 * #6803: active connector sources whose last sync refused with
 * `connector_account_changed` and whose connector config has not changed
 * since. Autopilot classifies them unavailable-path until the operator repins
 * (`gbrain sync --source <id>` passes the account check), changes the config,
 * or archives the source.
 */
export async function connectorAccountMismatches(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Map<string, ConnectorAccountMismatch>> {
  const sources = await engine.executeRaw<{ id: string; incarnation: string; local_path: string | null; config: unknown }>(
    'SELECT id,incarnation::text AS incarnation,local_path,config FROM sources WHERE archived IS NOT TRUE');
  const keyed = new Map(sources.filter(s => isConnectorSourceKind(parseSourceConfig(s.config).kind))
    .map(s => [connectorStateKey(s.id, s.incarnation), s]));
  const found = new Map<string, ConnectorAccountMismatch>();
  if (keyed.size === 0) return found;
  const rows = await engine.executeRaw<{ fingerprint: string; mismatch: ConnectorAccountMismatch }>(`SELECT fingerprint, completed_keys->0->'account_mismatch' AS mismatch
    FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[]) AND jsonb_typeof(completed_keys->0->'account_mismatch')='object'`,
  [CONNECTOR_STATE_OP, [...keyed.keys()]]);
  for (const row of rows) {
    const source = keyed.get(row.fingerprint)!;
    const raw = parseSourceConfig(source.config);
    let current: string;
    try { current = connectorConfigDigest(connectorIdentity(raw.kind as ConnectorKind, raw, source.local_path).config); } catch { continue; }
    if (row.mismatch.config_digest === current) found.set(source.id, row.mismatch);
  }
  return found;
}

/** #6803: the dispatch line for a source skipped while its credential resolves to another account. */
export function connectorAccountMismatchSkipWarning(sourceId: string, mismatch: Pick<ConnectorAccountMismatch, 'at' | 'detail'>): string {
  const what = mismatch.detail === 'account_unresolved' ? 'its credential resolves to no account' : 'its credential resolves to a different account than the source is pinned to';
  return `[dispatch] ${sourceId}: connector source skipped (unavailable): ${what} (connector_account_changed since ${mismatch.at}). `
    + `Restore the credential for the pinned account, then run: gbrain sync --source ${sourceId}. For a deliberate account change, add a new source and archive this one: gbrain sources archive ${sourceId}. `
    + `Autopilot retries it by itself only after its connector config changes.`;
}
