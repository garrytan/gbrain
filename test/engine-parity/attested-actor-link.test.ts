/**
 * BrainEngine parity: the attested-actor link read (access/actor.ts `linkedMember`, engine member `readLinkedMember`)
 * and the coverage check built on it (`actorCoverage`), on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a person id linked to an enabled member resolves to that member, its groups in order and its identity;
 *    an unlinked id, an id of another system, an id in another case, a disabled member and a removed member resolve to
 *    nothing, and actorCoverage then refuses with actor_unlinked. Enabling the member again restores the link. A
 *    caller whose attest right names another system is refused before the link is read.
 *  - Regression: an engine that sends the link join as raw SQL (the Rust engine refuses it, so every attested call
 *    there failed), matches the id loosely, keeps reading a disabled or removed member, or drops or reorders groups.
 *  - Why existing coverage misses it: test/access-qm-actor.test.ts and test/qm-memory-tools.test.ts run on PGLite
 *    (and a fault stub) only.
 *  - Seam: none. Real engines; members and links are written through access/members.ts and access/actor.ts. The
 *    caller carries its live attest right (as a verified HTTP call does), so no credential row is read.
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { addMember, removeMember } from '../../src/core/access/members.ts';
import { actorCoverage, linkedMember, linkMember } from '../../src/core/access/actor.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** A live HTTP caller holding the attest right for `system`. */
const caller = (system: string) => ({ auth: { attest: { system, ops: ['recall'], sources: null } }, principal: { kind: 'oauth_client', id: 'parity-attest' } }) as never;

/** The coverage answer as a caller sees it: the member and identity, or the refusal's code. */
async function coverage(engine: BrainEngine, system: string, externalId: string): Promise<unknown> {
  try {
    const covered = await actorCoverage(engine, caller(system), { system: 'qm', external_id: externalId });
    return { member: covered.member, groups: covered.groups, identity: covered.identity };
  } catch (error) {
    if (error instanceof OperationError) return { refused: error.code };
    throw error;
  }
}

describe('engine parity: the attested-actor link read', () => {
  parityTest('a linked id resolves to its enabled member with groups and identity, and to nothing once unlinked, disabled or removed',
    { methods: ['insertAccessMember', 'insertAccessMemberLink', 'readLinkedMember', 'setAccessMemberDisabled', 'tombstoneAccessMember'], timeout: 120_000 },
    async (engine: BrainEngine) => {
      await addMember(engine, 'alice-example', { name: 'Alice', groups: ['team-b', 'team-a'] });
      await addMember(engine, 'bob-example', { name: 'Bob' });
      await linkMember(engine, 'alice-example', 'qm', 'person-1');
      await linkMember(engine, 'bob-example', 'qm', 'person-2');
      const out: Record<string, unknown> = {
        alice: await linkedMember(engine, 'qm', 'person-1'),
        bob: await linkedMember(engine, 'qm', 'person-2'),
        otherSystem: await linkedMember(engine, 'other', 'person-1'),
        otherCase: await linkedMember(engine, 'qm', 'PERSON-1'),
        unlinked: await linkedMember(engine, 'qm', 'person-3'),
        covered: await coverage(engine, 'qm', 'person-1'),
        coveredUnlinked: await coverage(engine, 'qm', 'person-3'),
        coveredOtherRight: await coverage(engine, 'other', 'person-1'),
      };
      await engine.setAccessMemberDisabled('alice-example', true);
      out.disabled = await linkedMember(engine, 'qm', 'person-1');
      out.coveredDisabled = await coverage(engine, 'qm', 'person-1');
      await engine.setAccessMemberDisabled('alice-example', false);
      out.enabledAgain = await linkedMember(engine, 'qm', 'person-1');
      await removeMember(engine, 'bob-example');
      out.removed = await linkedMember(engine, 'qm', 'person-2');
      const want = {
        alice: { member: 'alice-example', groups: ['team-a', 'team-b'], identity: ['group:team-a', 'group:team-b', 'member:alice-example'] },
        bob: { member: 'bob-example', groups: [], identity: ['member:bob-example'] },
        otherSystem: null, otherCase: null, unlinked: null,
        covered: { member: 'alice-example', groups: ['team-a', 'team-b'], identity: ['group:team-a', 'group:team-b', 'member:alice-example'] },
        coveredUnlinked: { refused: 'actor_unlinked' },
        coveredOtherRight: { refused: 'actor_not_attested' },
        disabled: null,
        coveredDisabled: { refused: 'actor_unlinked' },
        enabledAgain: { member: 'alice-example', groups: ['team-a', 'team-b'], identity: ['group:team-a', 'group:team-b', 'member:alice-example'] },
        removed: null,
      };
      if (JSON.stringify(out) !== JSON.stringify(want)) throw new Error(`linked member: ${JSON.stringify(out)}`);
      return out;
    });
});
