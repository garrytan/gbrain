/**
 * The swap run's brain server probe token (lane L5, B1 run half). The plan's gate refuses a brain with an active access
 * token on the primary, and the shadow seed copies no token, so no owner server token exists in the Rust store at the
 * cutover and the brain server check (served-probe.ts) could never pass. After the final check and before the switch,
 * the run mints one owner server token named `engine-swap-probe-<run id>` in the Rust store (served/owner-token.ts),
 * with a short expiry in `rust_server.owner_token_expires` as a backstop. The token value stays in this process's
 * memory: it is never printed, never written to the run record and never put in an error.
 *
 * The run removes it as soon as the probe ends, on the success path and on the restore path: the row is revoked and
 * its id leaves both owner config keys (a key left empty is removed, so the store's config is as the final check read
 * it). A killed run leaves at most an expired token; its resume, or the next mint for the run, removes it first.
 * Failback never carries the two keys to the old engine (failback-read.ts `FAILBACK_LOCAL_CONFIG`), and it never
 * carries access tokens at all.
 */
import type { BrainEngine } from '../engine.ts';
import { OWNER_TOKEN_EXPIRES_CONFIG_KEY, OWNER_TOKEN_IDS_CONFIG_KEY, ownerTokenExpiries, ownerTokenIds } from '../rust-engine/served/auth.ts';
import { mintOwnerServerToken } from '../rust-engine/served/owner-token.ts';
import { SERVED_PROBE_WINDOW_MS } from './served-probe.ts';

export const PROBE_TOKEN_PREFIX = 'engine-swap-probe-';
/** How long a probe token works: the server wait window plus five minutes. The run removes it well before. */
export const PROBE_TOKEN_TTL_MS = SERVED_PROBE_WINDOW_MS + 5 * 60_000;

export function probeTokenName(runId: string): string {
  return `${PROBE_TOKEN_PREFIX}${runId}`;
}

/** Mints and removes a run's probe token. `remove` is idempotent and removes every token of the run. */
export interface ProbeCredential {
  mint(runId: string): Promise<{ token: string }>;
  remove(runId: string): Promise<void>;
}

/** Revokes every active probe token of `runId` and drops their ids from the owner config keys. */
export async function removeProbeTokens(engine: BrainEngine, runId: string): Promise<string[]> {
  const ids = await engine.revokeAccessTokensNamed(probeTokenName(runId));
  if (!ids.length) return ids;
  const owners = await ownerTokenIds(engine);
  if (ids.some(id => owners.delete(id))) {
    if (owners.size) await engine.setConfig(OWNER_TOKEN_IDS_CONFIG_KEY, JSON.stringify([...owners].sort()));
    else await engine.unsetConfig(OWNER_TOKEN_IDS_CONFIG_KEY);
  }
  const expiries = await ownerTokenExpiries(engine);
  if (expiries && ids.some(id => expiries.delete(id))) {
    if (expiries.size) await engine.setConfig(OWNER_TOKEN_EXPIRES_CONFIG_KEY, JSON.stringify(Object.fromEntries([...expiries].sort(([a], [b]) => (a < b ? -1 : 1)))));
    else await engine.unsetConfig(OWNER_TOKEN_EXPIRES_CONFIG_KEY);
  }
  return ids;
}

/**
 * The probe credential on the Rust store `open` connects to. Each call opens the store and disconnects at once, so the
 * brain server the user starts after the switch owns the store; a later call reaches it through the owner socket.
 */
export function storeProbeCredential(open: () => Promise<BrainEngine>, now: () => number = Date.now): ProbeCredential {
  const withStore = async <T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> => {
    const engine = await open();
    try { return await fn(engine); } finally { await engine.disconnect().catch(() => undefined); }
  };
  return {
    mint: runId => withStore(async engine => {
      await removeProbeTokens(engine, runId); // a token an earlier, killed attempt of this run left
      const { token } = await mintOwnerServerToken(engine, probeTokenName(runId), { expiresAt: now() + PROBE_TOKEN_TTL_MS });
      return { token };
    }),
    remove: runId => withStore(async engine => { await removeProbeTokens(engine, runId); }),
  };
}
