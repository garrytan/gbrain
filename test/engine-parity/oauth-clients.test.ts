/**
 * BrainEngine parity: the whole `oauth_clients` row and the constraints a write to it meets (engine-sql/oauth-clients.ts):
 * `insertOauthClient`, `readOauthClient`, `listOauthClients`, `updateOauthClientBudget`, `patchOauthClient`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the same calls return the same rows and the same refusals on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts). A client row keeps every column the table has,
 *    with the table's defaults for a column left out. A write that breaks `oauth_clients_complete_agent_grant` (an
 *    `agent` scope, as a whitespace-delimited word, without bound tools, a write source that is bound and readable, a
 *    delegated namespace that fits its slug prefixes, or room for one concurrent subagent) is refused with SQLSTATE 23514
 *    and the constraint name, the same code and name a caller reads on PGLite and Postgres, and leaves no row. The other
 *    CHECKs (min_trust, private_pages, private_facts, registered_via, source_grant), a repeated id (23505) and a source
 *    the table does not know (23503) are refused the same way. A complete agent client, with the job namespace or the
 *    prefixes namespace, and a client of any other scope, are kept.
 *  - `patchOauthClient` sets only the named columns of one client (a named `null` clears one), returns the whole row after
 *    and the five patchable columns before, returns null for no client or one the guard excludes (a deleted client under
 *    `live`; a client pinned by the operator under `unless_surface_set_by`, where a NULL pin is not that value) and
 *    leaves that row as it was, and refuses a value a CHECK refuses (23514) with the row unchanged.
 *  - Regression: a store that keeps six columns, takes an incomplete agent grant, matches `agent` inside another word,
 *    reads the namespace rules the wrong way round, or raises an error a caller cannot tell from a store failure -- a
 *    client that can spend and write on a brain with no source or tool bound, or an error handler that misses the
 *    constraint, differently per engine.
 *  - Why existing coverage misses it: test/engine-parity/spend-log.test.ts inserts clients with the spend columns only;
 *    test/grants-*.test.ts run on PGLite with raw SQL.
 *  - Seam: none. Real engines, typed methods only; the sources a row names are made by the harness fixture. The row's
 *    own clock (`created_at`) is compared as a Date when given and as present when defaulted.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OauthClientInsert } from '../../src/core/engine-sql/oauth-clients.ts';
import { rotateClientSecret } from '../../src/commands/agent-register.ts';
import { listClientRows } from '../../src/commands/auth-client-rows.ts';
import { hashToken } from '../../src/core/utils.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** What a caller sees of a refused write: the SQLSTATE, the constraint and the message; `null` when it was accepted. */
async function refusal(run: () => Promise<unknown>): Promise<{ code: unknown; constraint: unknown; message: unknown } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const e = error as { code?: unknown; constraint?: unknown; constraint_name?: unknown; message?: unknown };
    if (e.code === 'engine_capability_missing') throw error;
    return { code: e.code, constraint: e.constraint_name ?? e.constraint, message: e.message };
  }
}

/** A complete agent grant, in the prefixes namespace; each case below breaks or reshapes one piece of it. */
function agent(id: string, extra: Partial<OauthClientInsert> = {}): OauthClientInsert {
  return {
    client_id: id, client_name: id, scope: 'read agent', bound_tools: ['get_page'], source_id: 'src-a', bound_source_id: 'src-a',
    federated_read: ['src-a', 'src-b'], delegated_namespace: 'prefixes', delegated_slug_prefixes: ['wiki/agents/*'],
    bound_max_concurrent: 2, ...extra,
  };
}

async function setup(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, 'src-a');
  await createSource(engine, backend, 'src-b');
}

const stored = async (engine: BrainEngine, id: string) => (await engine.readOauthClient(id)) !== null;

