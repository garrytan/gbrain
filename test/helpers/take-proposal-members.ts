/**
 * Adds the sixteen take-proposal engine members, and the three extract bookkeeping members the propose_takes receipt
 * and rollup writes use, to a hand-built mock engine. Each member runs the real engine-sql/take-proposals.ts or
 * engine-sql/extract-bookkeeping.ts statement over the mock's own executeRaw, so a mock that answers by SQL text keeps
 * seeing the same statements the PGLite and Postgres engines send. A member the mock already defines stays.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import * as bookkeeping from '../../src/core/engine-sql/extract-bookkeeping.ts';
import * as proposals from '../../src/core/engine-sql/take-proposals.ts';

const MEMBERS = [
  'listPendingTakeProposals', 'readTakeProposal', 'claimTakeProposal', 'readStrandedTakeProposalClaim',
  'releaseTakeProposalClaim', 'setTakeProposalPromotedRow', 'rejectTakeProposal', 'takeProposalCached',
  'listRejectedTakeProposalClaims', 'insertTakeProposal', 'listTakeProposalTombstones', 'deleteTakeProposalTombstones',
  'listProposeTakesCandidatePages', 'readOpCheckpointDoc', 'writeOpCheckpointDoc', 'listWriteRequestsByRequestId',
  'readExtractReceiptSlot', 'readExtractReceiptSeal', 'upsertExtractRollupDay',
] as const;

export function withTakeProposalMembers<E extends object>(engine: E): E {
  const target = engine as Record<string, unknown>;
  const fns = { ...proposals, ...bookkeeping } as unknown as Record<string, (tx: unknown, ...a: unknown[]) => unknown>;
  for (const name of MEMBERS) {
    if (typeof target[name] === 'function') continue;
    target[name] = function (this: unknown, ...a: unknown[]) { return fns[name]!(engine as unknown as BrainEngine, ...a); };
  }
  return engine;
}
