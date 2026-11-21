/**
 * The swap readiness policy (docs/designs/RUST_ENGINE.md "Swap readiness"): the values a readiness verdict depends on
 * that an approved policy may change. Today that is criterion 1's minimum shadow duration.
 *
 * It is a policy value, not a flag: the plan prints it and its hash, the hash is part of the plan hash and of the
 * evidence epoch, so changing it starts a new epoch and needs a new plan. Only this file sets it, and a change is a
 * reviewed commit. A duration with an expiry date falls back to the design's default once the date has passed.
 *
 * Privacy, fingerprints, topology, platform, capabilities, recovery drills, caught-up following and the final digests
 * are never part of a policy: `UNWAIVABLE` names them, and the evaluator applies them whatever the policy says.
 */
import { createHash } from 'node:crypto';

/** The design's default: at least 14 days of shadowing in the epoch. */
export const DEFAULT_SHADOW_MIN_DAYS = 14;

export type ShadowDuration =
  | { kind: 'days'; days: number; expires?: string }
  | { kind: 'not_required'; expires?: string };

export interface ReadinessPolicy {
  version: 1;
  /** Criterion 1's minimum shadow duration. */
  shadow_min: ShadowDuration;
  /** Who approved this value and when (`D14`, or the ruling that changed it). */
  approved_by: string;
}

/** The approved policy. Change it only with the maintainer's ruling, and name the ruling in `approved_by`. */
export const READINESS_POLICY: ReadinessPolicy = {
  version: 1,
  shadow_min: { kind: 'days', days: DEFAULT_SHADOW_MIN_DAYS },
  approved_by: 'D14 (docs/designs/RUST_ENGINE.md "Swap readiness")',
};

/** What no policy can waive (the design's list); the evaluator checks each whatever the policy says. */
export const UNWAIVABLE = [
  'privacy', 'fingerprints', 'topology', 'platform', 'capabilities', 'recovery_drills', 'caught_up_following', 'final_digests',
] as const;

/** The duration in force at `now`: an expired value falls back to the design's default. */
export function effectiveShadowMin(policy: ReadinessPolicy, now: Date): { required: boolean; days: number; expired: boolean } {
  const d = policy.shadow_min;
  const expired = d.expires !== undefined && Number.isFinite(Date.parse(d.expires)) && now.getTime() >= Date.parse(d.expires);
  if (expired || (d.expires !== undefined && !Number.isFinite(Date.parse(d.expires)))) {
    return { required: true, days: DEFAULT_SHADOW_MIN_DAYS, expired: true };
  }
  if (d.kind === 'not_required') return { required: false, days: 0, expired: false };
  if (!Number.isFinite(d.days) || d.days < 0) return { required: true, days: DEFAULT_SHADOW_MIN_DAYS, expired: false };
  return { required: true, days: d.days, expired: false };
}

/** The policy as the plan prints it. */
export function describePolicy(policy: ReadinessPolicy, now: Date): string {
  const e = effectiveShadowMin(policy, now);
  const d = policy.shadow_min;
  const value = d.kind === 'not_required' ? 'not required' : `${d.days} days`;
  const expiry = d.expires ? ` until ${d.expires}` : '';
  const fallback = e.expired ? ` (expired; ${DEFAULT_SHADOW_MIN_DAYS} days applies)` : '';
  return `minimum shadow duration ${value}${expiry}${fallback}; approved by ${policy.approved_by}`;
}

/** The readiness-policy hash: part of the plan hash and of the evidence epoch. */
export function policyHash(policy: ReadinessPolicy): string {
  return createHash('sha256').update(JSON.stringify({ v: policy.version, shadow_min: policy.shadow_min, unwaivable: UNWAIVABLE })).digest('hex').slice(0, 16);
}