describe('engine parity: oauth_clients rows and constraints', () => {
  parityTest('an agent grant that is not complete is refused with the check-constraint error, and leaves no row',
    { methods: ['insertOauthClient', 'readOauthClient'] }, async (engine, backend) => {
      await setup(engine, backend);
      const attempts: Array<[string, Partial<OauthClientInsert>]> = [
        ['no-tools', { bound_tools: null }],
        ['empty-tools', { bound_tools: [] }],
        ['no-source', { source_id: null, bound_source_id: null }],
        ['no-bound-source', { bound_source_id: null }],
        ['source-differs', { bound_source_id: 'src-b' }],
        ['source-unreadable', { federated_read: ['src-b'] }],
        ['no-federated-read', { federated_read: [] }],
        ['job-with-prefixes', { delegated_namespace: 'job', delegated_slug_prefixes: ['wiki/agents/*'] }],
        ['prefixes-without-list', { delegated_slug_prefixes: null }],
        ['prefixes-empty-list', { delegated_slug_prefixes: [] }],
        ['unknown-namespace', { delegated_namespace: 'other', delegated_slug_prefixes: null }],
        ['no-concurrency', { bound_max_concurrent: 0 }],
        ['negative-concurrency', { bound_max_concurrent: -1 }],
        ['tab-delimited', { scope: 'read\tagent', bound_tools: null }],
        ['newline-delimited-last', { scope: 'read\nagent', bound_tools: null }],
        ['ideographic-space-delimited', { scope: 'read\u3000agent', bound_tools: null }],
        ['agent-only', { scope: 'agent', bound_tools: null }],
      ];
      const refused: Record<string, unknown> = {};
      const kept: Record<string, boolean> = {};
      for (const [name, extra] of attempts) {
        refused[name] = await refusal(() => engine.insertOauthClient(agent(`c-${name}`, extra)));
        kept[name] = await stored(engine, `c-${name}`);
      }
      return { refused, kept };
    });

  parityTest('a complete agent grant in either namespace, and a scope that only resembles the word, are kept as written',
    { methods: ['insertOauthClient', 'readOauthClient'] }, async (engine, backend) => {
      await setup(engine, backend);
      const created = new Date('2026-03-04T05:06:07.123Z');
      const rows: Array<[string, Partial<OauthClientInsert>]> = [
        ['prefixes', { created_at: created }],
        ['job', { created_at: created, delegated_namespace: 'job', delegated_slug_prefixes: null }],
        ['padded', { created_at: created, scope: ' read   agent ' }],
        ['not-agent-agents', { created_at: created, scope: 'agents', bound_tools: null, source_id: null }],
        ['not-agent-subagent', { created_at: created, scope: 'subagent read', bound_tools: null, bound_source_id: null }],
        ['not-agent-colon', { created_at: created, scope: 'agent:read', bound_tools: null, federated_read: [] }],
        ['plain-read', { created_at: created, scope: 'read write', bound_tools: null, source_id: null, bound_source_id: null, delegated_slug_prefixes: null }],
        ['no-scope', { created_at: created, scope: null, bound_tools: null, source_id: null, bound_source_id: null }],
      ];
      const out: Record<string, unknown> = {};
      for (const [name, extra] of rows) {
        const refused = await refusal(() => engine.insertOauthClient(agent(`c-${name}`, extra)));
        out[name] = { refused, row: await engine.readOauthClient(`c-${name}`) };
      }
      return out;
    });

  parityTest('a client row keeps every column, the table gives a column left out its default, and the other constraints refuse the same way',
    { methods: ['insertOauthClient', 'readOauthClient', 'updateOauthClientBudget'] }, async (engine, backend) => {
      await setup(engine, backend);
      const t = (s: string) => new Date(s);
      const full: OauthClientInsert = {
        client_id: 'full', client_name: 'Full client', client_secret_hash: 'abc123', redirect_uris: ['https://a.example/cb', 'https://b.example/cb'],
        grant_types: ['authorization_code', 'refresh_token'], scope: 'read write admin', token_endpoint_auth_method: 'client_secret_post',
        client_id_issued_at: 1_700_000_000, client_secret_expires_at: 0, token_ttl: 3600, deleted_at: t('2025-05-06T07:08:09.456Z'),
        source_id: 'src-a', federated_read: ['src-a'], budget_usd_per_day: 12.5, bound_tools: ['get_page', 'put_page'], bound_source_id: 'src-a',
        bound_brain_id: 'host', bound_slug_prefixes: ['wiki/*'], bound_max_concurrent: 4, surface: 'minimal', surface_set_by: 'operator',
        allowed_operations: ['get_page', 'search'], delegated_slug_prefixes: ['a/*'], delegated_namespace: 'prefixes', grant_profile: 'coding',
        grant_revision: 7, grant_repair_reasons: ['missing_tools'], created_at: t('2024-01-02T03:04:05.678Z'), source_grant: 'none',
        takes_holders: ['world', 'garry'], min_trust: 'tool_observed', registered_via: 'dcr', private_pages: 'granted_sources', member_id: 'm-1',
        may_act_for: ['m-2'], attest_actor: 'qm', attest_ops: ['read'], attest_sources: ['src-a'], attest_read: 'granted', reads_unscoped: t('2026-01-01T00:00:00.000Z'),
        private_facts: 'granted_sources',
      };
      await engine.insertOauthClient(full);
      await engine.insertOauthClient({ client_id: 'bare', client_name: 'Bare' });
      await engine.insertOauthClient({ client_id: 'nulls', client_name: 'Nulls', grant_types: null, scope: null, federated_read: [] });
      const bare = await engine.readOauthClient('bare');
      const withBudget = await engine.updateOauthClientBudget('full', 3.07);
      const refusals = {
        repeated: await refusal(() => engine.insertOauthClient({ client_id: 'bare', client_name: 'Again' })),
        unknownSource: await refusal(() => engine.insertOauthClient({ client_id: 'x1', client_name: 'x', source_id: 'no-such-source' })),
        minTrust: await refusal(() => engine.insertOauthClient({ client_id: 'x2', client_name: 'x', min_trust: 'bogus' })),
        privatePages: await refusal(() => engine.insertOauthClient({ client_id: 'x3', client_name: 'x', private_pages: 'all' })),
        privateFacts: await refusal(() => engine.insertOauthClient({ client_id: 'x4', client_name: 'x', private_facts: 'all' })),
        registeredVia: await refusal(() => engine.insertOauthClient({ client_id: 'x5', client_name: 'x', registered_via: 'cli' })),
        sourceGrant: await refusal(() => engine.insertOauthClient({ client_id: 'x6', client_name: 'x', source_grant: 'all' })),
      };
      return {
        full: await engine.readOauthClient('full'),
        // The defaulted row's own clock differs per engine; the rest of it must not.
        bare: bare && { ...bare, created_at: bare.created_at instanceof Date },
        nulls: await engine.readOauthClient('nulls').then(r => r && { ...r, created_at: r.created_at instanceof Date }),
        missing: await engine.readOauthClient('nope'),
        withBudget, afterBudget: (await engine.readOauthClient('full'))?.budget_usd_per_day,
        refusals,
        left: await Promise.all(['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].map(id => stored(engine, id))),
      };
    });

  parityTest('patchOauthClient sets the named columns and returns the row before and after, and the guards leave an excluded client alone',
    { methods: ['insertOauthClient', 'readOauthClient', 'patchOauthClient'] }, async (engine, backend) => {
      await setup(engine, backend);
      const day = (r: Awaited<ReturnType<BrainEngine['readOauthClient']>>) => r && { ...r, created_at: r.created_at instanceof Date };
      const seen = async (id: string) => day(await engine.readOauthClient(id));
      const shown = <T extends { row: Parameters<typeof day>[0] } | null>(p: T) => p && { ...p, row: day(p.row) };
      await engine.insertOauthClient(agent('a', { client_secret_hash: 'old', token_ttl: 60, min_trust: 'tool_observed', surface: 'full' }));
      await engine.insertOauthClient({ client_id: 'pinned', client_name: 'pinned', surface: 'minimal', surface_set_by: 'operator' });
      await engine.insertOauthClient({ client_id: 'self', client_name: 'self', surface: 'minimal', surface_set_by: 'self' });
      await engine.insertOauthClient({ client_id: 'unpinned', client_name: 'unpinned' });
      await engine.insertOauthClient({ client_id: 'gone', client_name: 'gone', min_trust: 'tool_observed', deleted_at: new Date('2025-01-01T00:00:00.000Z') });
      const out: Record<string, unknown> = {};
      out.secret = shown(await engine.patchOauthClient('a', { client_secret_hash: 'new' }));
      out.minTrustSet = shown(await engine.patchOauthClient('a', { min_trust: 'agent_written' }));
      out.minTrustCleared = shown(await engine.patchOauthClient('a', { min_trust: null }, { live: true }));
      out.ttlAndSurface = shown(await engine.patchOauthClient('a', { token_ttl: 3600, surface: 'minimal', surface_set_by: 'self' }));
      out.ttlCleared = shown(await engine.patchOauthClient('a', { token_ttl: null }));
      out.empty = shown(await engine.patchOauthClient('a', {}));
      out.liveSkipsDeleted = shown(await engine.patchOauthClient('gone', { min_trust: null }, { live: true }));
      out.deletedStays = await seen('gone');
      out.deletedWithoutGuard = shown(await engine.patchOauthClient('gone', { min_trust: null }));
      out.pinnedSkipped = shown(await engine.patchOauthClient('pinned', { surface: 'full', surface_set_by: 'self' }, { unless_surface_set_by: 'operator' }));
      out.pinnedStays = await seen('pinned');
      out.selfPatched = shown(await engine.patchOauthClient('self', { surface: 'full', surface_set_by: 'self' }, { unless_surface_set_by: 'operator' }));
      out.nullPinPatched = shown(await engine.patchOauthClient('unpinned', { surface: 'full', surface_set_by: 'self' }, { unless_surface_set_by: 'operator' }));
      out.missing = await engine.patchOauthClient('nope', { min_trust: null });
      out.badTrust = await refusal(() => engine.patchOauthClient('a', { min_trust: 'bogus' }));
      out.afterBad = await seen('a');
      return out;
    });

  parityTest('listOauthClients returns every client row by name then id, and the auth clients listing narrows it the same way',
    { methods: ['insertOauthClient', 'listOauthClients'] }, async (engine) => {
      const day = (r: Awaited<ReturnType<BrainEngine['listOauthClients']>>[number]) => ({ ...r, created_at: r.created_at instanceof Date });
      const empty = { rows: await engine.listOauthClients(), listing: await listClientRows(engine) };
      await engine.insertOauthClient({ client_id: 'c-beta', client_name: 'beta', scope: 'read write', surface: 'minimal', surface_set_by: 'operator', federated_read: ['default'], private_pages: 'granted_sources' });
      await engine.insertOauthClient({ client_id: 'c-alpha', client_name: 'alpha', scope: null });
      await engine.insertOauthClient({ client_id: 'z-twin', client_name: 'twin' });
      await engine.insertOauthClient({ client_id: 'y-twin', client_name: 'twin', deleted_at: new Date('2025-02-03T04:05:06.789Z'), allowed_operations: [] });
      // Upper case sorts before lower case in byte order, whatever the database's collation says.
      await engine.insertOauthClient({ client_id: 'c-upper', client_name: 'Zeta' });
      await engine.insertOauthClient({ client_id: 'c-under', client_name: 'alpha_two' });
      const rows = await engine.listOauthClients();
      expect(rows.map(r => r.client_id)).toEqual(['c-upper', 'c-alpha', 'c-under', 'c-beta', 'y-twin', 'z-twin']);
      return {
        empty,
        order: rows.map(r => [r.client_name, r.client_id]),
        rows: rows.map(day),
        listing: await listClientRows(engine),
      };
    });

  parityTest('two concurrent secret rotations of one client: exactly one wins, the other gets the same error, and the winner\'s secret is the one kept',
    { methods: ['insertOauthClient', 'readOauthClient', 'patchOauthClient'] }, async (engine) => {
      await engine.insertOauthClient({ client_id: 'rot', client_name: 'rot', client_secret_hash: 'h0', grant_types: ['client_credentials'] });
      const settled = await Promise.allSettled([rotateClientSecret(engine, 'rot', 'h0'), rotateClientSecret(engine, 'rot', 'h0')]);
      const won = settled.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
      const lost = settled.flatMap(r => (r.status === 'rejected' ? [r.reason as { reason?: unknown; message?: unknown }] : []));
      expect(won.length).toBe(1);
      expect(lost.length).toBe(1);
      const kept = (await engine.readOauthClient('rot'))?.client_secret_hash;
      const failure = async (run: () => Promise<unknown>) => run().then(() => null, (e: { reason?: unknown; message?: unknown }) => ({ reason: e.reason, message: e.message }));
      // A reissue that read a secret which has since been replaced, one for a client that is not there, and one that read the secret that is current.
      const stale = await failure(() => rotateClientSecret(engine, 'rot', 'h0'));
      const absent = await failure(() => rotateClientSecret(engine, 'nope', 'h0'));
      const fresh = await rotateClientSecret(engine, 'rot', kept!);
      return {
        winners: won.length,
        losers: lost.map(e => ({ reason: e.reason, message: e.message })),
        keptIsWinners: won.length === 1 && kept === hashToken(won[0]!),
        stale, absent, freshIsKept: (await engine.readOauthClient('rot'))?.client_secret_hash === hashToken(fresh),
      };
    });
});
