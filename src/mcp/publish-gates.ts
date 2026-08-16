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

/** Dual-plane gate read: DB > file > false; read failure = false (hidden). */
export async function readPublishGate(
  engine: BrainEngine,
  config: GBrainConfig | null | undefined,
  key: PublishGateKey,
): Promise<boolean> {
  let dbVal: string | null = null;
  try {
    dbVal = await engine.getConfig(key);
  } catch {
    // Engine without a config table / transient error → file plane decides.
  }
  if (dbVal != null) return dbVal === 'true';
  const mcp = config?.mcp as Record<string, unknown> | undefined;
  const fileKey = key.slice('mcp.'.length);
  return mcp?.[fileKey] === true;
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
): Promise<ReadonlySet<string>> {
  const gated = operations.filter(op => op.publishGateKey);
  if (gated.length === 0) return new Set();
  const keys = [...new Set(gated.map(op => op.publishGateKey as PublishGateKey))];
  const resolved = new Map<PublishGateKey, boolean>();
  await Promise.all(keys.map(async (key) => {
    resolved.set(key, await readPublishGate(engine, config, key));
  }));
  const disabled = new Set<string>();
  for (const op of gated) {
    if (!resolved.get(op.publishGateKey as PublishGateKey)) disabled.add(op.name);
  }
  return disabled;
}
