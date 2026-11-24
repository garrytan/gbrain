/**
 * Pins for the client grant members (engine-sql/client-grants.ts): the rescope, first-consent and attest-source flows.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text and parameters its caller sent through the
 *    `SqlQuery` tag before (grants/service.ts, access/attest-sources.ts at afc2094edd), so an engine caller and a bare
 *    `SqlQuery` caller (the consent store, the provider) run one statement list.
 *  - Regression: an edited text changes what Postgres and PGLite do while the parity case still passes on a small
 *    fixture; a reordered parameter writes one column's value into another.
 *  - Why existing coverage misses it: engine-sql-caller-raw-sql-pins.test.ts covers the credential members, not these.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records the text; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { runCase, withPinnedSqlEnvironment } from './helpers/postgres-engine-sql-cases.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { CLIENT_GRANT_SQL } from '../src/core/engine-sql/client-grants.ts';
import { clientHoldsAuthorization, readClientCatalogProvenance, recordFirstConsentInTransaction, rescopeClientGrantInTransaction } from '../src/core/grants/service.ts';
import { applyAttestSources, assertScopeSourceGrant } from '../src/core/access/attest-sources.ts';
import { rescopeOAuthClient } from '../src/core/grants/rescope.ts';

const CLIENT_ROW = {
  client_id: 'client-1', client_name: 'client-1', scope: 'read', source_id: 'default', federated_read: ['default'], source_grant: null,
  takes_holders: null, private_pages: 'none', private_facts: 'none', bound_slug_prefixes: null, allowed_operations: null, bound_tools: null,
  bound_source_id: null, bound_brain_id: null, delegated_slug_prefixes: null, delegated_namespace: 'prefixes', bound_max_concurrent: 1,
  budget_usd_per_day: null, surface: null, surface_set_by: null, token_ttl: null, grant_profile: null, grant_revision: 1,
  grant_repair_reasons: [], deleted_at: null,
};
const FRESH_ROW = { ...CLIENT_ROW, grant_revision: 0 };

type Trace = { text: string; params: unknown[] }[];
const GRANT_COLUMNS = ['grant_revision', 'allowed_operations', 'delegated_slug_prefixes', 'delegated_namespace', 'grant_profile', 'grant_repair_reasons', 'surface', 'surface_set_by', 'token_ttl', 'source_id', 'federated_read', 'bound_slug_prefixes', 'bound_tools', 'bound_source_id', 'bound_brain_id', 'bound_max_concurrent', 'budget_usd_per_day'];
const RULES = (row: Record<string, unknown>, held = false) => [
  [/information_schema\.columns/, GRANT_COLUMNS.map(column_name => ({ column_name }))],
  [/FROM oauth_clients WHERE client_id = \$1 FOR UPDATE/, [row]],
  [/SELECT EXISTS \(SELECT 1 FROM oauth_tokens/, [{ held }]],
  [/SELECT archived FROM sources WHERE id = \$1 FOR SHARE/, [{ archived: false }]],
  [/SELECT id, config FROM sources/, [{ id: 'team-a', config: {} }]],
  [/FROM sources/, [{ id: 'default' }, { id: 'team-a' }]],
  [/WITH updated AS/, [{ client_id: 'client-1' }]],
] as never;

/** The statements that touch a credential, grant or source lock: the source listing a validation reads is typed on an engine and raw on a SqlQuery, so it is left out. */
const grantStatements = (trace: Trace): Trace =>
  trace.filter(s => /oauth_|access_tokens|FOR SHARE|FOR UPDATE|minion_jobs/.test(s.text));

async function sent(run: (e: any) => Promise<unknown>, rows = RULES(CLIENT_ROW)): Promise<{ trace: Trace; error?: string }> {
  const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'grant-flow', variant: 'default', run, rows }));
  return { trace: capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params })), error: capture.error };
}

