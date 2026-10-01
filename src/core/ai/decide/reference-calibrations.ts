/**
 * Reference calibrations shipped in the binary: produced by the maintainer's
 * eval runs (docs/eval/system-one/), keyed by slot, call site, provider, model
 * and pack_shape, with dataset and split hashes. Used when a brain has no
 * local row; a local row always wins. An enabled slot records the calibration
 * it adopted (`decide.slots.<slot>.calibration`), so a newer binary never
 * silently switches it: `decide status` shows "newer reference available".
 *
 * Rows exist only for slots whose recorded verdict is a win and, for
 * harmful-direction slots, whose action_precision_lb passes the 0.90 gate
 * (docs/eval/system-one/README.md).
 *
 * `recommendedSlots` is the one place that turns these rows into a slot set:
 * `gbrain decide enable --recommended` turns it on, and with a TypeSafe key
 * present it is the key-aware default-on set (readDecideConfig), so the two
 * can never disagree.
 */
import { SLOT_SPECS } from './slots.ts';
import type { DecideSlot } from './types.ts';

export interface ReferenceCalibration {
  /** Stable id, referenced as `ref:<id>`. */
  id: string;
  slot: DecideSlot;
  call_site: string;
  provider: string;
  model_resolved: string;
  threshold: number;
  min_keep: number | null;
  retest_sd: number;
  repack_sd: number;
  action_precision_lb: number | null;
  policy_fingerprint: string | null;
  pack_shape: string;
  dataset_hash: string;
  split_hash: string;
  /** S9 only: proposal floor calibrated on supersede labels. */
  proposal_floor?: number;
  /** Recorded eval verdict for the slot on this model. `enable --recommended` needs `win`. */
  verdict: 'win' | 'no_change' | 'regression' | 'not_measured';
  /** Binary version that shipped the row. */
  shipped_in: string;
}

export const REFERENCE_CALIBRATIONS: readonly ReferenceCalibration[] = [
  {
    // S7: Cat 35 + synthetic routine/buried-signal transcripts (docs/eval/system-one/datasets/s7-triage.jsonl),
    // calibrated for recall 1.0 on the calibrate half; qualified 39/39 correct rejections on the eval half.
    id: 'triage-jev-1.13.0-2026-09-30', slot: 'triage', call_site: 'dream', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0',
    threshold: 0.77, min_keep: null, retest_sd: 0.0138, repack_sd: 0.0127, action_precision_lb: 0.9103, policy_fingerprint: '4d1429790e67d15d',
    pack_shape: 'v1:order=rank-id:max=1:slots=triage', dataset_hash: '91bb3dec2951e309', split_hash: 'de2b13e9820b5ffb',
    verdict: 'win', shipped_in: '0.60.17.0',
  },
  {
    // S9: labelled fact pairs (docs/eval/system-one/datasets/s9-conflict.jsonl); duplicate threshold by F1 and the
    // proposal floor calibrated on supersede labels. Not a harmful-direction slot (proposals only).
    id: 'conflict-jev-1.13.0-2026-09-30', slot: 'conflict', call_site: 'sweep', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0',
    threshold: 0.52, min_keep: null, retest_sd: 0.0013, repack_sd: 0.0046, action_precision_lb: null, policy_fingerprint: null,
    pack_shape: 'v1:order=rank-id:max=budget:slots=conflict', dataset_hash: '37fe4083e9722308', split_hash: '2ec631956c4b9e33', proposal_floor: 0.65,
    verdict: 'win', shipped_in: '0.60.17.0',
  },
];

/**
 * Wired slots with a `win` reference row for `provider` whose harmful-direction
 * gate passes (action_precision_lb at or above the slot's min_action_precision).
 */
export function recommendedSlots(
  provider: string,
  minActionPrecision: (slot: DecideSlot) => number = () => 0.9,
  references: readonly ReferenceCalibration[] = REFERENCE_CALIBRATIONS,
): DecideSlot[] {
  const slots = new Set<DecideSlot>();
  for (const r of references) {
    if (r.provider !== provider || r.verdict !== 'win' || !SLOT_SPECS[r.slot].wired) continue;
    if (SLOT_SPECS[r.slot].harmful && (r.action_precision_lb ?? 0) < minActionPrecision(r.slot)) continue;
    slots.add(r.slot);
  }
  return [...slots];
}
