/**
 * Slot policy: requested versus effective mode, threshold resolution, margin,
 * floors and the policy fingerprint, computed from local state only.
 *
 * Owner decision (2026-09-30): the user-facing states are `off` and `on`;
 * `shadow` is advanced diagnostics. Anything that used to "demote to shadow"
 * now runs the call with off behavior, writes a receipt with the reason, and
 * surfaces as `on (inactive: <reason>)` plus the one command that fixes it.
 *
 * Threshold precedence: decide.slots.<slot>.threshold (operator override,
 * never drift-demoted, never bypasses the action-precision gate) > the adopted
 * calibration (decide.slots.<slot>.calibration) > the newest local row for
 * (slot, call site, provider, model) > a shipped reference row. With an alias
 * configured, the model is the one most recently resolved in receipts.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_TYPESAFE_PROVIDER, providerKind, isTypesafeAlias, type DecideConfig } from './config.ts';
import { llmCapability, llmChatModel } from './providers/llm-structured.ts';
import { PROTECTION_VERSION } from './protection.ts';
import { REFERENCE_CALIBRATIONS, type ReferenceCalibration } from './reference-calibrations.ts';
import { SLOT_SPECS } from './slots.ts';
import type { CalibrationRow } from './store.ts';
import type { DecideMode, DecideSlot } from './types.ts';

export interface PolicyCalibration {
  ref: string;
  model_resolved: string;
  threshold: number;
  min_keep: number | null;
  retest_sd: number;
  repack_sd: number;
  action_precision_lb: number | null;
  policy_fingerprint: string | null;
  pack_shape: string;
  split_hash: string | null;
  calibrate_only: boolean;
  /** S9: proposal floor calibrated on supersede labels (local row notes or the reference row). */
  proposal_floor?: number;
}

/** A calibrated S9 proposal floor stored in a local row's notes JSON, if any. */
export function notesProposalFloor(notes: string | null | undefined): number | undefined {
  if (!notes) return undefined;
  try {
    const v = (JSON.parse(notes) as { proposal_floor?: unknown }).proposal_floor;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
  } catch { return undefined; }
}

export interface SlotPolicy {
  slot: DecideSlot;
  callSite: string;
  requested: DecideMode;
  /** What the call does: `off` = today's path (possibly with an inactive-cause receipt). */
  effective: DecideMode;
  /** Catalogued reason when effective is lower than requested. */
  inactive?: string;
  provider: string;
  /** The model id calibrations are looked up under (resolved alias when known). */
  model: string | null;
  threshold?: number;
  thresholdSource: 'override' | 'calibration' | 'reference' | 'none';
  calibration?: PolicyCalibration;
  minKeep: number;
  margin: number;
  fingerprint: string;
  forceOn: boolean;
  shadowSample: number;
  shadowWait: boolean;
  packShape: string;
  /** S6: the suppression boundary (part of the fingerprint). */
  suppressBelow?: number;
}

export interface PolicyInputs {
  cfg: DecideConfig;
  slot: DecideSlot;
  callSite?: string;
  packShape: string;
  calibrations: readonly CalibrationRow[];
  /** provider -> most recently resolved model id (from receipts). */
  lastResolved?: Readonly<Record<string, string>>;
  /** A TypeSafe key is configured (TYPESAFE_API_KEY or JEV_TYPESAFE_API_KEY). */
  hasTypesafeKey: boolean;
  /** search.reranker.model, for S1. */
  rerankerModel?: string;
  references?: readonly ReferenceCalibration[];
}

export function marginFor(marginFloor: number, calibration?: Pick<PolicyCalibration, 'retest_sd' | 'repack_sd'>): number {
  const sd = calibration ? Math.max(calibration.retest_sd, calibration.repack_sd) : 0;
  return Math.max(marginFloor, 2 * sd);
}

