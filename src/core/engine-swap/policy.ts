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
import { brainRefFor } from '../brain-ref.ts';

/** The design's default: at least 14 days of shadowing in the epoch. */
export const DEFAULT_SHADOW_MIN_DAYS = 14;

export type ShadowDuration =
  | { kind: 'days'; days: number; expires?: string }
  | { kind: 'not_required'; expires?: string };

/** The ruling behind an override, quoted as given: the words, who gave them, when and where. */
export interface OverrideRuling {
  words: string;
  by: string;
  /** Local time of the ruling, as the ruling states it. */
  at: string;
  place: string;
}

/**
 * A dated override of criterion 1's duration. It applies only while `now` is before `expires`, and then either to every
 * brain that opts in to the swap (`applies_to: 'every_opt_in_brain'`; only the opt-in swap reads this policy) or to the
 * one brain whose `brainRefFor(persistence_brain.brain_id)` equals `brain_ref` (a null `brain_ref` binds no brain yet,
 * so it applies nowhere). Once it expires the policy's own duration (14 days) stands again. An override changes the
 * duration only: lag, clean reconciles, caught-up following and every other criterion still gate.
 */
export type ShadowOverride = {
  id: string;
  shadow_min: { kind: 'days'; days: number };
  expires: string;
  ruling: OverrideRuling;
} & ({ applies_to: 'every_opt_in_brain' } | { applies_to: 'brain'; brain_ref: string | null });

export interface ReadinessPolicy {
  version: 1;
  /** Criterion 1's minimum shadow duration. */
  shadow_min: ShadowDuration;
  /** Who approved this value and when (`D14`, or the ruling that changed it). */
  approved_by: string;
  /** Dated per-brain overrides of `shadow_min`; the first that applies wins. */
  overrides?: readonly ShadowOverride[];
}

/** The approved policy. Change it only with the maintainer's ruling, and name the ruling in `approved_by`. */
export const READINESS_POLICY: ReadinessPolicy = {
  version: 1,
  shadow_min: { kind: 'days', days: DEFAULT_SHADOW_MIN_DAYS },
  approved_by: 'D14 (docs/designs/RUST_ENGINE.md "Swap readiness")',
  overrides: [{
    // The opt-in swap opens Thu 2026-12-03. Criterion 1's minimum shadow is 5 days for every brain that opts in until
    // the end of Tue 2026-12-08 PST (2026-12-09 08:00 UTC); after that the 14-day default stands again. Shadow days
    // still count only in the evidence epoch of the exact Rust build the brain switches to (shadow/evidence-epoch.ts).
    id: 'c1-opt-in-short-shadow',
    applies_to: 'every_opt_in_brain',
    shadow_min: { kind: 'days', days: 5 },
    expires: '2026-12-09T08:00:00.000Z',
    ruling: {
      words: 'Do it', by: 'the maintainer', at: '2026-11-25 at 3:20 PM PST',
      place: 'Slack channel C0CJDTJG5PE, message 1795648831.786269',
    },
  }],
};

/** The brain reference an override binds: a one-way digest of `persistence_brain.brain_id` (src/core/brain-ref.ts). */
export { brainRefFor };

export type OverrideMiss = 'another_brain' | 'expired' | 'unknown_brain' | 'unbound';

/** The policy in force for one brain at `now`: the base policy, or the base with an applying override's duration. */
export interface PolicyInForce {
  policy: ReadinessPolicy;
  /** The override that applies, else the first one listed with why it does not; null when none is listed. */
  override: { id: string; applies: boolean; why: OverrideMiss | null; expires: string; ruling: OverrideRuling } | null;
  /** The policy as the plan prints it, naming the override, its expiry and the ruling's words, time and place. */
  text: string;
  /** Part of the plan hash: it differs when an override applies, so an approved plan cannot carry one elsewhere. */
  hash: string;
  brain_ref: string | null;
}

function overrideMiss(o: ShadowOverride, ref: string | null, now: Date): OverrideMiss | null {
  const expiry = Date.parse(o.expires);
  if (!Number.isFinite(expiry) || now.getTime() >= expiry) return 'expired';
  if (o.applies_to === 'every_opt_in_brain') return null;
  if (o.brain_ref === null) return 'unbound';
  if (ref === null) return 'unknown_brain';
  return ref === o.brain_ref ? null : 'another_brain';
}

const MISS_TEXT: Record<OverrideMiss, string> = {
  another_brain: 'it is for another brain',
  expired: 'it has expired',
  unknown_brain: 'this brain has no persistence identity',
  unbound: 'it names no brain yet',
};

function quote(r: OverrideRuling): string {
  return `${r.by}, "${r.words}" (${r.place}, ${r.at})`;
}

/** Resolves the policy for the brain whose `persistence_brain.brain_id` is `brainId` (null when unknown). */
export function policyInForce(base: ReadinessPolicy, brainId: string | null, now: Date): PolicyInForce {
  const ref = brainId ? brainRefFor(brainId) : null;
  const { overrides, ...plain } = base;
  const list = overrides ?? [];
  const hit = list.find(o => overrideMiss(o, ref, now) === null);
  const shown = hit ?? list[0];
  const why = shown && !hit ? overrideMiss(shown, ref, now) : null;
  const policy: ReadinessPolicy = hit
    ? { ...plain, shadow_min: { ...hit.shadow_min, expires: hit.expires }, approved_by: `${quote(hit.ruling)}; override ${hit.id}, ${hit.applies_to === 'every_opt_in_brain' ? 'every opt-in brain' : 'this brain only'}` }
    : plain;
  const note = shown && why ? `; override ${shown.id} (${quote(shown.ruling)}, until ${shown.expires}) does not apply: ${MISS_TEXT[why]}` : '';
  return {
    policy,
    override: shown ? { id: shown.id, applies: !!hit, why, expires: shown.expires, ruling: shown.ruling } : null,
    text: describePolicy(policy, now) + note,
    hash: createHash('sha256').update(JSON.stringify({ policy: policyHash(policy), override: hit?.id ?? null, brain_ref: hit && hit.applies_to === 'brain' ? ref : null }))
      .digest('hex').slice(0, 16),
    brain_ref: ref,
  };
}

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
