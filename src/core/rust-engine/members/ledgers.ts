/** The takes and trust tier reads, decide family, code traversal and belief ledger members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const LEDGER_MEMBERS = {
  readLivePageIdBySlug: 'pages',
  findTakeId: 'takes',
  // Decide family, group B: calibration profiles (the eval_capture capability serves the decide family's Z-tag records).
  getLatestCalibrationProfile: 'pages', // held: no Rust store member yet; served later as 'eval_capture'
  insertCalibrationProfile: 'pages', // held: no Rust store member yet; served later as 'eval_capture'
  purgeCalibrationProfilesByWave: 'pages', // held: no Rust store member yet; served later as 'eval_capture'

  // Group D (trust tier reads)
  listCorePageRows: 'pages',
  listTrustScanRows: 'pages', // held: no Rust store member yet; served later as 'facts'
  countUnscannedTrustRows: 'pages', // held: no Rust store member yet; served later as 'facts'
  readTrustScanCursor: 'pages', // held: no Rust store member yet; served later as 'facts'
  writeTrustScanCursor: 'pages', // held: no Rust store member yet; served later as 'facts'
  listClaimPendingSourceIds: 'pages', // held: no Rust store member yet; served later as 'facts'
  readTrustScanCeilings: 'pages', // held: no Rust store member yet; served later as 'facts'
  readBeliefHistoryRows: 'belief_ledger',
  listVisibleBeliefLifetimes: 'belief_ledger',
  insertBeliefEvents: 'belief_ledger',
  markBeliefCommits: 'belief_ledger',
  readOpenBeliefLifetimes: 'belief_ledger',
  endBeliefLifetime: 'belief_ledger',
  readBeliefStateRows: 'belief_ledger',
  readBeliefFactsById: 'belief_ledger',
  bumpSourcePurgeEpoch: 'pages', // held: no Rust store member yet; served later as 'facts'
  hasBeliefEvents: 'belief_ledger',
  listVersionTrustTiers: 'pages', // held: no Rust store member yet; served later as 'page_versions'
  listPageRefsByIds: 'pages',
  listPageTrustTiersByKey: 'pages',
  lockLivePagesByKey: 'pages',
  listValidTimeIdentities: 'pages',
  pickValidTimeEdition: 'pages', // held: no Rust store member yet; served later as 'page_versions'
  listAmendmentsNotApplied: 'links',
  readPageVersionEdition: 'pages', // held: no Rust store member yet; served later as 'page_versions'
  readCursorEdition: 'pages', // held: no Rust store member yet; served later as 'page_versions'
  pageAwaitsRederive: 'pages',
  listGuardedTakeRows: 'takes',
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
