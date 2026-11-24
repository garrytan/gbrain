/** The takes and trust tier reads, decide family, code traversal and belief ledger members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const LEDGER_MEMBERS = {
  readLivePageIdBySlug: 'pages',
  findTakeId: 'takes',
  // Decide family, group B: calibration profiles (the eval_capture capability serves the decide family's Z-tag records).
  getLatestCalibrationProfile: 'pages', // held: no Rust store member yet; served later as 'eval_capture'
  insertCalibrationProfile: 'pages', // held: no Rust store member yet; served later as 'eval_capture'
  markBeliefCommits: 'belief_ledger',
  readBeliefStateRows: 'belief_ledger',
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
