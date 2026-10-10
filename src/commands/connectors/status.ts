/**
 * commands/connectors/status.ts — `gbrain connectors status [provider] [--json]`.
 *
 * Reuses the `connectors_status` op handler shape via the same helpers, but runs
 * locally (trusted). Never prints the raw cookie/token — only provenance,
 * expiry, and sync state. `unresolved` lists conversations the source has not
 * archived yet (#6387): attempts, next retry, and whether only a `--full` sync
 * can retry them.
 */

import type { BrainEngine } from '../../core/engine.ts';
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { connectorProviders, getConnectorProvider } from '../../core/connectors/registry.ts';
import { credentialMode, resolveCredential } from '../../core/connectors/credentials.ts';
import {
  authErrorAtKey,
  autoSyncKey,
  isTruthy,
  readConnectorState,
  sourceIdKey,
} from '../../core/connectors/config-keys.ts';
import { fullSyncArgv, readFailedLedger } from '../../core/connectors/failed-ledger.ts';

export async function runConnectorStatus(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const only = args.find((a) => !a.startsWith('-'));
  const providers = only
    ? [getConnectorProvider(only)].filter(Boolean)
    : [...connectorProviders];
  if (only && providers.length === 0) {
    console.error(`Unknown provider: ${only}`);
    setCliExitVerdict(1);
    return;
  }

  const rows = [];
  const sourceId = (await engine.getConfig(sourceIdKey())) || 'default';
  for (const prov of providers) {
    if (!prov) continue;
    const resolved = resolveCredential(prov.name);
    const unresolved = Object.entries(await readFailedLedger(engine, prov.name, sourceId)).map(([id, e]) => ({
      id,
      attempts: e.attempts,
      updated_at: e.updatedAt,
      next_retry_at: e.nextRetryAt ?? null,
      needs_full_sync: !!prov.routesByOrg && !e.orgId,
    }));
    rows.push({
      provider: prov.name,
      strategies: prov.strategies,
      spec_target_status: prov.specTarget.status,
      credential_present: !!resolved,
      credential_source: resolved?.source ?? null,
      credential_file_mode: credentialMode(prov.name),
      token_expires_at: resolved?.cred.expiresAt ?? null,
      auto_sync: isTruthy(await engine.getConfig(autoSyncKey(prov.name))),
      source_id: sourceId,
      last_sync_at: await readConnectorState(engine, prov.name, sourceId, 'last_sync_at'),
      auth_error_at: (await engine.getConfig(authErrorAtKey(prov.name))) || null,
      watermark_iso: await readConnectorState(engine, prov.name, sourceId, 'watermark_iso'),
      unresolved,
    });
  }

  if (json) {
    console.log(JSON.stringify({ providers: rows }, null, 2));
    return;
  }

  for (const r of rows) {
    const cred = r.credential_present ? `credential: ${r.credential_source}` : 'no credential';
    const auth = r.auth_error_at ? `  ⚠ auth error at ${r.auth_error_at} (re-auth)` : '';
    console.log(
      `${r.provider}  [${r.spec_target_status}]  ${cred}  auto_sync=${r.auto_sync}\n` +
        `  last_sync: ${r.last_sync_at ?? 'never'}  watermark: ${r.watermark_iso ?? 'none'}${auth}`,
    );
    if (r.unresolved.length === 0) continue;
    const needsFull = r.unresolved.filter((u) => u.needs_full_sync).length;
    console.log(
      `  ⚠ archive incomplete: ${r.unresolved.length} conversation(s) not archived yet; sync retries them automatically` +
        (needsFull ? `; ${needsFull} need one full re-sync (re-downloads the whole history; ask first): ${fullSyncArgv(r.provider, r.source_id).join(' ')}` : ''),
    );
  }
}
