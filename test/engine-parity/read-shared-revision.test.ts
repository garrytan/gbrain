/**
 * BrainEngine parity: the writes of the read-shared switch (GST-2898) that ran through `executeRaw`: a client grant
 * write's re-stamp (src/core/grants/service.ts stampReadShared), `invalidate-tokens` keeping a switched client switched
 * at its new revision (src/core/grants/lifecycle.ts mutateClientLifecycle) and a token rescope's re-stamp
 * (src/core/grants/legacy-token.ts rescopeLegacyToken).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each site leaves the same `read_shared_revision` on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): the grant revision while the switch is on, NULL once it is
 *    off, and nothing written while it stays off.
 *  - Regression: an engine that drops the stamp turns a switched credential's shared reads off at its next revision, and
 *    one that keeps a stale stamp leaves the switch on after `--read-shared off`; the Rust engine refused every site.
 *  - Why existing coverage misses it: the sites ran through `executeRaw`, which the parity cases cannot call (D18), so
 *    test/engine-parity/oauth-lifecycle.test.ts and access-tokens.test.ts never seeded a switched credential.
 *  - Seam: none. Real engines and the real grant functions; the rows are read through typed members only
 *    (readOauthClient, lockActiveAccessTokens). A switched client is seeded through stampReadShared itself, because no insert
 *    member takes the switch.
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { stampReadShared } from '../../src/core/grants/service.ts';
import { mutateClientLifecycle } from '../../src/core/grants/lifecycle.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../../src/core/grants/legacy-token.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const clientStamp = async (engine: BrainEngine, id: string) => {
  const row = await engine.readOauthClient(id) as { grant_revision?: unknown; read_shared_revision?: unknown } | null;
  return { revision: row?.grant_revision == null ? null : Number(row.grant_revision),
    readShared: row?.read_shared_revision == null ? null : Number(row.read_shared_revision) };
};

const tokenStamp = async (engine: BrainEngine, id: string) => {
  const [row] = await engine.transaction(tx => tx.lockActiveAccessTokens({ id }));
  return { revision: row?.grant_revision == null ? null : Number(row.grant_revision),
    readShared: row?.read_shared_revision == null ? null : Number(row.read_shared_revision) };
};

describe('engine parity: the read-shared switch writes', () => {
  parityTest('stampReadShared stamps a client at its grant revision, clears it, and writes nothing while the switch stays off',
    { methods: ['insertOauthClient', 'readOauthClient'] }, async (engine) => {
      await engine.insertOauthClient({ client_id: 'c-stamp', client_name: 'c-stamp', scope: 'read' });
      const out: Record<string, unknown> = { born: await clientStamp(engine, 'c-stamp') };
      await engine.transaction(tx => stampReadShared(tx, 'c-stamp', false, 4, false));
      out.offStaysOff = await clientStamp(engine, 'c-stamp');
      await engine.transaction(tx => stampReadShared(tx, 'c-stamp', true, 3, false));
      out.on = await clientStamp(engine, 'c-stamp');
      await engine.transaction(tx => stampReadShared(tx, 'c-stamp', true, 5, true));
      out.restamped = await clientStamp(engine, 'c-stamp');
      await engine.transaction(tx => stampReadShared(tx, 'c-stamp', false, 6, true));
      out.off = await clientStamp(engine, 'c-stamp');
      return out;
    });

  parityTest('invalidate-tokens keeps a switched client switched at its new revision and leaves an unswitched one off',
    { methods: ['insertOauthClient', 'readOauthClient', 'readOauthClientForUpdate', 'deleteOauthClientTokens', 'deleteOauthClientCodes',
      'setOauthClientRevision', 'insertOauthGrantAudit'] }, async (engine) => {
      await engine.insertOauthClient({ client_id: 'c-on', client_name: 'c-on', scope: 'read' });
      await engine.insertOauthClient({ client_id: 'c-off', client_name: 'c-off', scope: 'read' });
      // Switched at its current revision (0), as a grant write leaves it.
      await engine.transaction(tx => stampReadShared(tx, 'c-on', true, 0, false));
      const out: Record<string, unknown> = { before: await clientStamp(engine, 'c-on') };
      for (const id of ['c-on', 'c-off']) {
        const preview = await mutateClientLifecycle(engine, id, 'invalidate-tokens', { actor: 'admin' });
        await mutateClientLifecycle(engine, id, 'invalidate-tokens', { actor: 'admin', dryRun: false, yes: true, expectedRevision: preview.before.revision });
        out[id] = await clientStamp(engine, id);
      }
      return out;
    });

  parityTest('a token rescope re-stamps a switched token at its new revision, and --read-shared off clears it',
    { methods: ['insertAccessToken', 'lockActiveAccessTokens', 'writeAccessTokenGrant'] }, async (engine) => {
      const on = await mintLegacyToken(engine, { name: 't-on', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: ['default'], readShared: true });
      const plain = await mintLegacyToken(engine, { name: 't-plain', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: ['default'] });
      const out: Record<string, unknown> = { born: await tokenStamp(engine, on.id) };
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['t-on', '--takes-holders', 'world']));
      out.kept = await tokenStamp(engine, on.id);
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['t-on', '--read-shared', 'off']));
      out.off = await tokenStamp(engine, on.id);
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['t-plain', '--takes-holders', 'world']));
      out.plain = await tokenStamp(engine, plain.id);
      return out;
    });
});
