/**
 * Static per-slot specs: lane, question kind, whether the slot's action can
 * harm (and so needs the action-precision gate), default floors, call sites
 * and the fail direction. `wired` is the delivery gate: a slot that is not
 * wired at its call site with tests stays unregistered, and `decide enable`
 * refuses it (slot_unavailable). Slot lanes flip `wired` when they land.
 */
import type { DecideLane, DecideSlot, EvidenceClass, QuestionKind } from './types.ts';

export interface SlotSpec {
  slot: DecideSlot;
  lane: DecideLane;
  questionKind: QuestionKind;
  /** Harmful-direction slot: `on` needs a qualified calibration (action_precision_lb). */
  harmful: boolean;
  /** Needs a threshold (every slot but rerank). */
  thresholded: boolean;
  /** Call sites; the first is the default for calibrate/qualify. */
  callSites: readonly string[];
  /** Data classes the slot sends (consent keys written by `decide enable`). */
  egressClasses: readonly EvidenceClass[];
  defaultMinKeep?: number;
  /** Default shadow sampling rate. */
  shadowSample: number;
  /** Receipts replay (`--what-if-threshold`) is exact for this slot's reducer. */
  whatIfReproducible: boolean;
  /** Bumped whenever the question text changes; part of the policy fingerprint. */
  questionVersion: number;
  failDirection: string;
  wired: boolean;
}

export const SLOT_SPECS: Readonly<Record<DecideSlot, SlotSpec>> = {
  rerank: {
    slot: 'rerank', lane: 'hot', questionKind: 'score', harmful: false, thresholded: false, callSites: ['search'],
    egressClasses: ['query', 'candidates'], shadowSample: 1, whatIfReproducible: false, questionVersion: 1,
    failDirection: 'fail open to fused (RRF) order', wired: true,
  },
  intent: {
    slot: 'intent', lane: 'hot', questionKind: 'choice', harmful: false, thresholded: true, callSites: ['search', 'think'],
    egressClasses: ['query'], shadowSample: 1, whatIfReproducible: false, questionVersion: 1,
    failDirection: 'fall back to the regex classifier', wired: true,
  },
  evidence: {
    slot: 'evidence', lane: 'hot', questionKind: 'noul', harmful: true, thresholded: true, callSites: ['search', 'think'],
    egressClasses: ['query', 'candidates'], defaultMinKeep: 3, shadowSample: 0.1, whatIfReproducible: true, questionVersion: 1,
    failDirection: 'fail open: keep every candidate', wired: true,
  },
  answerable: {
    slot: 'answerable', lane: 'hot', questionKind: 'noul', harmful: true, thresholded: true, callSites: ['think', 'query'],
    egressClasses: ['query', 'candidates'], shadowSample: 1, whatIfReproducible: false, questionVersion: 1,
    failDirection: 'fail open: answer normally', wired: true,
  },
  injection: {
    slot: 'injection', lane: 'hot', questionKind: 'noul', harmful: false, thresholded: true, callSites: ['search', 'think'],
    egressClasses: ['query', 'candidates'], shadowSample: 0.1, whatIfReproducible: false, questionVersion: 1,
    failDirection: 'fail open: no demotion', wired: true,
  },
  recall_needed: {
    slot: 'recall_needed', lane: 'hot', questionKind: 'noul', harmful: true, thresholded: true, callSites: ['turn_context'],
    egressClasses: ['conversation'], shadowSample: 1, whatIfReproducible: false, questionVersion: 1,
    failDirection: 'fail open: the reflex result stands', wired: true,
  },
  triage: {
    slot: 'triage', lane: 'background', questionKind: 'noul', harmful: true, thresholded: true, callSites: ['dream'],
    egressClasses: ['conversation'], shadowSample: 1, whatIfReproducible: true, questionVersion: 1,
    failDirection: 'fail open: today\'s triage path', wired: true,
  },
  grounding: {
    slot: 'grounding', lane: 'background', questionKind: 'noul', harmful: true, thresholded: true, callSites: ['dream'],
    egressClasses: ['conversation'], shadowSample: 1, whatIfReproducible: true, questionVersion: 1,
    failDirection: 'keep the mechanical verification result', wired: true,
  },
  conflict: {
    slot: 'conflict', lane: 'background', questionKind: 'choice', harmful: false, thresholded: true, callSites: ['sweep'],
    egressClasses: ['facts'], shadowSample: 1, whatIfReproducible: false, questionVersion: 1,
    failDirection: 'no proposal; the fact stays as written', wired: true,
  },
};

export function slotSpec(slot: DecideSlot): SlotSpec {
  return SLOT_SPECS[slot];
}