/** Immutable fingerprint of the action policy a qualification is bound to. */
export function policyFingerprint(p: { slot: DecideSlot; callSite: string; threshold?: number; marginFloor: number; minKeep: number; packShape: string; suppressBelow?: number }): string {
  const body = JSON.stringify({
    slot: p.slot, callSite: p.callSite, threshold: p.threshold === undefined ? null : Number(p.threshold.toFixed(4)),
    margin: 'max(floor,2*max(retest_sd,repack_sd))', marginFloor: p.marginFloor, minKeep: p.minKeep,
    protections: PROTECTION_VERSION, question: SLOT_SPECS[p.slot].questionVersion, packShape: p.packShape,
    suppressBelow: p.suppressBelow,
  });
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function fromLocal(row: CalibrationRow): PolicyCalibration {
  return {
    ref: `local:${row.id}`, model_resolved: row.model_resolved, threshold: row.threshold, min_keep: row.min_keep,
    retest_sd: row.retest_sd ?? 0, repack_sd: row.repack_sd ?? 0, action_precision_lb: row.action_precision_lb,
    policy_fingerprint: row.policy_fingerprint, pack_shape: row.pack_shape, split_hash: row.split_hash, calibrate_only: row.calibrate_only,
    ...(notesProposalFloor(row.notes) !== undefined ? { proposal_floor: notesProposalFloor(row.notes) } : {}),
  };
}

function fromReference(row: ReferenceCalibration): PolicyCalibration {
  return {
    ref: `ref:${row.id}`, model_resolved: row.model_resolved, threshold: row.threshold, min_keep: row.min_keep,
    retest_sd: row.retest_sd, repack_sd: row.repack_sd, action_precision_lb: row.action_precision_lb,
    policy_fingerprint: row.policy_fingerprint, pack_shape: row.pack_shape, split_hash: row.split_hash, calibrate_only: true,
    ...(row.proposal_floor !== undefined ? { proposal_floor: row.proposal_floor } : {}),
  };
}

/** The model id calibrations are keyed under for `provider`, or null when an alias has never resolved. */
export function lookupModel(provider: string, lastResolved?: Readonly<Record<string, string>>): string | null {
  const kind = providerKind(provider);
  if (kind === 'typesafe') return isTypesafeAlias(provider) ? lastResolved?.[provider] ?? null : provider.replace(/^typesafe:/, '');
  if (kind === 'llm') return lastResolved?.[provider] ?? llmChatModel(provider);
  return null;
}

export function selectCalibration(inputs: Pick<PolicyInputs, 'slot' | 'calibrations' | 'references'> & { callSite: string; provider: string; model: string | null; adopted?: string }): PolicyCalibration | undefined {
  const { slot, callSite, provider, model, adopted } = inputs;
  if (!model) return undefined;
  const matches = (r: { slot: string; call_site: string; provider: string; model_resolved: string }) =>
    r.slot === slot && r.call_site === callSite && r.provider === provider && r.model_resolved === model;
  const refs = inputs.references ?? REFERENCE_CALIBRATIONS;
  if (adopted?.startsWith('local:')) {
    const row = inputs.calibrations.find((r) => `local:${r.id}` === adopted && !r.retired_at && matches(r));
    if (row) return fromLocal(row);
  }
  if (adopted?.startsWith('ref:')) {
    const row = refs.find((r) => `ref:${r.id}` === adopted && matches(r));
    if (row) return fromReference(row);
  }
  const local = inputs.calibrations
    .filter((r) => !r.retired_at && matches(r))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id))[0];
  if (local) return fromLocal(local);
  const ref = refs.find(matches);
  return ref ? fromReference(ref) : undefined;
}

