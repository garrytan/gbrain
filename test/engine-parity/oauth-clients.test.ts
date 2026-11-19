/**
 * BrainEngine parity: the whole `oauth_clients` row and the constraints a write to it meets (engine-sql/oauth-clients.ts):
 * `insertOauthClient`, `readOauthClient`, `updateOauthClientBudget`.
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
 *  - Regression: a store that keeps six columns, takes an incomplete agent grant, matches `agent` inside another word,
 *    reads the namespace rules the wrong way round, or raises an error a caller cannot tell from a store failure -- a
 *    client that can spend and write on a brain with no source or tool bound, or an error handler that misses the
 *    constraint, differently per engine.
 *  - Why existing coverage misses it: test/engine-parity/spend-log.test.ts inserts clients with the spend columns only;
 *    test/grants-*.test.ts run on PGLite with raw SQL.
 *  - Seam: none. Real engines, typed methods only; the sources a row names are made by the harness fixture. The row's
 *    own clock (`created_at`) is compared as a Date when given and as present when defaulted.
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OauthClientInsert } from '../../src/core/engine-sql/oauth-clients.ts';
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
});

