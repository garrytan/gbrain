/**
 * GST-2543: gbrain mcp verify's write check passes for a credential bound to a member, writes its fixture the way that
 * credential may (a member's fact stays private on its own member page, never shared), reads it back and withdraws it.
 * 1. Protects: fact mode and page mode for a non-owner member, the owner and an unbound credential, on a repo-less brain.
 * 2. Fails when: the verifier's remember sends visibility "world", which a member credential is refused
 *    (member_share_required), or a member's fixture becomes readable by another member.
 * 3. Real seams: tokens minted by the token service and bound with SQL, verified by the serve --http verifier, every
 *    verifier call dispatched through MCP dispatch with remote=true. Synthetic names only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { verifyHarnessConnection, type VerificationPeer } from '../src/core/harness/verify.ts';
import type { HarnessCredentials } from '../src/core/harness/credentials.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const WHO = ['alice', 'owner', 'unbound'] as const;
type Who = typeof WHO[number];

for (const kind of testBackends()) {
  describe('mcp verify with a member-bound credential (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, op: string, params: Record<string, unknown>) {
      const auth = await provider().verifyAccessToken(tokens[who]) as unknown as AuthInfo;
      return dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: ['world'] });
    }

    function peerFor(who: Who, errors: string[]): VerificationPeer {
      return {
        connect: async () => {}, close: async () => {},
        readCapabilities: async () => ({ transport: 'oauth', client_id: 'gbrain_cl_verify_' + who, scopes: ['read', 'write'], source_id: 'default' }),
        call: async (name, params) => {
          const out = await call(who, name, params);
          const text = out.content.map(c => c.text).join('\n');
          if (out.isError) { errors.push(name + ': ' + text); throw new Error('tool_error'); }
          return JSON.parse(text);
        },
      };
    }

    const credentials = (who: Who, profile: string): HarnessCredentials => ({ version: 1, client_id: 'gbrain_cl_verify_' + who,
      mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com', access_token: 'fixture-token', source_id: 'default', profile });

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      for (const id of ['owner-example', 'alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await setOwner(engine, 'owner-example');
      for (const [name, member] of [['owner', 'owner-example'], ['alice', 'alice-example'], ['bob', 'bob-example'], ['unbound', null]] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'] });
        tokens[name] = minted.token;
        if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
        else await readsUnscopedOnPurpose(engine, minted.id);
      }
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    for (const who of WHO) {
      test('fact mode: every stage passes for ' + who + ', and the fixture is withdrawn', async () => {
        const errors: string[] = [];
        const report = await verifyHarnessConnection(credentials(who, 'memory-writer'), { peer: peerFor(who, errors), timeoutMs: 60_000 });
        expect(errors).toEqual([]);
        expect(report.stages.filter(s => s.status !== 'passed' && s.status !== 'not_requested')).toEqual([]);
        for (const name of ['write', 'write_readback', 'cleanup']) expect(report.stages.find(s => s.name === name)?.status).toBe('passed');
        expect(await engine.executeRaw("SELECT id FROM facts WHERE fact = $1 AND expired_at IS NULL", [report.fixture])).toEqual([]);
      }, 240_000);
    }

    test('fact mode: a member\'s fixture is saved private on its own member page, so another member never reads it', async () => {
      const errors: string[] = [];
      const seen: string[] = [];
      const base = peerFor('alice', errors);
      const peer: VerificationPeer = { ...base, call: async (name, params) => {
        const out = await base.call(name, params);
        if (name === 'remember') {
          const rows = await engine.executeRaw<{ visibility: string; page: string | null }>(
            'SELECT visibility, source_markdown_slug AS page FROM facts WHERE fact = $1', [params.fact]);
          const other = await call('bob', 'recall', { grep: String(params.fact) });
          seen.push(JSON.stringify({ rows, bob_reads_it: other.content.map(c => c.text).join('\n').includes(String(params.fact)) }));
        }
        return out;
      } };
      const report = await verifyHarnessConnection(credentials('alice', 'memory-writer'), { peer, timeoutMs: 60_000 });
      expect(errors).toEqual([]);
      expect(report.stages.find(s => s.name === 'write_readback')?.status).toBe('passed');
      expect(seen).toEqual([JSON.stringify({ rows: [{ visibility: 'private', page: 'memory/members/alice-example' }], bob_reads_it: false })]);
    }, 240_000);

    test('fact mode: an unbound credential still shares its fixture explicitly, so a private brain default keeps it readable', async () => {
        await engine.setConfig('facts.default_visibility', 'private');
        try {
          const errors: string[] = [];
          const report = await verifyHarnessConnection(credentials('unbound', 'memory-writer'), { peer: peerFor('unbound', errors), timeoutMs: 60_000 });
          expect(errors).toEqual([]);
          for (const name of ['write', 'write_readback', 'cleanup']) expect(report.stages.find(s => s.name === name)?.status).toBe('passed');
        } finally {
          await engine.executeRaw("DELETE FROM config WHERE key = 'facts.default_visibility'");
        }
      }, 240_000);

    for (const who of WHO) {
      test('page mode: every stage passes for ' + who + ', and the fixture page is soft-deleted', async () => {
        const errors: string[] = [];
        const report = await verifyHarnessConnection(credentials(who, 'coding-agent'), { peer: peerFor(who, errors), timeoutMs: 60_000 });
        expect(errors).toEqual([]);
        expect(report.stages.filter(s => s.status !== 'passed' && s.status !== 'not_requested')).toEqual([]);
        for (const name of ['write', 'write_readback', 'cleanup']) expect(report.stages.find(s => s.name === name)?.status).toBe('passed');
        expect(await engine.executeRaw("SELECT slug FROM pages WHERE slug = $1 AND deleted_at IS NULL", [report.cleanup?.slug])).toEqual([]);
      }, 240_000);
    }
  });
}
