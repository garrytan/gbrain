/**
 * Publish-gate resolution for the honest tools/list (WP1).
 *
 * Ops carrying `Operation.publishGateKey` are callable by remote callers only
 * when the named config gate resolves true. Before this module, the gates
 * fired only inside handlers, so gated tools were LISTED unconditionally and
 * denied at call time — the "worse than omitting them, looks broken" consumer
 * complaint. Network transports now consult this resolver per tools/list
 * request (config flips take effect on the next list, no restart — the
 * per-POST stateless server makes that free).
 *
 * Resolution per key is dual-plane, matching `readMcpPublishSkills`
 * (src/core/skill-catalog.ts): DB plane (`engine.getConfig`) wins, file plane
 * (`config.mcp.*`) is the fallback, absent on both = false. A FAILED gate
 * read also resolves false — hide-on-doubt matches the default-off consent
 * posture, and listing-on-doubt would recreate the listed-but-denied
 * complaint. This helper never throws and never fails a tools/list.
 */

import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { operations, type Operation } from '../core/operations.ts';

export type PublishGateKey = NonNullable<Operation['publishGateKey']>;

/** Every config key an operation's publish gate reads; `config get` resolves these DB-first like the gate (#5358). */
export const PUBLISH_GATE_KEYS: ReadonlySet<PublishGateKey> = new Set(operations.flatMap(op => (op.publishGateKey ? [op.publishGateKey] : [])));

/**
 * Gates that default ON for the owner's stdio pipe when neither plane sets
 * them (agent contract v1, F7): the read-only advisor is coaching the local
 * agent should see; remote HTTP stays opt-in. An explicit `false` wins.
 */
const STDIO_DEFAULT_ON: ReadonlySet<PublishGateKey> = new Set<PublishGateKey>(['mcp.publish_advisor']);

/** Dual-plane gate read: DB > file > transport default (stdio advisor on; else false); read failure = false (hidden). */
export async function readPublishGate(
  engine: BrainEngine,
  config: GBrainConfig | null | undefined,
  key: PublishGateKey,
  transport?: string,
): Promise<boolean> {
  let dbVal: string | null = null;
  let readFailed = false;
  try {
    dbVal = await engine.getConfig(key);
  } catch {
    // Engine without a config table / transient error → file plane decides.
    readFailed = true;
  }
  if (dbVal != null) return dbVal === 'true';
  const mcp = config?.mcp as Record<string, unknown> | undefined;
  const fileVal = mcp?.[key.slice('mcp.'.length)];
  if (typeof fileVal === 'boolean') return fileVal;
  // Hide-on-doubt: a failed read never takes the stdio default.
  return !readFailed && transport === 'stdio' && STDIO_DEFAULT_ON.has(key);
}

/**
 * The set of op NAMES whose publish gate currently resolves off. tools/list
 * subtracts this set. One getConfig read per DISTINCT gate key per call
 * (two today, issued concurrently — one RTT of latency, not one per key),
 * deliberately not memoized — the per-request read is what makes
 * `gbrain config set mcp.publish_skills true` take effect without a
 * server restart.
 */
export async function disabledOpsForPublishGates(
  engine: BrainEngine,
  config: GBrainConfig | null | undefined,
  opts: { transport?: string } = {},
): Promise<ReadonlySet<string>> {
  const gated = operations.filter(op => op.publishGateKey);
  if (gated.length === 0) return new Set();
  const keys = [...new Set(gated.map(op => op.publishGateKey as PublishGateKey))];
  const resolved = new Map<PublishGateKey, boolean>();
  await Promise.all(keys.map(async (key) => {
    resolved.set(key, await readPublishGate(engine, config, key, opts.transport));
  }));
  const disabled = new Set<string>();
  for (const op of gated) {
    if (!resolved.get(op.publishGateKey as PublishGateKey)) disabled.add(op.name);
  }
  return disabled;
}