describe('each client grant member sends the text its caller sent', () => {
  const cases: { name: string; run: (e: any) => Promise<unknown>; texts: string[] }[] = [
    { name: 'readOauthClientForUpdate (service.ts rescopeClientGrantInTransaction)', run: e => e.readOauthClientForUpdate('c1'),
      texts: ['SELECT * FROM oauth_clients WHERE client_id = $1 FOR UPDATE'] },
    { name: 'readLiveOauthClients (attest-sources.ts credentialSources)', run: e => e.readLiveOauthClients(),
      texts: [`SELECT * FROM oauth_clients WHERE (to_jsonb(oauth_clients)->>'deleted_at') IS NULL`] },
    { name: 'readLiveAccessTokenRows (attest-sources.ts credentialSources)', run: e => e.readLiveAccessTokenRows(),
      texts: ['SELECT * FROM access_tokens WHERE revoked_at IS NULL'] },
    { name: 'oauthClientHoldsAuthorization (service.ts clientHoldsAuthorization)', run: e => e.oauthClientHoldsAuthorization('c1'),
      texts: [`SELECT EXISTS (SELECT 1 FROM oauth_tokens WHERE client_id = $1)
    OR EXISTS (SELECT 1 FROM oauth_codes WHERE client_id = $2) AS held`] },
    { name: 'readSourceArchivedForShare (service.ts recordFirstConsentInTransaction)', run: e => e.readSourceArchivedForShare('team-a'),
      texts: ['SELECT archived FROM sources WHERE id = $1 FOR SHARE'] },
    { name: 'readSourceAttestState (attest-sources.ts applyAttestSources)', run: e => e.readSourceAttestState('team-a'),
      texts: ['SELECT archived, config FROM sources WHERE id = $1'] },
    { name: 'replaceSourceConfig (attest-sources.ts applyAttestSources)', run: e => e.replaceSourceConfig('team-a', { qm_scope: true }),
      texts: ['UPDATE sources SET config = $1::text::jsonb WHERE id = $2'] },
    { name: 'readLatestCatalogProvenanceAudit (service.ts readClientCatalogProvenance)', run: e => e.readLatestCatalogProvenanceAudit('c1'),
      texts: [`SELECT after_grant FROM oauth_grant_audit
      WHERE client_id = $1 AND after_grant->'catalogProvenance' IS NOT NULL ORDER BY id DESC LIMIT 1`] },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const { trace, error } = await sent(c.run);
      expect(error).toBeUndefined();
      expect(trace.map(s => s.text)).toEqual(c.texts);
    });
  }
  test('the holds-authorization statement binds the client id twice', async () => {
    const { trace } = await sent(e => e.oauthClientHoldsAuthorization('c1'));
    expect(trace[0].params).toEqual(['c1', 'c1']);
  });
});

