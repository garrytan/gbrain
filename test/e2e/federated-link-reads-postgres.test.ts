/**
 * #5827 — Postgres twin of test/federated-link-reads-5827.test.ts.
 *
 * The link ops' remote no-grant path binds the federated set as a `text[]`
 * through the engine's #2200 all-endpoints branch, and traverse_graph now
 * projects page ids and source ids; postgres.js array binding and the
 * DISTINCT/ORDER BY shape only fail on real Postgres, so the federated matrix
 * runs here too: a no-grant caller reads business links (not the empty
 * `default`), a non-federated referrer, an archived source and a private page
 * stay out, a granted token never widens, same-slug pages in two federated
 * sources stay distinct edges/nodes, and a trusted local unqualified read
 * merges one scalar read per federated source.
 *
 * DATABASE_URL-gated: self-skips without a real Postgres.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { operationsByName, type AuthInfo, type OperationContext } from '../../src/core/operations.ts';
import { noGrantFederatedScope } from '../../src/core/source-resolver.ts';
import { dispatchToolCall, type DispatchOpts } from '../../src/mcp/dispatch.ts';
import { FEDERATED_SET, edgeKeys, seedFederatedLinkFixture } from '../helpers/federated-link-fixture.ts';

const describePg = hasDatabase() ? describe : describe.skip;

describePg('#5827 federated link reads — Postgres', () => {
  beforeAll(async () => {
    await setupDB();
    await seedFederatedLinkFixture(getEngine());
  }, 90_000);

  afterAll(async () => {
    await teardownDB();
  }, 30_000);

  async function noGrantOpts(): Promise<DispatchOpts> {
    const auth = { token: '', clientId: 'legacy', scopes: ['read'], sourceId: 'default', hasSourceGrant: false } as AuthInfo;
    return {
      remote: true, transport: 'http', sourceId: 'default', auth,
      localFederatedSourceIds: await noGrantFederatedScope(getEngine(), false, 'default'),
    };
  }

  async function call(opts: DispatchOpts, name: string, params: Record<string, unknown>) {
    const result = await dispatchToolCall(getEngine(), name, params, opts);
    return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
  }

  test('no-grant get_backlinks and get_links read the federated set only', async () => {
    const opts = await noGrantOpts();
    expect(opts.localFederatedSourceIds).toEqual([...FEDERATED_SET]);
    expect(edgeKeys((await call(opts, 'get_backlinks', { slug: 'companies/acme-example' })).body)).toEqual([
      'people/alice-example(business)->companies/acme-example(business)',
    ]);
    expect(edgeKeys((await call(opts, 'get_links', { slug: 'people/alice-example' })).body)).toEqual([
      'people/alice-example(business)->companies/acme-example(business)',
      'people/alice-example(wiki)->topics/widget-co(wiki)',
    ]);
  });

  test('no-grant traverse_graph keeps same-slug edges from two sources distinct', async () => {
    const { body } = await call(await noGrantOpts(), 'traverse_graph', { slug: 'people/alice-example', depth: 1 });
    expect(edgeKeys(body)).toEqual([
      'people/alice-example(business)->companies/acme-example(business)',
      'people/alice-example(wiki)->topics/widget-co(wiki)',
    ]);
  });

  test('explicit non-federated or archived source_id is refused for a no-grant caller', async () => {
    const opts = await noGrantOpts();
    expect((await call(opts, 'get_backlinks', { slug: 'companies/priv-only-co', source_id: 'priv' })).body.error).toBe('permission_denied');
    expect((await call(opts, 'get_backlinks', { slug: 'companies/acme-example', source_id: 'arch' })).body.error).toBe('permission_denied');
  });

  test('a granted token reads only its grant', async () => {
    const auth = { token: '', clientId: 'client-a', scopes: ['read'], sourceId: 'wiki', allowedSources: ['wiki'] } as AuthInfo;
    const opts: DispatchOpts = { remote: true, transport: 'http', sourceId: 'wiki', auth, localFederatedSourceIds: [...FEDERATED_SET] };
    expect((await call(opts, 'get_backlinks', { slug: 'companies/acme-example' })).body).toEqual([]);
  });

  test('trusted local unqualified backlinks merge one scalar read per federated source; graph nodes carry source ids', async () => {
    const engine = getEngine();
    const ctx: OperationContext = {
      engine, config: {} as never, logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false, remote: false, sourceId: 'default', localFederatedSourceIds: [...FEDERATED_SET],
    };
    const rows = await operationsByName.get_backlinks.handler(ctx, { slug: 'companies/acme-example' });
    const perSource: unknown[] = [];
    for (const sourceId of FEDERATED_SET) perSource.push(...await engine.getBacklinks('companies/acme-example', { sourceId }));
    expect(rows).toEqual(perSource);
    expect(edgeKeys(rows as unknown[])).toContain('notes/priv-note(priv)->companies/acme-example(business)');
    const nodes = await operationsByName.traverse_graph.handler(ctx, { slug: 'people/alice-example', depth: 1 }) as Array<Record<string, unknown>>;
    expect(nodes.filter((n) => n.depth === 0).map((n) => n.source_id).sort()).toEqual(['business', 'wiki']);
  });
});
