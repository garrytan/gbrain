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
 *  - Bearer checks: a switched legacy token and a switched OAuth client read the same set through the provider
 *    `serve --http` builds, and a switched token reads a shared-source page through the legacy MCP transport. The
 *    callers passed their SqlQuery tag, which the Rust engine refuses, so there the key read its stored list alone.
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
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { stampReadShared } from '../../src/core/grants/service.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { startHttpTransport } from '../../src/mcp/http-transport.ts';
import { RateLimiter } from '../../src/mcp/rate-limit.ts';
import { hashToken } from '../../src/core/utils.ts';
import { archiveSource, createSource, OWNER_ONLY_STOP, parityArms, stopOnOwnerOnlyRefusal, type ParityBackend } from './harness.ts';
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

  parityTest('serve --http bearer check: a switched legacy token and a switched OAuth client read the shared set, resolved',
    { methods: ['setConfig', 'insertOauthClient', 'insertOauthToken'] }, async (engine, backend) => {
      await seed(engine, backend);
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine });
      const minted = await mintLegacyToken(engine, { name: 't-shared', scopes: ['read'], takesHolders: ['world'], sourceGrant: ['private-src'], readShared: true });
      await engine.insertOauthClient({ client_id: 'c-shared', client_name: 'c-shared', scope: 'read', source_id: 'private-src', federated_read: ['private-src'], client_id_issued_at: 1_700_000_000 });
      await engine.transaction(tx => stampReadShared(tx, 'c-shared', true, 0, false));
      await engine.insertOauthToken({ token_hash: hashToken('ot-shared'), token_type: 'access', client_id: 'c-shared', scopes: ['read'],
        expires_at: Math.floor(Date.now() / 1000) + 3600, resource: null, created_at: Math.floor(Date.now() / 1000), grant_type: 'client_credentials' });
      const reads = async (token: string) => {
        const a = await provider.verifyAccessToken(token) as unknown as Record<string, unknown>;
        return { sourceId: a.sourceId, allowedSources: a.allowedSources, readShared: a.readShared, unresolved: a.readSharedUnresolved ?? false };
      };
      const out = { token: await reads(minted.token), client: await reads('ot-shared') };
      // Not vacuous: each key reads the shared source `team`, not its stored list alone.
      for (const [k, v] of Object.entries(out)) if (v.unresolved || !(v.allowedSources as string[] | undefined)?.includes('team')) throw new Error(`${k} read less: ${JSON.stringify(v)}`);
      return out;
    });

  parityTest('the legacy MCP transport: a switched token reads a page in a shared source',
    // While the Rust store is multi-user the owner-only session gate refuses this non-owner key (L4 opens it); nothing is read.
    { methods: ['setConfig'], rustMultiuserStop: OWNER_ONLY_STOP() }, async (engine, backend) => {
      await seed(engine, backend);
      await importFromContent(engine, 'wiki/roadmap', ['---', 'type: note', 'title: Roadmap', '---', '# Roadmap', '', 'Harbor rsharedroadmap.'].join('\n'), { sourceId: 'team' });
      const minted = await mintLegacyToken(engine, { name: 't-mcp', scopes: ['read'], takesHolders: ['world'], sourceGrant: ['private-src'], readShared: true });
      const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }), token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }) } });
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page', arguments: { slug: 'wiki/roadmap' } } }) });
        const text = await res.text();
        stopOnOwnerOnlyRefusal(text);
        const out = { status: res.status, readsTheSharedPage: text.includes('rsharedroadmap'), unresolvedNotice: text.includes('read_shared_unresolved') };
        if (!out.readsTheSharedPage) throw new Error(`the shared page was not read: ${text.slice(0, 300)}`);
        return out;
      } finally {
        server.stop(true);
      }
    });
});