describe('the grant flows send the same statements through an engine as through a SqlQuery', () => {
  const both = async (run: (db: any) => Promise<unknown>, rows = RULES(CLIENT_ROW)) => {
    const template = await sent(e => run(sqlQueryForEngine(e)), rows);
    const member = await sent(e => run(e), rows);
    expect(template.error).toBeUndefined();
    expect(member.error).toBeUndefined();
    return { template: grantStatements(template.trace), member: grantStatements(member.trace) };
  };

  test('rescope to a wider scope with a new source (every statement and parameter)', async () => {
    const { template, member } = await both(db => rescopeClientGrantInTransaction(db, 'client-1', { sourceId: 'team-a', federatedRead: ['default', 'team-a'] }, { actor: 'operator', expectedRevision: 1 }));
    expect(template.length).toBeGreaterThanOrEqual(5);
    expect(member).toEqual(template);
    expect(template.some(s => s.text === CLIENT_GRANT_SQL.persist)).toBe(true);
  });

  test('rescope that widens the private-pages grant', async () => {
    const { template, member } = await both(db => rescopeClientGrantInTransaction(db, 'client-1', { privatePages: 'granted_sources' }, { actor: 'operator' }));
    expect(template.some(s => s.text === CLIENT_GRANT_SQL.set_private_pages)).toBe(true);
    expect(member).toEqual(template);
  });

  test('a dry run reads the client and writes nothing', async () => {
    const { template, member } = await both(db => rescopeClientGrantInTransaction(db, 'client-1', { scopes: ['read', 'write'] }, { actor: 'operator', dryRun: true }));
    expect(template.map(s => s.text)).toEqual([CLIENT_GRANT_SQL.client_for_update]);
    expect(member).toEqual(template);
  });

  test('first consent with a new source', async () => {
    const { template, member } = await both(db => recordFirstConsentInTransaction(db, 'client-1', 'team-a', 'owner'), RULES(FRESH_ROW));
    expect(template.some(s => s.text === CLIENT_GRANT_SQL.holds_authorization)).toBe(true);
    expect(template.some(s => s.text === CLIENT_GRANT_SQL.source_archived_for_share)).toBe(true);
    expect(member).toEqual(template);
  });

  test('clientHoldsAuthorization', async () => {
    const { template, member } = await both(db => clientHoldsAuthorization(db, 'client-1'));
    expect(template.length).toBe(1);
    expect(member).toEqual(template);
  });

  test('assertScopeSourceGrant reads the two credential tables the same way', async () => {
    const { template, member } = await both(db => assertScopeSourceGrant(db, { kind: 'client', id: 'client-1' }, ['team-a'], { privatePages: true }));
    expect(template.map(s => s.text)).toContain('SELECT * FROM access_tokens WHERE revoked_at IS NULL');
    expect(member).toEqual(template);
  });

  test('rescopeOAuthClient (the surface write of a registration) reads the schema and the source, then rescopes, with the same statements', async () => {
    const { template, member } = await both(db => rescopeOAuthClient(db, 'client-1', { sourceId: 'team-a', surface: 'verbs' }));
    expect(template.some(s => s.text === CLIENT_GRANT_SQL.persist)).toBe(true);
    expect(member).toEqual(template);
  });

  test('applyAttestSources (the --attest-sources check and mark) reads each listed source and rewrites its config with the same statements', async () => {
    const rows = [
      [/SELECT archived, config FROM sources WHERE id = \$1/, [{ archived: false, config: { note: 'x' } }]],
      [/SELECT id, config FROM sources/, [{ id: 'team-a', config: {} }]],
      [/FROM oauth_clients/, [{ ...CLIENT_ROW, attest_sources: [] }]],
    ] as never;
    const template = await sent(e => applyAttestSources(sqlQueryForEngine(e), { kind: 'client', id: 'client-1' }, ['team-a'], null), rows);
    const member = await sent(e => applyAttestSources(e, { kind: 'client', id: 'client-1' }, ['team-a'], null), rows);
    expect(template.error).toBeUndefined();
    expect(member.error).toBeUndefined();
    const sources = (t: Trace) => t.filter(s => /FROM sources|UPDATE sources/.test(s.text));
    expect(sources(template.trace).some(s => s.text === CLIENT_GRANT_SQL.replace_source_config)).toBe(true);
    expect(sources(member.trace).map(s => s.text))
      .toEqual(sources(template.trace).map(s => s.text));
    expect(sources(member.trace).find(s => s.text === CLIENT_GRANT_SQL.replace_source_config)?.params)
      .toEqual(sources(template.trace).find(s => s.text === CLIENT_GRANT_SQL.replace_source_config)?.params);
  });

  test('readClientCatalogProvenance', async () => {
    const rows = [[/FROM oauth_grant_audit/, [{ after_grant: { allowedOperations: ['get_page'], catalogProvenance: { version: 1, operations: [] } } }]]] as never;
    const { template, member } = await both(db => readClientCatalogProvenance(db, 'client-1', ['get_page']), rows);
    expect(template.length).toBe(1);
    expect(member).toEqual(template);
  });
});
