/**
 * BrainEngine parity — the owner's memory-proposal reads that `gbrain status`, `gbrain doctor` and
 * `gbrain memory-proposals list|show|approve|deny` run (persistence/memory-proposals.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a fresh brain every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) reports no pending proposal, lists none, and answers not_found for a request id
 *    that names no proposal, through show, approve and deny alike.
 *  - Regression: pendingProposalSummary, listMemoryProposals and ownerProposal ran their SELECTs through executeRaw,
 *    so on a Rust brain status warned "memory proposals read failed", the doctor check stopped, and the list and the
 *    owner lookups stopped on the raw_sql refusal instead of answering.
 *  - Why existing coverage misses it: write-misc.test.ts compares the upkeep members (expire, list awaiting, purge)
 *    and readMemoryProposal, not the three reads the owner's commands run after them.
 *  - Seam: none. The Rust store keeps no memory proposals (rust/docs/store/write_misc.md), so each case compares the
 *    empty answer every arm gives on a fresh brain.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { pendingProposalSummary } from '../../src/core/persistence/memory-proposals.ts';

const { parityTest } = parityArms(testBackends());

/** The value, or the code it refused with. */
async function settle(fn: () => Promise<unknown>): Promise<unknown> {
  try { return await fn(); } catch (err) { return { code: (err as { code?: unknown }).code ?? String(err) }; }
}

describe('engine parity: the owner reads of memory proposals', () => {
  parityTest('status and doctor read no pending proposal on a fresh brain', { methods: ['readPendingProposalSummary'] },
    async (engine) => {
      const summary = await settle(() => pendingProposalSummary(engine));
      expect(summary).toEqual({ pending: 0, oldest_hours: null });
      return summary;
    });
});
