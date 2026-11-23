/**
 * BrainEngine parity — the reply to a held write as a world-only caller reads it (trust/privacy-hold-reply.ts
 * hidePrivacyHoldRefs), through the privacy-hold readability read (listUnreadablePrivacyHoldIds).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a `contested` ref naming a privacy hold (a supersede_fact proposal whose before state names a visibility)
 *    stays in the reply only when the caller's widened world-only fact reads admit the hold's private fact: a fact on
 *    the member caller's own member page (memberFactAdmitSql), or a fact in a source of the caller's private-facts
 *    grant whose pages keep it private for no reason (grantedPrivateFactSql), whether the grant is the read's own or the
 *    one a write's reply is checked under. A hold on a missing fact or on any other private fact is dropped, a ref that
 *    is not a privacy hold always stays, and a caller nothing widens loses every hold. Every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1) keeps the same refs.
 *  - Regression: the readability join ran through executeRaw, so on a Rust brain the read was refused, the reply failed
 *    closed and every hold was hidden, even from the member who owns the fact and from a granted caller.
 *  - Why existing coverage misses it: test/held-private-replies-2900.test.ts runs on PGLite and Postgres only.
 *  - Seam: none. Pages, facts and proposals are written through the typed members; refs are named by the fact text.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { hidePrivacyHoldRefs } from '../../src/core/trust/privacy-hold-reply.ts';
import { trustProposalRef } from '../../src/core/trust/proposals.ts';
import { CALLERS, fixture } from './fact-widening-fixture.ts';

const { parityTest } = parityArms(testBackends());

const HELD = ['own member fact', 'other member fact', 'granted fact', 'private holding fact', 'readers holding fact',
  'quarantined holding fact', 'missing holding fact', 'unpaged fact', 'transcript fact', 'private entity fact'];

/** A privacy hold on each private fact of the fixture, one on a missing fact and a guarded supersession; refs by name. */
async function holds(engine: BrainEngine): Promise<Map<string, string>> {
  const facts = await engine.listFactsSince('default', new Date(Date.UTC(2000, 0, 1)), { limit: 100 });
  const idOf = new Map(facts.map(f => [f.fact, Number(f.id)]));
  const names = new Map<string, string>();
  const file = async (name: string, target: number, before: Record<string, unknown>) => {
    const { id } = await engine.insertTrustProposal({ action: 'supersede_fact', sourceId: 'default', target: { table: 'facts', id: target },
      before, after: { fact: 'restated' }, proposer: 'parity' });
    names.set(trustProposalRef(id), name);
  };
  for (const name of HELD) await file(name, idOf.get(name)!, { visibility: 'private' });
  await file('a deleted fact', 999_999, { visibility: 'private' });
  await file('a guarded supersession', idOf.get('world fact')!, { trust_tier: 'user_confirmed' });
  return names;
}

describe('engine parity: a held write\'s reply as a world-only caller reads it', () => {
  parityTest(
    'each caller keeps the holds whose private fact it reads, and every ref that is not a privacy hold',
    { methods: ['putPage', 'insertFacts', 'listFactsSince', 'insertTrustProposal', 'getTrustProposal', 'listUnreadablePrivacyHoldIds'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await fixture(engine);
      const names = await holds(engine);
      const refs = [...names.keys()];
      const reply = { status: 'saved', contested: { proposal_ref: refs[0]!, proposal_refs: refs } };
      const kept = async (caller: Record<string, unknown>, grant?: string[]) => {
        const out = await withCallerAccess(caller, () => hidePrivacyHoldRefs(engine, true, reply, grant)) as { contested?: { proposal_ref: string; proposal_refs?: string[] } };
        const c = out.contested;
        return c ? (c.proposal_refs ?? [c.proposal_ref]).map(r => names.get(r) ?? 'other').sort() : [];
      };
      const out = {
        plain: await kept(CALLERS.plain),
        member: await kept(CALLERS.alice),
        granted: await kept(CALLERS.granted),
        grantedOther: await kept(CALLERS.grantedOther),
        memberGranted: await kept(CALLERS.aliceGranted),
        writeUnderGrant: await kept(CALLERS.plain, ['default']),
        memberWriteUnderGrant: await kept(CALLERS.alice, ['default']),
      };
      // Not vacuous: the member keeps its own fact's hold and a grant keeps the open fact's hold, on every arm.
      expect(out.plain).toEqual(['a guarded supersession']);
      expect(out.member).toEqual(['a guarded supersession', 'own member fact']);
      expect(out.granted).toEqual(['a guarded supersession', 'granted fact']);
      expect(out.writeUnderGrant).toEqual(out.granted);
      return out;
    },
  );
});
