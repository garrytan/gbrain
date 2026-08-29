/**
 * ops/connectors.ts — the connectors op family (contract-first).
 *
 * Both ops are `localOnly: true`: connector credentials reach the operator's
 * filesystem and provider accounts, so they dispatch only on the local stdio
 * pipe (HTTP/remote callers get the unknown-tool envelope) AND fail-closed at
 * runtime via `ctx.remote`. `connectors_status` never returns a raw secret —
 * only provenance/expiry. Auth itself is CLI-only (interactive/loopback), so it
 * is not an op.
 *
 * Module-private consts; only `connectorsOperations` is exported and spread into
 * `../operations.ts` (never import from operations.ts here — cycle).
 */

import type { Operation } from './contract.ts';
import { OperationError } from './contract.ts';
import { connectorProviders } from '../connectors/registry.ts';
import { credentialMode, resolveCredential } from '../connectors/credentials.ts';
import {
  authErrorAtKey,
  autoSyncKey,
  isTruthy,
  lastSyncAtKey,
  watermarkKey,
} from '../connectors/config-keys.ts';
import { isConnectorProviderName } from '../connectors/registry.ts';
import { runConnectorSync } from '../connectors/sync.ts';

const connectors_status: Operation = {
  name: 'connectors_status',
  description:
    'Per-provider chat-connector status: strategies, whether a credential is ' +
    'present and from where (env/file — never the value), token expiry, ' +
    'last_sync_at, auth_error_at, auto_sync, and the incremental watermark. ' +
    'Local-only; credentials never cross the wire.',
  scope: 'read',
  localOnly: true,
  params: {
    provider: {
      type: 'string',
      description: "Restrict to one provider ('chatgpt'|'claude'). Omit for all.",
    },
  },
  handler: async (ctx, p) => {
    if (ctx.remote === true) {
      throw new OperationError('permission_denied', 'connectors_status is local-only — call via the gbrain CLI.');
    }
    const only = typeof p.provider === 'string' ? p.provider : undefined;
    const providers = connectorProviders.filter((prov) => !only || prov.name === only);
    const out = [];
    for (const prov of providers) {
      const resolved = resolveCredential(prov.name);
      out.push({
        provider: prov.name,
        strategies: prov.strategies,
        spec_target: { id: prov.specTarget.id, status: prov.specTarget.status, verified_at: prov.specTarget.verifiedAt },
        credential: resolved ? { present: true, source: resolved.source, expires_at: resolved.cred.expiresAt ?? null } : { present: false },
        credential_file_mode: credentialMode(prov.name), // 0o600 expected; null if absent
        auto_sync: isTruthy(await ctx.engine.getConfig(autoSyncKey(prov.name))),
        last_sync_at: (await ctx.engine.getConfig(lastSyncAtKey(prov.name))) || null,
        auth_error_at: (await ctx.engine.getConfig(authErrorAtKey(prov.name))) || null,
        watermark_iso: (await ctx.engine.getConfig(watermarkKey(prov.name))) || null,
      });
    }
    return { providers: out };
  },
  cliHints: { name: 'connectors_status', hidden: true },
};

const connector_sync: Operation = {
  name: 'connector_sync',
  description:
    'Sync a chat provider\'s conversation history into the brain: list new ' +
    'conversations since the watermark, fetch them, and ingest as pages under ' +
    'conversations/<provider>/. Incremental by default; --full re-scans. ' +
    'Local-only (uses on-disk credentials).',
  scope: 'write',
  mutating: true,
  localOnly: true,
  params: {
    provider: { type: 'string', required: true, description: "'chatgpt' or 'claude'." },
    full: { type: 'boolean', description: 'Ignore the watermark and re-scan everything.' },
    dry_run: { type: 'boolean', description: 'List-only preview; no fetches, no writes.' },
    limit: { type: 'number', description: 'Max conversations fetched this run.' },
  },
  handler: async (ctx, p) => {
    if (ctx.remote === true) {
      throw new OperationError('permission_denied', 'connector_sync is local-only — call via the gbrain CLI.');
    }
    const provider = typeof p.provider === 'string' ? p.provider : '';
    if (!isConnectorProviderName(provider)) {
      throw new OperationError('invalid_params', `unknown connector provider '${provider}' (expected chatgpt|claude)`);
    }
    return runConnectorSync(ctx.engine, {
      provider,
      sourceId: ctx.sourceId,
      full: p.full === true,
      dryRun: p.dry_run === true,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
    });
  },
  cliHints: { name: 'connector_sync', hidden: true },
};

export const connectorsOperations: Operation[] = [connectors_status, connector_sync];
