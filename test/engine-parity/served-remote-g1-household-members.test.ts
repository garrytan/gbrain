/**
 * BrainEngine parity: the member read behind a remote household_due placement check over the served wire (readAccessMembers, by member id).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded or served) a remote caller's memberIdentity
 *    (access/members.ts, the read household/placement.ts readerCovered makes for each stored reader of a household record) reads one
 *    member by id: an enabled member answers with its id and groups, an unknown id is refused as no member, and a disabled member is
 *    refused as disabled.
 *  - Regression: on the served arm readAccessMembers was refused for a remote caller (not on OWNER_IPC_REMOTE_TYPED_READS), so every
 *    reader check failed with a typed engine_capability_missing refusal.
 *  - Why existing coverage misses it: household-remote.test.ts runs on PGLite only; access-member-reads.test.ts calls the member on
 *    the arm's own engine with no remote caller.
 *  - Seam: members and groups come from `createMember` (harness.ts, harness-only SQL on the SQL arms, the store's member records on the
 *    Rust arm). The whole household_due operation is not the proof: on the served arm its first step, brainServes, also needs
 *    listActiveAccessMembers, which no served group owns, so the by-id read is called through memberIdentity under a remote caller.
 */
import { expect } from 'bun:test';
import { createMember, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withRemoteCaller } from '../../src/core/remote-caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { memberIdentity } from '../../src/core/access/members.ts';

const { parityTest } = parityArms(testBackends());

const worldOnly = <T>(fn: () => Promise<T>) => withRemoteCaller(true, () => withCallerAccess({ identity: [], audience: null, audienceIdentities: [] }, fn));
const refusal = (fn: () => Promise<unknown>) => fn().then(() => 'answered', (e: { code?: string; message?: string }) => `${e.code ?? 'error'}:${String(e.message).slice(0, 60)}`);

parityTest('a remote caller reads one member by id: an enabled member answers with its groups, a disabled or unknown id is refused', {
  methods: ['readAccessMembers'], timeout: 240_000,
}, async (engine: BrainEngine, backend) => {
  await createMember(engine, backend, { id: 'bob-example', email: 'bob-secret@example.com', groups: ['household-adults'] });
  await createMember(engine, backend, { id: 'casey-example', email: 'casey-secret@example.com', groups: ['household-helpers'] });
  await createMember(engine, backend, { id: 'dave-example', state: 'disabled', groups: ['household-helpers'] });
  const bob = await worldOnly(() => memberIdentity(engine, 'bob-example'));
  const casey = await worldOnly(() => memberIdentity(engine, 'casey-example'));
  expect(bob.groups).toEqual(['household-adults']);
  expect(casey.groups).toEqual(['household-helpers']);
  const disabled = await refusal(() => worldOnly(() => memberIdentity(engine, 'dave-example')));
  const unknown = await refusal(() => worldOnly(() => memberIdentity(engine, 'nobody-example')));
  expect(disabled).toContain('disabled');
  expect(unknown).toContain('No member');
  return { bob, casey, disabled, unknown };
});
