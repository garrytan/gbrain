/**
 * Read eligibility policy (#5575: A7/I5, CEO-13, CEO-18, CEO-20, DX-13, ENG-8).
 *
 * One reversible policy decides which stored rows a reader may see and which
 * a proactive surface may inject. It never changes stored rows: a quarantined
 * page hides its facts, takes and timeline projections only while it stays
 * quarantined, and release restores them (ENG-8).
 *
 * - Read floor: `min_trust` admits rows at or above a tier (trust/tier.ts
 *   order). The effective floor is the strictest of the connection's token
 *   floor (`AuthInfo.minTrust`, set only by the local CLI), the caller's
 *   `min_trust` param and the read policy's own floor. A caller can raise the
 *   floor, never lower it.
 * - Read policy (`trust.read_policy`, local config): `label` (default) only
 *   labels rows, so ordering is byte-identical to a brain without tiers;
 *   `filter` also hides `external_untrusted` rows (floor `unknown`) from every
 *   read. There is no downrank mode (UC1).
 * - Activation control (`trust.agent_activation`, local config): `allow`
 *   (default) lets proactive surfaces inject flagged rows, labeled
 *   "unconfirmed, agent-written"; `suppress` (the owner's opt-in) keeps
 *   agent-written-or-lower rows carrying a write-gate flag in an instruction
 *   family out of proactive surfaces until the owner confirms them. Explicit
 *   reads always return them, labeled. The default follows the preregistered
 *   paid eval (gbrain-evals docs/benchmarks/2026-10-08-memory-trust-results-paid.md):
 *   suppression cut no agent-relayed attack success on top of labels.
 *
 * SQL fragments live in eligibility/sql.ts; user-facing labels in labels.ts.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { maxTrust, parseTrustTier, TRUST_TIERS, type TrustTier } from '../trust/tier.ts';

export const READ_POLICY_KEY = 'trust.read_policy';
export const AGENT_ACTIVATION_KEY = 'trust.agent_activation';

export const READ_POLICY_MODES = ['label', 'filter'] as const;
export type ReadPolicyMode = typeof READ_POLICY_MODES[number];
export const AGENT_ACTIVATION_MODES = ['suppress', 'allow'] as const;
export type AgentActivationMode = typeof AGENT_ACTIVATION_MODES[number];

/** The floor `trust.read_policy=filter` applies on its own: external, untrusted rows are hidden. */
export const FILTER_POLICY_FLOOR: TrustTier = 'unknown';

/** What one read may see. Absent fields mean "no restriction" (label mode, no floor). */
export interface ReadEligibility {
  /** Rows below this tier are excluded inside each arm's SQL, before LIMIT. */
  floor?: TrustTier;
  /**
   * Proactive surfaces only: exclude agent-written-or-lower rows that carry an
   * instruction-family write-gate flag (CEO-20). Never set on explicit reads.
   */
  suppressFlagged?: boolean;
}

export interface TrustReadConfig { mode: ReadPolicyMode; activation: AgentActivationMode }

function pick<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  const v = value?.trim().toLowerCase();
  return v && (allowed as readonly string[]).includes(v) ? v as T : fallback;
}

/**
 * Reads both keys from the brain's config table. An unreadable config keeps
 * the defaults: label mode (labels on every row) and activation `allow`.
 */
export async function loadTrustReadConfig(engine: Pick<BrainEngine, 'getConfig'>): Promise<TrustReadConfig> {
  const read = async (key: string) => { try { return await engine.getConfig(key); } catch { return null; } };
  const [mode, activation] = await Promise.all([read(READ_POLICY_KEY), read(AGENT_ACTIVATION_KEY)]);
  return {
    mode: pick(mode, READ_POLICY_MODES, 'label'),
    activation: pick(activation, AGENT_ACTIVATION_MODES, 'allow'),
  };
}

/** `min_trust` as a caller passed it: absent is no floor; anything that names no tier is `invalid_params`. */
export function parseMinTrustParam(value: unknown): TrustTier | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseTrustTier(value, 'min_trust');
}

/** The strictest of the given floors; undefined when none is set. */
export function strictestFloor(...floors: Array<TrustTier | undefined>): TrustTier | undefined {
  const set = floors.filter((f): f is TrustTier => f !== undefined);
  return set.length ? maxTrust(set[0], ...set.slice(1)) : undefined;
}

export interface ResolveEligibilityOpts {
  /** The caller's `min_trust` param (validated here). */
  minTrust?: unknown;
  /** A proactive surface (hook, context engine, context_pack, volunteer, reflex, core delivery). */
  proactive?: boolean;
  /** Preloaded config (a surface that already read it). */
  config?: TrustReadConfig;
}

/** Resolve the policy once at the operation or surface boundary. */
export interface EligibilityCaller { engine: Pick<BrainEngine, 'getConfig'>; auth?: Pick<NonNullable<OperationContext['auth']>, 'minTrust'> }

export async function resolveReadEligibility(
  ctx: EligibilityCaller,
  opts: ResolveEligibilityOpts = {},
): Promise<ReadEligibility> {
  const param = parseMinTrustParam(opts.minTrust);
  const config = opts.config ?? await loadTrustReadConfig(ctx.engine);
  const floor = strictestFloor(ctx.auth?.minTrust, param, config.mode === 'filter' ? FILTER_POLICY_FLOOR : undefined);
  return {
    ...(floor ? { floor } : {}),
    ...(opts.proactive && config.activation === 'suppress' ? { suppressFlagged: true } : {}),
  };
}

/** The shared `min_trust` op param (ENG-14: every `filtered` read op takes it). */
export const MIN_TRUST_PARAM = {
  type: 'string' as const,
  enum: [...TRUST_TIERS],
  description: 'Lowest trust tier to return (the connection floor still applies).',
  fullSurfaceOnly: true,
};
