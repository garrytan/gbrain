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
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OauthClientInsert } from '../../src/core/engine-sql/oauth-clients.ts';
import { rotateClientSecret, runAgentRegister } from '../../src/commands/agent-register.ts';
import { parseRegisterClientArgs, preflightOauthClientColumns, registerScopedClient } from '../../src/commands/auth.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { listClientRows } from '../../src/commands/auth-client-rows.ts';
import { rescopeOAuthClient } from '../../src/core/grants/rescope.ts';
import { readClientCatalogProvenance, recordFirstConsentInTransaction, rescopeClientGrant, rescopeClientGrantInTransaction } from '../../src/core/grants/service.ts';
import { hashToken } from '../../src/core/utils.ts';
import { archiveSource, createSource, parityArms, resetArm, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest, arms } = parityArms(testBackends());

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

/** Runs `gbrain agent register` through its CLI function, keeping the first JSON line it prints (a refusal exits through `process.exit`, which its own handler then reports a second time). */
async function registerAgent(engine: BrainEngine, name: string, ...extra: string[]): Promise<{ ok?: boolean; reason?: string; client_id?: string }> {
  const out: string[] = [];
  const realExit = process.exit, realLog = console.log, realError = console.error;
  process.exit = ((code?: number) => { throw Object.assign(new Error(`exit ${code} ${out.join(' ')}`), { code: 'test_exit' }); }) as typeof process.exit;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = () => undefined;
  try {
    await runAgentRegister(engine, [name, '--harness', 'claude-code', '--url', 'http://127.0.0.1:9/mcp', '--allow-old-serve', '--json', ...extra]);
  } catch { /* a refusal printed its JSON line before the exit */ } finally { process.exit = realExit; console.log = realLog; console.error = realError; }
  return JSON.parse(out.find(line => line.startsWith('{"ok"')) ?? '{}');
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

  /** Registers one client through the scoped registration core, as `gbrain auth register-client` does. */
  const registerThroughCli = async (engine: BrainEngine, argv: string[]) => {
    const columns = await preflightOauthClientColumns(engine);
    const grantColumns = await engine.readOauthClientColumns('grant');
    const registered = await registerScopedClient(sqlQueryForEngine(engine), 'census-like', parseRegisterClientArgs(argv),
      { columns, engine, transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const row = await engine.readOauthClient(registered.clientId);
    return {
      columns: [...columns].sort(), grantColumns: grantColumns.length,
      registered: { idShape: /^gbrain_cl_[0-9a-f]{64}$/.test(registered.clientId), secretShape: /^gbrain_cs_[0-9a-f]{64}$/.test(registered.clientSecret ?? ''),
        tokenTtl: registered.tokenTtl, scopes: registered.scopes, sourceId: registered.sourceId },
      row: row && {
        client_name: row.client_name, secretMatches: row.client_secret_hash === hashToken(registered.clientSecret!), grant_types: row.grant_types,
        redirect_uris: row.redirect_uris, scope: row.scope, token_endpoint_auth_method: row.token_endpoint_auth_method, source_id: row.source_id,
        federated_read: row.federated_read, token_ttl: row.token_ttl, grant_revision: row.grant_revision, grant_profile: row.grant_profile,
        allowed_operations: row.allowed_operations, bound_tools: row.bound_tools, deleted: row.deleted_at != null,
      },
      live: await engine.oauthClientLive(registered.clientId),
      ttlOnNobody: await engine.setOauthClientTokenTtl('gbrain_cl_nobody', 60),
    };
  };

  parityTest('register a client: the scoped registration stores the planned grant, its secret hash and its token ttl, and the client is live',
    { methods: ['readOauthClientColumns', 'insertOauthClientGrant', 'setOauthClientTokenTtl', 'readOauthClient', 'oauthClientLive'] }, async (engine) =>
      registerThroughCli(engine, ['--grant-types', 'client_credentials', '--scopes', 'read write', '--token-ttl', '7200']));

  // A grant that reads a named source first checks it is not a QM scope source (attest-sources.ts markedScopeSources,
  // through readScopeSourceConfigs); neither source is marked, so the registration goes through on every arm.
  parityTest('register a client that reads named sources: the same row, after the scope-source check',
    { methods: ['readOauthClientColumns', 'readScopeSourceConfigs', 'insertOauthClientGrant', 'setOauthClientTokenTtl', 'readOauthClient', 'oauthClientLive'] }, async (engine, backend) => {
      await setup(engine, backend);
      return registerThroughCli(engine, ['--grant-types', 'client_credentials', '--scopes', 'read write', '--source', 'src-a', '--federated-read', 'src-a,src-b', '--token-ttl', '7200']);
    });

  // The audit rows a lifetime migration writes exist only on a brain that had clients before it; a fresh brain has none,
  // and the Rust store does not run those migrations, so this pins the empty answer on every arm.
  parityTest('lifetime clamp: a fresh brain names no client its migrations clamped, before and after a registration',
    { methods: ['readTokenLifetimeClampedClients'] }, async (engine) => {
      const before = await engine.readTokenLifetimeClampedClients();
      await registerThroughCli(engine, ['--grant-types', 'client_credentials', '--scopes', 'read', '--token-ttl', '600']);
      return { before, after: await engine.readTokenLifetimeClampedClients() };
    });

  /** What a caller sees of a grant change: the revision it reached and the grant before and after, minus the clock. */
  const changed = (r: Awaited<ReturnType<typeof rescopeClientGrant>>) => ({
    revision: r.revision, dryRun: r.dryRun,
    before: { scopes: r.before.scopes, sourceId: r.before.sourceId, federatedRead: r.before.federatedRead, revision: r.before.revision },
    after: { scopes: r.after.scopes, sourceId: r.after.sourceId, federatedRead: r.after.federatedRead, revision: r.after.revision },
  });
  const audit = async (engine: BrainEngine, id: string) => (await engine.listOauthGrantAudit(id)).map(a => ({
    actor: a.actor, action: a.action, revision: a.revision, hasBefore: a.before_grant !== null, afterSources: (a.after_grant as { sourceId?: unknown } | null)?.sourceId,
    afterScopes: (a.after_grant as { scopes?: unknown } | null)?.scopes, createdAtPresent: a.created_at instanceof Date,
  }));

  parityTest('rescope a client: the grant moves to the new scope and sources, the revision counts up, a stale revision changes nothing, and each change leaves an audit row',
    { methods: ['insertOauthClientGrant', 'readOauthClientForUpdate', 'persistOauthClientGrant', 'listOauthGrantAudit', 'readOauthClient'] }, async (engine, backend) => {
      await setup(engine, backend);
      const registered = await registerThroughCli(engine, ['--grant-types', 'client_credentials', '--scopes', 'read', '--source', 'src-a']);
      const id = (await engine.listOauthClients()).find(c => c.client_name === 'census-like')!.client_id;
      const afterRegister = await audit(engine, id);
      const preview = await rescopeClientGrant(engine, id, { scopes: ['read', 'write'] }, { actor: 'operator', dryRun: true });
      const rowAfterPreview = await engine.readOauthClient(id);
      const first = await rescopeClientGrant(engine, id, { scopes: ['read', 'write'], sourceId: 'src-b', federatedRead: ['src-a', 'src-b'] }, { actor: 'operator', expectedRevision: 1 });
      const stale = await refusal(() => rescopeClientGrant(engine, id, { scopes: ['read'] }, { actor: 'operator', expectedRevision: 1 }));
      const row = await engine.readOauthClient(id);
      const missing = await refusal(() => rescopeClientGrant(engine, 'gbrain_cl_nobody', { scopes: ['read'] }, { actor: 'operator' }));
      return {
        registered: registered.row?.grant_revision, afterRegister, preview: changed(preview), previewKept: rowAfterPreview?.scope,
        first: changed(first), stale: stale && { code: stale.code, message: stale.message },
        row: { scope: row?.scope, source_id: row?.source_id, federated_read: row?.federated_read, grant_revision: row?.grant_revision },
        missing: missing && { code: missing.code }, audit: await audit(engine, id),
      };
    });

  parityTest('rescope several clients in one transaction: a failure after the first write rolls both back, audit rows included',
    { methods: ['insertOauthClient', 'readOauthClientForUpdate', 'persistOauthClientGrant', 'listOauthGrantAudit', 'readOauthClient'] }, async (engine, backend) => {
      await setup(engine, backend);
      for (const id of ['one', 'two']) await engine.insertOauthClient({ client_id: id, client_name: id, grant_types: ['client_credentials'], scope: 'read', source_id: 'src-a', federated_read: ['src-a'], grant_revision: 1 });
      const failure = await refusal(() => engine.transaction(async tx => {
        await rescopeClientGrantInTransaction(tx, 'one', { scopes: ['read', 'write'] }, { actor: 'operator' });
        await rescopeClientGrantInTransaction(tx, 'two', { scopes: ['read', 'write'] }, { actor: 'operator' });
        throw Object.assign(new Error('stop'), { code: 'test_stop' });
      }));
      const rolledBack = { one: (await engine.readOauthClient('one'))?.scope, audit: await audit(engine, 'one') };
      await engine.transaction(async tx => {
        await rescopeClientGrantInTransaction(tx, 'one', { scopes: ['read', 'write'] }, { actor: 'operator' });
        await rescopeClientGrantInTransaction(tx, 'two', { scopes: ['read', 'write'] }, { actor: 'operator' });
      });
      return {
        failure: failure && failure.code, rolledBack,
        kept: { one: (await engine.readOauthClient('one'))?.scope, two: (await engine.readOauthClient('two'))?.grant_revision, audit: await audit(engine, 'two') },
      };
    });

  parityTest('first consent: a client at revision 0 takes its source and moves to revision 1 with an audit row; a second consent is a conflict; an archived source is refused',
    { methods: ['insertOauthClient', 'readOauthClientForUpdate', 'oauthClientHoldsAuthorization', 'readSourceArchivedForShare', 'persistOauthClientGrant', 'listOauthGrantAudit', 'readOauthClient'] }, async (engine, backend) => {
      await setup(engine, backend);
      await createSource(engine, backend, 'src-archived');
      await archiveSource(engine, backend, 'src-archived');
      for (const id of ['fresh', 'fresh-archived']) await engine.insertOauthClient({ client_id: id, client_name: id, grant_types: ['authorization_code'], scope: 'read', grant_revision: 0 });
      const consent = await engine.transaction(tx => recordFirstConsentInTransaction(tx, 'fresh', 'src-a', 'owner'));
      const again = await refusal(() => engine.transaction(tx => recordFirstConsentInTransaction(tx, 'fresh', 'src-b', 'owner')));
      const archived = await refusal(() => engine.transaction(tx => recordFirstConsentInTransaction(tx, 'fresh-archived', 'src-archived', 'owner')));
      const row = await engine.readOauthClient('fresh');
      return {
        consent: changed(consent), again: again && { code: again.code }, archived: archived && { code: archived.code },
        row: { source_id: row?.source_id, federated_read: row?.federated_read, grant_revision: row?.grant_revision },
        archivedRow: (await engine.readOauthClient('fresh-archived'))?.grant_revision, audit: await audit(engine, 'fresh'),
      };
    });

  parityTest('the catalog an operation snapshot was written against is read back from its audit row, and only for the same operation set',
    { methods: ['insertOauthClient', 'readOauthClientForUpdate', 'persistOauthClientGrant', 'readLatestCatalogProvenanceAudit', 'listOauthGrantAudit'] }, async (engine, backend) => {
      await setup(engine, backend);
      await engine.insertOauthClient({ client_id: 'snap', client_name: 'snap', grant_types: ['client_credentials'], scope: 'read', source_id: 'src-a', federated_read: ['src-a'], grant_revision: 1 });
      const none = await readClientCatalogProvenance(engine, 'snap', ['get_page']);
      await rescopeClientGrant(engine, 'snap', { allowedOperations: ['get_page', 'search'] }, { actor: 'operator' });
      const same = await readClientCatalogProvenance(engine, 'snap', ['search', 'get_page']);
      const other = await readClientCatalogProvenance(engine, 'snap', ['get_page']);
      // A later write that leaves the snapshot alone adds an audit row with no provenance: the earlier row still answers.
      await rescopeClientGrant(engine, 'snap', { scopes: ['read', 'write'] }, { actor: 'operator' });
      const later = await readClientCatalogProvenance(engine, 'snap', ['get_page', 'search']);
      return { none, sameVersion: same?.version, sameOps: same?.operations.length === later?.operations.length, other, laterVersion: later?.version, audit: await audit(engine, 'snap') };
    });

  parityTest('the live clients and live tokens a source-grant check reads leave out a revoked client and a revoked token',
    { methods: ['insertOauthClient', 'deleteOAuthClient', 'insertAccessToken', 'readLiveOauthClients', 'readLiveAccessTokenRows'] }, async (engine, backend) => {
      await setup(engine, backend);
      await engine.insertOauthClient({ client_id: 'b-live', client_name: 'b', grant_types: ['client_credentials'], scope: 'read', source_id: 'src-a', federated_read: ['src-a'] });
      await engine.insertOauthClient({ client_id: 'a-live', client_name: 'a', grant_types: ['client_credentials'], scope: 'read' });
      await engine.insertOauthClient({ client_id: 'gone', client_name: 'gone', grant_types: ['client_credentials'], scope: 'read' });
      await engine.deleteOAuthClient('gone');
      await engine.insertAccessToken({ name: 'live', token_hash: 'h1', scopes: ['read'], permissions: {}, source_grant: 'federated', source_id: 'src-a', federated_read: ['src-a'], allowed_operations: null, takes_holders: null });
      await engine.insertAccessToken({ name: 'revoked', token_hash: 'h2', scopes: ['read'], permissions: {}, source_grant: null, source_id: null, federated_read: null, allowed_operations: null, takes_holders: null, revoked_at: new Date('2026-01-02T03:04:05Z') });
      const clients = await engine.readLiveOauthClients();
      const tokens = await engine.readLiveAccessTokenRows();
      return {
        clients: clients.map(c => ({ id: c.client_id, source: c.source_id, readable: c.federated_read, hasHash: 'client_secret_hash' in c })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
        tokens: tokens.map(t => ({ name: t.name, source_grant: t.source_grant, source_id: t.source_id, federated_read: t.federated_read })),
        // The Rust store returns no token hash from any member (access-tokens.md), so the hash column is not compared; no caller of this read uses it.
      };
    });

  parityTest('persistOauthClientGrant writes nothing, and returns false, for a revision the client no longer holds or a client that does not exist',
    { methods: ['insertOauthClient', 'persistOauthClientGrant', 'readOauthClient', 'listOauthGrantAudit'] }, async (engine, backend) => {
      await setup(engine, backend);
      await engine.insertOauthClient({ client_id: 'cas', client_name: 'cas', grant_types: ['client_credentials'], scope: 'read', source_id: 'src-a', federated_read: ['src-a'], grant_revision: 3 });
      const grant = (clientId: string, expected: number) => ({
        client_id: clientId, expected_revision: expected, scope: 'read write', source_id: 'src-b', federated_read: ['src-b'], source_grant: null as 'none' | null,
        takes_holders: null, bound_slug_prefixes: null, allowed_operations: null, bound_tools: null, bound_source_id: null, bound_brain_id: null,
        delegated_slug_prefixes: null, delegated_namespace: 'prefixes', bound_max_concurrent: 1, budget_usd_per_day: null, surface: null,
        surface_set_by: null, token_ttl: null, grant_profile: null, grant_revision: expected + 1, grant_repair_reasons: [],
        legacy_jobs: { brain_id: null, federated_read: ['src-b'], scopes: ['read', 'write'], allowed_operations: null, max_concurrent: 1, budget_usd_per_day: null },
        audit: { actor: 'operator', action: 'rescope', before_grant: '{"revision":3}', after_grant: '{"revision":4}' },
      });
      const stale = await engine.persistOauthClientGrant(grant('cas', 2));
      const missing = await engine.persistOauthClientGrant(grant('nobody', 3));
      const unchanged = { row: (await engine.readOauthClient('cas'))?.scope, audit: (await engine.listOauthGrantAudit('cas')).length };
      const current = await engine.persistOauthClientGrant(grant('cas', 3));
      const row = await engine.readOauthClient('cas');
      return { stale, missing, unchanged, current, row: { scope: row?.scope, source_id: row?.source_id, grant_revision: row?.grant_revision }, audit: await audit(engine, 'cas') };
    });

  // The admin registration route, `agent register` and the MCP provisioner call registerScopedClient inside one engine
  // transaction with that transaction as the engine: the client, its register audit row, its token ttl and the surface
  // write commit or roll back together.
  parityTest('register inside a transaction with the surface write: client, audit rows, ttl and surface land together, and a failure after leaves nothing',
    { methods: ['readOauthClientColumns', 'insertOauthClientGrant', 'setOauthClientTokenTtl', 'readOauthClientForUpdate', 'persistOauthClientGrant', 'getSource', 'listOauthGrantAudit', 'readOauthClient'] }, async (engine, backend) => {
      await setup(engine, backend);
      const columns = await preflightOauthClientColumns(engine);
      const args = (extra: Partial<ReturnType<typeof parseRegisterClientArgs>> = {}) => ({ ...parseRegisterClientArgs(['--grant-types', 'client_credentials', '--scopes', 'read write', '--source', 'src-a', '--token-ttl', '900']), ...extra });
      const register = (tx: BrainEngine, name: string) => registerScopedClient(sqlQueryForEngine(tx), name, args(),
        { columns, engine: tx, surface: 'verbs', surfaceSetBy: 'operator', tokenTtlSeconds: 900 });
      const registered = await engine.transaction(tx => register(tx, 'in-tx'));
      const id = registered.clientId;
      const row = await engine.readOauthClient(id);
      const failure = await refusal(() => engine.transaction(async tx => {
        await register(tx, 'rolled-back');
        throw Object.assign(new Error('stop'), { code: 'test_stop' });
      }));
      const names = (await engine.listOauthClients()).map(c => c.client_name);
      const movedSource = await engine.transaction(tx => rescopeOAuthClient(tx, id, { sourceId: 'src-b', federatedRead: ['src-a', 'src-b'] }));
      const unknownSource = await refusal(() => engine.transaction(tx => rescopeOAuthClient(tx, id, { sourceId: 'src-nowhere' })));
      return {
        tokenTtl: registered.tokenTtl, surface: registered.surface, surfaceOld: registered.surfaceOld,
        row: { surface: row?.surface, surface_set_by: row?.surface_set_by, token_ttl: row?.token_ttl, grant_revision: row?.grant_revision, source_id: row?.source_id },
        failure: failure && failure.code, names,
        movedSource: { sourceId: movedSource.sourceId, federatedRead: movedSource.federatedRead }, unknownSource: unknownSource && unknownSource.message,
        audit: await audit(engine, id),
      };
    });

  // `gbrain agent register` end to end, through the function the CLI calls: its client and grant rows and its register audit row.
  parityTest('agent register: the CLI function stores the client, its grant at revision 1 and the register audit row, with a named or a derived workspace source',
    { methods: ['insertOauthClientGrant', 'readOauthClient', 'listOauthGrantAudit'] }, async (engine, backend) => {
      await setup(engine, backend);
      // Once on a named write source, once on the coding-agent preset, whose derived `<name>-workspace` write source the register creates.
      const register = async (name: string, ...extra: string[]) => {
        const result = await registerAgent(engine, name, ...extra);
        expect(result.ok).toBe(true);
        const row = await engine.readOauthClient(result.client_id!);
        return {
          row: row && { client_name: row.client_name, scope: row.scope, source_id: row.source_id, federated_read: row.federated_read, grant_revision: row.grant_revision, token_ttl: row.token_ttl, secretKept: row.client_secret_hash != null },
          audit: await audit(engine, result.client_id!),
        };
      };
      return { named: await register('named-agent', '--source', 'src-a', '--federated-read', 'src-a,src-b'), workspace: await register('ws-agent', '--preset', 'coding-agent', '--federated-read', 'src-b') };
    });

  // Two registers of one name started together: the per-name advisory lock holds the second on PGLite and Postgres; on Rust the
  // store's single writer does (rust/crates/gbrain-store/src/occ_kv.rs begin_exclusive, taken by transactions.rs begin_transaction).
  parityTest('agent register: two registers of the same name started together store one client, and the other is refused as a duplicate',
    { methods: ['insertOauthClientGrant', 'listOauthClients'] }, async (engine, backend) => {
      await setup(engine, backend);
      const rounds = [];
      for (let round = 0; round < 5; round++) {
        const out: string[] = [];
        const realExit = process.exit, realLog = console.log, realError = console.error;
        process.exit = ((code?: number) => { throw Object.assign(new Error(`exit ${code}`), { code: 'test_exit' }); }) as typeof process.exit;
        console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
        console.error = () => undefined;
        try {
          const argv = [`race-${round}`, '--harness', 'claude-code', '--url', 'http://127.0.0.1:9/mcp', '--allow-old-serve', '--json', '--source', 'src-a'];
          await Promise.allSettled([runAgentRegister(engine, argv), runAgentRegister(engine, argv)]);
        } finally { process.exit = realExit; console.log = realLog; console.error = realError; }
        const results = out.map(line => JSON.parse(line) as { ok: boolean; reason?: string });
        rounds.push({
          ok: results.filter(r => r.ok).length, refused: results.filter(r => !r.ok).map(r => r.reason),
          stored: (await engine.listOauthClients()).filter(c => c.client_name === `race-${round}` && c.deleted_at == null).length,
        });
      }
      expect(rounds.every(r => r.ok === 1 && r.stored === 1 && r.refused.join() === 'duplicate_name')).toBe(true);
      return rounds;
    });

  // A brain older than v109 has no `sources.newest_content_at` (v109) but does have `archived` (v34; bootstrap adds it to any older table, so
  // none can lack it: no source is archived there). The register's source lookups must read neither a missing column nor retry inside the tx.
  parityTest('agent register on a schema without sources.newest_content_at: a fresh workspace registers, an archived --source is refused, an empty workspace is reused and a dirty one refused',
    { methods: ['executeRaw', 'insertOauthClientGrant'], requires: 'raw_sql' }, async (engine, backend) => {
      await createSource(engine, backend, 'arch');
      await archiveSource(engine, backend, 'arch');
      await createSource(engine, backend, 'empty-workspace');
      await createSource(engine, backend, 'dirty-workspace', {}, '/x');
      await engine.executeRaw('ALTER TABLE sources DROP COLUMN newest_content_at');
      try {
        const coding = ['--preset', 'coding-agent', '--federated-read', 'default'];
        const out = { fresh: (await registerAgent(engine, 'fresh', ...coding)).ok, archived: (await registerAgent(engine, 'arch', '--source', 'arch')).reason,
          empty: (await registerAgent(engine, 'empty', ...coding)).ok, dirty: (await registerAgent(engine, 'dirty', ...coding)).reason };
        expect(out).toEqual({ fresh: true, archived: 'archived_source', empty: true, dirty: 'dirty_source' });
        return out;
      } finally { await engine.executeRaw('ALTER TABLE sources ADD COLUMN IF NOT EXISTS newest_content_at TIMESTAMPTZ'); }
    });

  parityTest('revoke a client: the delete returns the client once, it is no longer live, and its ttl write finds no row',
    { methods: ['insertOauthClient', 'deleteOAuthClient', 'oauthClientLive', 'setOauthClientTokenTtl', 'readOauthClient'] }, async (engine) => {
      await engine.insertOauthClient({ client_id: 'gone', client_name: 'to revoke', grant_types: ['client_credentials'] });
      await engine.insertOauthClient({ client_id: 'kept', client_name: 'to keep', grant_types: ['client_credentials'] });
      await engine.insertOauthClient({ client_id: 'soft', client_name: 'soft deleted', grant_types: ['client_credentials'], deleted_at: new Date('2026-01-02T03:04:05Z') });
      const before = { gone: await engine.oauthClientLive('gone'), kept: await engine.oauthClientLive('kept'), soft: await engine.oauthClientLive('soft') };
      const first = await engine.deleteOAuthClient('gone');
      const again = await engine.deleteOAuthClient('gone');
      return {
        before, first, again,
        after: { gone: await engine.oauthClientLive('gone'), kept: await engine.oauthClientLive('kept') },
        ttl: { gone: await engine.setOauthClientTokenTtl('gone', 120), kept: await engine.setOauthClientTokenTtl('kept', 120) },
        keptTtl: (await engine.readOauthClient('kept'))?.token_ttl, row: await engine.readOauthClient('gone'),
      };
    });
});

// Row 32m-2: `gbrain agent register --preset coding-agent` for a name whose `<name>-workspace` source already exists. A parity case counts a
// typed refusal as a pass, so this reads each arm itself: PGLite and Postgres reuse the empty source and register; Rust refuses and stores nothing.
describe('agent register into an existing derived workspace source (row 32m-2)', () => {
  const RAW_SQL = "This brain's engine does not support executeRaw yet (it needs the raw_sql capability), so nothing ran.";

  test('PGLite and Postgres reuse the empty source and register; Rust stops on raw SQL and writes nothing', async () => {
    const outcomes: unknown[] = [];
    for (const arm of arms()) {
      await resetArm(arm);
      const { engine, backend } = arm;
      await createSource(engine, backend, 'pin-agent-workspace');
      await createSource(engine, backend, 'src-b');
      const before = { clients: (await engine.listOauthClients()).length, source: await engine.getSource('pin-agent-workspace') };
      const out: string[] = [];
      const realExit = process.exit, realLog = console.log, realError = console.error;
      process.exit = ((code?: number) => { throw Object.assign(new Error(`exit ${code}`), { code: 'test_exit' }); }) as typeof process.exit;
      console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
      console.error = () => undefined;
      try {
        await runAgentRegister(engine, ['pin-agent', '--preset', 'coding-agent', '--federated-read', 'src-b', '--harness', 'claude-code', '--url', 'http://127.0.0.1:9/mcp', '--allow-old-serve', '--json']);
      } catch { /* the command's own exit; its JSON line is read below */ } finally { process.exit = realExit; console.log = realLog; console.error = realError; }
      const result = JSON.parse(out.at(-1) ?? '{}') as { ok?: boolean; reason?: string; message?: string; client_id?: string };
      const clients = await engine.listOauthClients();
      outcomes.push({
        backend: arm.backend, ok: result.ok === true, reason: result.reason ?? null, message: result.message ?? null,
        newClients: clients.length - before.clients,
        // On a refusal no client row exists, so no register audit row can either; on success the one client has its audit rows (the register row and the surface row).
        auditRows: (await Promise.all(clients.map(async c => (await engine.listOauthGrantAudit(c.client_id)).length))).reduce((a, b) => a + b, 0),
        sourceUnchanged: JSON.stringify(await engine.getSource('pin-agent-workspace')) === JSON.stringify(before.source),
      });
    }
    expect(outcomes).toEqual(arms().map(arm => arm.backend === 'rust'
      // On this base the first raw statement is the source check validateSourceIds runs for --federated-read (agent-register.ts, `SELECT id,
      // archived FROM sources WHERE id = ANY(...)`), before the per-name advisory lock and before ensureWorkspaceSource's counts, which
      // are raw SQL too (a new workspace name stops at the same first statement on this base). The command reports any thrown error as mint_failed carrying the engine's engine_capability_missing message.
      ? { backend: 'rust', ok: false, reason: 'mint_failed', message: RAW_SQL, newClients: 0, auditRows: 0, sourceUnchanged: true }
      : { backend: arm.backend, ok: true, reason: null, message: null, newClients: 1, auditRows: 2, sourceUnchanged: true }));
  }, 60_000);
});
