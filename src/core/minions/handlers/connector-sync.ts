/**
 * handlers/connector-sync.ts — the `connector-sync` minion handler.
 *
 * Copies the embed-backfill skeleton: strict param parse, per-provider
 * single-flight DB lock (already_in_progress on contention, never a throw),
 * signal threading, progress → job.updateProgress, terminal auth/forbidden
 * returned (NOT thrown — a retry can't fix a dead cookie), lock released in
 * finally. Registered via registerBuiltinJob (in GATEWAY_REFRESH_JOB_NAMES):
 * the fetch+ingest itself needs no LLM, but the PGLite embed kickoff calls
 * runEmbedCore inline (the embedding gateway), so the pre-handler gateway
 * refresh matters on a worker booted before `config set`.
 */

import { tryAcquireDbLock } from '../../db-lock.ts';
import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext } from '../types.ts';
import { runConnectorSync } from '../../connectors/sync.ts';
import type { ConnectorSyncDeps } from '../../connectors/sync.ts';
import { isConnectorProviderName } from '../../connectors/registry.ts';
import type { ConnectorProviderName } from '../../connectors/types.ts';

/** 35-minute lock TTL (a shade over the 30-min handler wall budget). */
export const CONNECTOR_SYNC_LOCK_TTL_MIN = 35;

export function connectorSyncLockId(provider: string): string {
  return `gbrain-connector-sync:${provider}`;
}

interface ConnectorSyncJobParams {
  provider: ConnectorProviderName;
  sourceId: string;
  full?: boolean;
  limit?: number;
}

function parseParams(data: Record<string, unknown>): ConnectorSyncJobParams {
  const provider = typeof data.provider === 'string' ? data.provider : '';
  if (!isConnectorProviderName(provider)) {
    throw new Error(`connector-sync: invalid provider '${String(data.provider)}' (expected chatgpt|claude)`);
  }
  const sourceId = typeof data.sourceId === 'string' && data.sourceId ? data.sourceId : 'default';
  return {
    provider,
    sourceId,
    full: data.full === true,
    limit: typeof data.limit === 'number' ? data.limit : undefined,
  };
}

export function makeConnectorSyncHandler(engine: BrainEngine, deps: ConnectorSyncDeps = {}) {
  return async function connectorSyncHandler(job: MinionJobContext): Promise<unknown> {
    const params = parseParams(job.data);
    const lock = await tryAcquireDbLock(engine, connectorSyncLockId(params.provider), CONNECTOR_SYNC_LOCK_TTL_MIN);
    if (!lock) {
      return { status: 'already_in_progress', provider: params.provider };
    }
    try {
      const result = await runConnectorSync(engine, {
        provider: params.provider,
        sourceId: params.sourceId,
        full: params.full,
        limit: params.limit,
        signal: job.signal,
        onProgress: (p) => {
          void job.updateProgress({
            phase: `connector.${p.phase}`,
            listed: p.listed,
            fetched: p.fetched,
            imported: p.imported,
          });
        },
        deps,
      });
      // auth_required / forbidden are TERMINAL — returned, not thrown; a retry
      // can't fix a dead cookie, and the stamped auth_error_at + doctor surface it.
      return result;
    } finally {
      await lock.release();
    }
  };
}