export function resolveSlotPolicy(inputs: PolicyInputs): SlotPolicy {
  const { cfg, slot } = inputs;
  const spec = SLOT_SPECS[slot];
  const sc = cfg.slots[slot];
  const callSite = inputs.callSite ?? spec.callSites[0]!;
  const provider = slot === 'rerank' && sc.mode !== 'off' && inputs.rerankerModel?.startsWith('typesafe:') ? inputs.rerankerModel : sc.provider;
  const model = lookupModel(provider, inputs.lastResolved);
  const calibration = spec.thresholded
    ? selectCalibration({ slot, callSite, provider, model, adopted: sc.calibration, calibrations: inputs.calibrations, references: inputs.references })
    : undefined;
  const threshold = sc.threshold ?? calibration?.threshold;
  const thresholdSource: SlotPolicy['thresholdSource'] = sc.threshold !== undefined ? 'override'
    : calibration ? (calibration.ref.startsWith('ref:') ? 'reference' : 'calibration') : 'none';
  const minKeep = sc.minKeep ?? calibration?.min_keep ?? spec.defaultMinKeep ?? 0;
  const margin = marginFor(cfg.marginFloor, sc.threshold !== undefined && !calibration ? undefined : calibration);
  const fingerprint = policyFingerprint({ slot, callSite, threshold, marginFloor: cfg.marginFloor, minKeep, packShape: inputs.packShape, suppressBelow: sc.suppressBelow });
  const base: SlotPolicy = {
    slot, callSite, requested: sc.mode, effective: sc.mode, provider, model, threshold, thresholdSource, calibration,
    minKeep, margin, fingerprint, forceOn: sc.forceOn, shadowSample: sc.shadowSample ?? spec.shadowSample,
    shadowWait: sc.shadowWait, packShape: inputs.packShape, ...(sc.suppressBelow !== undefined ? { suppressBelow: sc.suppressBelow } : {}),
  };
  const inactive = (reason: string): SlotPolicy => ({ ...base, effective: 'off', inactive: reason });
  if (sc.mode === 'off') return base;
  if (!spec.wired) return inactive('slot_unavailable');
  if (slot === 'rerank') {
    if (cfg.provider === 'none') return inactive('no_provider');
    if (sc.mode === 'on' && !inputs.rerankerModel?.startsWith('typesafe:')) return inactive('reranker_not_jev');
    if (!inputs.hasTypesafeKey) return inactive('no_key');
    // Shadow with the Jev reranker already selected behaves as on.
    if (sc.mode === 'shadow' && inputs.rerankerModel?.startsWith('typesafe:')) return { ...base, effective: 'on' };
    return base;
  }
  const kind = providerKind(provider);
  if (kind === 'none') return inactive('no_provider');
  if (kind === 'typesafe' && !inputs.hasTypesafeKey) return inactive('no_key');
  if (sc.mode === 'shadow') return base;
  if (kind === 'llm' && llmCapability(provider) !== 'structured') return inactive('llm_capability');
  if (threshold === undefined) return inactive('no_calibration');
  if (calibration && sc.threshold === undefined && calibration.pack_shape !== inputs.packShape) return inactive('pack_shape_mismatch');
  if (spec.harmful && !sc.forceOn) {
    if (!calibration || calibration.action_precision_lb === null) return inactive('no_qualification');
    if (calibration.action_precision_lb < sc.minActionPrecision) return inactive('action_precision_low');
    if (calibration.policy_fingerprint && calibration.policy_fingerprint !== fingerprint) return inactive('policy_changed');
  }
  return base;
}

export const KEY_DEFAULT_LABEL = 'default: Jev key present';

/** One-line opt-out for a slot on by the key-aware default. */
export function keyDefaultOptOut(slot: DecideSlot): string {
  return `gbrain decide disable ${slot}`;
}

/** Readiness line for status/doctor: off, ready for on, on, on (default: Jev key present), on (inactive: <reason>), needs calibration, shadow. */
export function readiness(policy: SlotPolicy, inputs: PolicyInputs): string {
  if (policy.requested === 'on' && inputs.cfg.slots[policy.slot].keyDefault) {
    return policy.inactive ? `on (${KEY_DEFAULT_LABEL}; inactive: ${policy.inactive})` : `on (${KEY_DEFAULT_LABEL})`;
  }
  if (policy.requested === 'on') return policy.inactive ? `on (inactive: ${policy.inactive})` : 'on';
  if (policy.requested === 'shadow') return policy.inactive ? `shadow (inactive: ${policy.inactive})` : 'shadow';
  const spec = SLOT_SPECS[policy.slot];
  if (!spec.wired) return 'off';
  // Probe what `decide enable <slot>` would produce (it writes the pinned default provider, and the reranker for S1).
  const sc = inputs.cfg.slots[policy.slot];
  const provider = sc.provider === 'none' ? DEFAULT_TYPESAFE_PROVIDER : sc.provider;
  const probe = resolveSlotPolicy({
    ...inputs,
    cfg: { ...inputs.cfg, provider: inputs.cfg.provider === 'none' ? provider : inputs.cfg.provider, slots: { ...inputs.cfg.slots, [policy.slot]: { ...sc, mode: 'on', provider } } },
    ...(policy.slot === 'rerank' ? { rerankerModel: inputs.rerankerModel?.startsWith('typesafe:') ? inputs.rerankerModel : DEFAULT_TYPESAFE_PROVIDER } : {}),
  });
  if (!probe.inactive) return 'ready for on';
  return ['no_calibration', 'no_qualification', 'pack_shape_mismatch'].includes(probe.inactive) ? 'needs calibration' : 'off';
}

/** After a response: a resolved model different from the calibration's demotes that call (override never demotes). */
export function driftReason(policy: SlotPolicy, resolved: string): string | undefined {
  if (policy.thresholdSource === 'override' || !policy.calibration) return undefined;
  return resolved === policy.calibration.model_resolved ? undefined : 'model_drift';
}
