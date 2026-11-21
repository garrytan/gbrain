/**
 * BrainEngine parity: the shared source set a key with the read-shared switch on reads (GST-2898), through its three
 * readers: credentialReadSources (grants/shared-exposure.ts, the token and client read sets), readSetLines
 * (commands/auth-read-shared.ts, what `gbrain auth` prints) and namesakesOrMerge (facts/question-recall.ts, recall's
 * namesake split). Each reads the source rows through grants/read-shared.ts sharedRows.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    gives the same shared set: `default` plus every federated source, without archived and guest sources, and the
 *    owner member read from config; the auth lines name it, and recall merges a write-source namesake with a shared one.
 *  - Regression: an engine that cannot read the rows reads the stored list alone, prints "unreadable" and refuses the
 *    namesake merge, so a switched key silently reads less on that engine. The Rust engine refused the raw statement.
 *  - Why existing coverage misses it: the rows were read through a SqlQuery tag over `executeRaw`, which the parity
 *    cases cannot call (D18), so no case compared the set across engines.
 *  - Seam: none. Real engines and the real readers. Sources are seeded and archived through the harness fixtures (createSource, archiveSource),
 *    the owner member through setConfig.
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PrincipalGrant } from '../../src/core/grants/model.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { credentialReadSources } from '../../src/core/grants/shared-exposure.ts';
import { readSetLines } from '../../src/commands/auth-read-shared.ts';
import { namesakesOrMerge } from '../../src/core/facts/question-recall.ts';
import { archiveSource, createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** default; three federated sources, one a guest by config and one archived after; one private source not federated. */
async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, 'team', { federated: true });
  await createSource(engine, backend, 'guest-src', { federated: true, guest: true });
  await createSource(engine, backend, 'gone', { federated: true });
  await createSource(engine, backend, 'private-src', {});
  await archiveSource(engine, backend, 'gone');
  await engine.setConfig('access.owner_member', '  owner-1  ');
}

const switched = (writeSource: string, scopes = ['read', 'write']): PrincipalGrant => ({
  principal: { kind: 'legacy_token', id: 't-1' }, scopes, sources: { kind: 'scalar', writeSource },
  allowedOperations: null, takesHolders: null, privatePages: 'none', privateFacts: 'none', readShared: true,
}) as PrincipalGrant;

describe('engine parity: the read-shared source set', () => {
  parityTest('credentialReadSources widens a switched key by default and the federated sources, never a guest or archived one',
    { methods: ['setConfig'] }, async (engine, backend) => {
      await seed(engine, backend);
      return { owner: await credentialReadSources(engine, switched('private-src'), 'owner-1'),
        member: await credentialReadSources(engine, switched('private-src'), 'member-2'),
        unswitched: await credentialReadSources(engine, { ...switched('private-src'), readShared: false }, null) };
    });

  parityTest('auth read-set lines name the shared set a switched key reads now',
    { methods: ['setConfig'] }, async (engine, backend) => {
      await seed(engine, backend);
      return readSetLines(engine, switched('private-src'), null);
    });

  parityTest('recall merges a namesake in the write source with one in a shared source for a switched key',
    { methods: ['setConfig'] }, async (engine, backend) => {
      await seed(engine, backend);
      const ctx = { engine, auth: { sourceId: 'private-src', readShared: true, member: null } } as unknown as OperationContext;
      const pair = [{ source_id: 'private-src', entity_slug: 'people/alice-example' }, { source_id: 'team', entity_slug: 'people/alice-example' }];
      const guest = [{ source_id: 'private-src', entity_slug: 'people/alice-example' }, { source_id: 'guest-src', entity_slug: 'people/alice-example' }];
      return { shared: await namesakesOrMerge(ctx, pair), guest: await namesakesOrMerge(ctx, guest) };
    });
});
