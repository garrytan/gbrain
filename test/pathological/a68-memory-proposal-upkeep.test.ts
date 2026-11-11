/**
 * A-68 (GBRA-130, hardening: the trigger is a stored authority the upkeep pass cannot read): one held memory proposal
 * whose authority check throws something unexpected never stops the memory-proposal upkeep pass
 * (src/core/persistence/memory-proposals.ts runMemoryProposalUpkeep, run by consumer maintenance).
 *
 * Protects: a proposal whose authority check throws an error other than actor_unlinked, actor_not_attested or
 * permission_denied is counted in `failed` and left awaiting the owner; the proposals behind it are still checked
 * (an unlinked person's closes failed), overdue ones still expire, and the retention purge still runs. Those three codes
 * still close the proposal failed (permission_denied is decided before ItemRun, which treats it as run-scoped). A
 * run-scoped failure or a systemic run stops the pass before the purge.
 * Fails when: the per-row loop rethrows every unexpected error (one row stops upkeep for every row behind it on every
 * run), or a run-scoped failure is swallowed.
 * Seams: none in production; the unreadable authority is a stored JSON null, run-scoped errors come from an engine
 * wrapper. PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { linkMember, unlinkMember } from '../../src/core/access/actor.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runMemoryProposalUpkeep } from '../../src/core/persistence/memory-proposals.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { expectUnitNotAborted, pathologicalArms, runScopedErrors } from './harness.ts';

const SRC = 'qm-upkeep';
const ACME = 'companies/acme-example';
const ALICE_ID = 'alice-example@acme.test';
const BOB_ID = 'U0BOB';
const CAROL_ID = 'U0CAROL';
const ATTEST_OPS = ['cancel_write_request', 'get_write_request', 'list_write_requests', 'memory_propose'];

interface Seeded { poison: string[]; unlinked: string; overdue: string; healthy: string; old: string }

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-68 memory-proposal upkeep (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let bearer = '';
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function propose(actor: string, summary: string): Promise<string> {
      const auth = await provider().verifyAccessToken(bearer) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, 'memory_propose',
        { idempotency_key: randomUUID(), kind: 'timeline', target: ACME, date: '2026-10-30', summary, source: 'slack:C0123/p1' },
        { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'], actor: { header: actor } });
      expect({ summary, isError: out.isError === true }).toEqual({ summary, isError: false });
      return (out.structuredContent as { request_id: string }).request_id;
    }

    const at = (id: string, sql: string) => engine.executeRaw(`UPDATE memory_proposals SET ${sql} WHERE request_id = $1::uuid`, [id]);
    const states = async () => new Map((await engine.executeRaw<{ request_id: string; state: string; error_code: string | null }>(
      'SELECT request_id::text AS request_id, state, error_code FROM memory_proposals')).map(r => [r.request_id, r.error_code ? `${r.state}:${r.error_code}` : r.state]));

    /**
     * In scan order: `poisons` proposals whose stored authority is JSON null (authorizeWrite throws a TypeError), carol's
     * proposal (carol is then unlinked, so it closes actor_unlinked) and bob's healthy one; plus an overdue proposal and a
     * denied one past retention.
     */
    async function seed(poisons: number): Promise<Seeded> {
      await engine.executeRaw('DELETE FROM memory_proposals');
      await linkMember(engine, 'carol-example', 'qm', CAROL_ID);
      const poison: string[] = [];
      for (let i = 0; i < poisons; i++) {
        const id = await propose(ALICE_ID, `Poison ${i} canarypoison`);
        await at(id, `authority = 'null'::jsonb, created_at = now() - interval '3 hours' + interval '${i} seconds'`);
        poison.push(id);
      }
      const unlinked = await propose(CAROL_ID, 'Unlinked canaryunlinked');
      await at(unlinked, "created_at = now() - interval '2 hours'");
      const healthy = await propose(BOB_ID, 'Healthy canaryhealthy');
      await at(healthy, "created_at = now() - interval '1 hour'");
      const overdue = await propose(BOB_ID, 'Overdue canaryoverdue');
      const old = await propose(BOB_ID, 'Old canaryold');
      await at(overdue, "expires_at = now() - interval '1 minute'");
      await at(old, "state = 'denied', reason = 'no', decided_by = 'cli:test', decided_at = now() - interval '31 days'");
      await unlinkMember(engine, 'qm', CAROL_ID);
      return { poison, unlinked, overdue, healthy, old };
    }

    beforeAll(async () => {
      if (databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of ['alice-example', 'bob-example', 'carol-example']) await addMember(engine, id);
      await importFromContent(engine, ACME, ['---', 'type: company', 'title: Acme Example', '---', '# Acme Example', '', 'Harbor ledger notes.'].join('\n'), { sourceId: SRC });
      const client = await provider().registerClientManual(`p-qm-${randomUUID().slice(0, 8)}`, ['client_credentials'], 'read write', [], SRC);
      await bindCredential(engine, { kind: 'client', id: client.clientId }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      bearer = (await provider().exchangeClientCredentials(client.clientId, client.clientSecret ?? '')).access_token;
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      await linkMember(engine, 'bob-example', 'qm', BOB_ID);
    }, 120_000);

    afterAll(async () => {
      await disposePersistenceConsumer(engine).catch(() => undefined);
      await close?.();
    });

    test('item: a proposal whose authority check throws is counted and left awaiting; the rest still close, expire and purge', async () => {
      const s = await seed(1);
      const result = await expectUnitNotAborted(() => runMemoryProposalUpkeep(engine));
      expect(result).toEqual({ expired: 1, closed: 1, failed: 1, purged: 1 });
      expect(Object.fromEntries(await states())).toEqual({
        [s.poison[0]!]: 'awaiting_owner', [s.unlinked]: 'failed:actor_unlinked', [s.healthy]: 'awaiting_owner', [s.overdue]: 'expired',
      });
    }, 120_000);

    test('breaker: when every checked proposal throws, the pass stops item_failures_systemic before the purge', async () => {
      const s = await seed(5);
      const error = await runMemoryProposalUpkeep(engine).catch(e => e);
      expect(error?.code).toBe('item_failures_systemic');
      const after = await states();
      expect([after.get(s.unlinked), after.get(s.healthy), after.get(s.old)]).toEqual(['awaiting_owner', 'awaiting_owner', 'denied']);
    }, 120_000);

    for (const { name, error } of runScopedErrors()) {
      test(`run: a run-scoped failure (${name}) in an authority check stops the pass before the rows behind it and the purge`, async () => {
        const s = await seed(0);
        const injected = error();
        let thrown = false;
        const failing = new Proxy(engine, {
          get(target, prop) {
            if (prop === 'executeRaw') return (sql: string, params?: unknown[]) => {
              if (!thrown && !sql.includes('memory_proposals')) { thrown = true; return Promise.reject(injected); }
              return target.executeRaw(sql, params);
            };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        expect(await runMemoryProposalUpkeep(failing).catch(e => e)).toBe(injected);
        const after = await states();
        expect([after.get(s.unlinked), after.get(s.healthy), after.get(s.old)]).toEqual(['awaiting_owner', 'awaiting_owner', 'denied']);
      }, 120_000);
    }
  });
}
