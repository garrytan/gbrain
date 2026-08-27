/**
 * commands/connectors/status.ts — `gbrain connectors status [provider] [--json]`.
 *
 * Reuses the `connectors_status` op handler shape via the same helpers, but runs
 * locally (trusted). Never prints the raw cookie/token — only provenance,
 * expiry, and sync state.
 */

import type { BrainEngine } from '../../core/engine.ts';
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { connectorProviders, getConnectorProvider } from '../../core/connectors/registry.ts';
import { credentialMode, resolveCredential } from '../../core/connectors/credentials.ts';
import {
  authErrorAtKey,
  autoSyncKey,
  isTruthy,
  lastSyncAtKey,
  watermarkKey,
} from '../../core/connectors/config-keys.ts';

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
  for (const prov of providers) {
    if (!prov) continue;
    const resolved = resolveCredential(prov.name);
    rows.push({
      provider: prov.name,
      strategies: prov.strategies,
      spec_target_status: prov.specTarget.status,
      credential_present: !!resolved,
      credential_source: resolved?.source ?? null,
      credential_file_mode: credentialMode(prov.name),
      token_expires_at: resolved?.cred.expiresAt ?? null,
      auto_sync: isTruthy(await engine.getConfig(autoSyncKey(prov.name))),
      last_sync_at: (await engine.getConfig(lastSyncAtKey(prov.name))) || null,
      auth_error_at: (await engine.getConfig(authErrorAtKey(prov.name))) || null,
      watermark_iso: (await engine.getConfig(watermarkKey(prov.name))) || null,
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
  }
}
