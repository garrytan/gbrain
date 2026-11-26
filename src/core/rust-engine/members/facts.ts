/** The facts, ontology, trust, open loop and entity identity members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const FACTS_MEMBERS = {
  loadPurgeTarget: 'pages', // held: no Rust store member yet; served later as 'facts'
  insertFactPurge: 'pages', // held: no Rust store member yet; served later as 'facts'
  insertTakePurge: 'pages', // held: no Rust store member yet; served later as 'facts'
  upsertPagePurges: 'pages', // held: no Rust store member yet; served later as 'facts'
  countPurgeProbe: 'pages', // held: no Rust store member yet; served later as 'facts'
  listPurgeProbeItems: 'pages', // held: no Rust store member yet; served later as 'facts'
  setPurgeProbeTimeout: 'pages', // held: no Rust store member yet; served later as 'facts'
  probePurgeDerivations: 'pages', // held: no Rust store member yet; served later as 'facts'
  countPagePurgeTombstones: 'pages', // held: no Rust store member yet; served later as 'facts'
  listPurgeEffects: 'pages', // held: no Rust store member yet; served later as 'facts'
  deletePurgeReviewQueue: 'pages', // held: no Rust store member yet; served later as 'facts'
  deletePurgeReviewProposals: 'pages', // held: no Rust store member yet; served later as 'facts'
  deletePurgeDecideProposals: 'pages', // held: no Rust store member yet; served later as 'facts'
  listFactProvenance: 'pages', // held: no Rust store member yet; served later as 'facts'
  listSlotRows: 'pages', // held: no Rust store member yet; served later as 'facts'
  isFactPurged: 'pages', // held: no Rust store member yet; served later as 'facts'
  // trust: the write gate's receipts and holds (engine-sql/trust-write-gate.ts)
  upsertWriteGateReceipt: 'pages', // held: no Rust store member yet; served later as 'facts'
  listWriteGateReceiptsFor: 'pages', // held: no Rust store member yet; served later as 'facts'
  upsertWriteGateHold: 'pages', // held: no Rust store member yet; served later as 'facts'
  listWriteGateHoldRows: 'pages', // held: no Rust store member yet; served later as 'facts'
  getWriteGateHoldRow: 'pages', // held: no Rust store member yet; served later as 'facts'
  // trust: the trust decision queue (engine-sql/trust-proposals.ts)
  insertTrustProposal: 'pages', // held: no Rust store member yet; served later as 'facts'
  getTrustProposal: 'pages', // held: no Rust store member yet; served later as 'facts'
  listTrustProposals: 'pages', // held: no Rust store member yet; served later as 'facts'
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
