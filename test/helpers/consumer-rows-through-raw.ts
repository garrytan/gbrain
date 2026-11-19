/**
 * The five typed consumer-row engine members (engine-sql/persistence-claims.ts), answered by a test fake's own
 * `executeRaw` / `executeRawDirect`. A fake that intercepts the consumer SQL keeps intercepting the same statement
 * text with the same params: the reads go through `executeRaw` (as `listHostConsumers` and `probeLiveFullConsumer`
 * sent them), the heartbeat's writes through `executeRawDirect` when the fake has one (as the heartbeat sent them).
 */
import {
  DELETE_CONSUMER_SQL, LIST_HOST_CONSUMERS_SQL, PROBE_LIVE_CONSUMERS_SQL, RENEW_CONSUMER_SQL, STAMP_WORKTREE_HEARTBEATS_SQL,
  type ConsumerProbe, type ConsumerRenewal, type ConsumerRowKey, type ConsumerRowRead,
} from '../../src/core/engine-sql/persistence-claims.ts';

type Raw = (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) => Promise<unknown[]>;

export function consumerRowsThroughRaw(engine: { executeRaw: Raw; executeRawDirect?: Raw }) {
  const write: Raw = (sql, params, opts) => (engine.executeRawDirect ?? engine.executeRaw)(sql, params, opts);
  return {
    listHostConsumerRows: async (hostId: string, opts?: { signal?: AbortSignal }) =>
      await engine.executeRaw(LIST_HOST_CONSUMERS_SQL, [hostId], { signal: opts?.signal }) as ConsumerRowRead[],
    probeLiveConsumerRows: async (p: ConsumerProbe, opts?: { signal?: AbortSignal }) =>
      await engine.executeRaw(PROBE_LIVE_CONSUMERS_SQL, [p.hostId, [...p.kinds], p.pid, p.nonce, p.liveMs], { signal: opts?.signal }) as ConsumerRowRead[],
    renewConsumerRow: async (r: ConsumerRenewal, opts?: { signal?: AbortSignal }) => {
      await write(RENEW_CONSUMER_SQL, [r.hostId, r.pid, r.nonce, r.pidNs, r.kind, r.mode, r.restartRequired, r.rootBarrierAgeMs,
        r.pool, r.hostJsonPath, r.persistenceHome, r.mintedUnder, r.version, r.purgeMs, r.bootId, r.processStart], opts);
    },
    deleteConsumerRow: async (k: ConsumerRowKey, opts?: { signal?: AbortSignal }) => { await write(DELETE_CONSUMER_SQL, [k.hostId, k.pid, k.nonce], opts); },
    stampWorktreeHeartbeats: async (hostId: string, opts?: { signal?: AbortSignal }) => { await write(STAMP_WORKTREE_HEARTBEATS_SQL, [hostId], opts); },
  };
}
