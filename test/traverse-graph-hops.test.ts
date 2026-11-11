/**
 * traverse_graph `hops` (agent-structured typed chains), through the real MCP
 * dispatcher for remote callers and the op handler for trusted local callers.
 *
 * Protects: a 1-3 hop chain returns answers with evidence edges; bad hops are
 * `invalid_params`, and depth/link_type/direction beside hops are set aside and
 * named in `set_aside` (GST-2214), never silently ignored; a chain that
 * finds nothing distinguishes an invisible start page from missing edges and
 * names the next call; remote callers never see private pages or raw context
 * beyond the sanitized excerpt; a granted token cannot reach another source.
 * Regression it catches: hops ignored (plain traversal returned), depth/type
 * silently dropped, private evidence leaking to remote callers.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, operationsByName, type AuthInfo, type OperationContext } from '../src/core/operations.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { buildRelationalArm } from '../src/core/search/relational-recall.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

let engine: PGLiteEngine;

const HOPS = [{ link_type: 'invested_in', toward: 'object' }, { link_type: 'founded', toward: 'subject' }];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const page = (slug: string, type: string, frontmatter?: Record<string, unknown>) =>
    engine.putPage(slug, { type: type as 'person', title: slug.split('/')[1], compiled_truth: `${slug} body`, timeline: '', ...(frontmatter ? { frontmatter } : {}) });
  await page('people/alice-example', 'person');
  await page('people/bob-example', 'person');
  await page('people/priv-example', 'person', { visibility: 'private' });
  await page('companies/acme-example', 'company');
  await page('companies/lonely-example', 'company');
  await engine.addLink('people/alice-example', 'companies/acme-example', 'alice backed acme', 'invested_in', 'markdown');
  await engine.addLink('companies/acme-example', 'people/bob-example', `founded by bob ${'x'.repeat(400)}`, 'founded', 'markdown');
  await engine.addLink('people/priv-example', 'companies/acme-example', 'priv cofounded acme', 'founded', 'markdown');
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

function localCtx(notices: Notice[] = []): OperationContext {
  return {
    engine: engine as never, config: {} as never, dryRun: false, remote: false, sourceId: 'default',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    emitNotice: (n: Notice) => { notices.push(n); },
  };
}

function remoteOpts(): DispatchOpts {
  const auth = { token: '', clientId: 'client-a', scopes: ['read'], sourceId: 'default', allowedSources: ['default'], principal: { kind: 'oauth_client', id: 'client-a' } } as AuthInfo;
  return { remote: true, transport: 'http', sourceId: 'default', auth, localFederatedSourceIds: ['default'] };
}

const runLocal = (params: Record<string, unknown>, notices?: Notice[]) =>
  operationsByName.traverse_graph.handler(localCtx(notices), params) as Promise<any>;

describe('traverse_graph hops', () => {
  test('two-hop chain returns answers with evidence, oriented across stored direction', async () => {
    const res = await runLocal({ slug: 'people/alice-example', hops: HOPS });
    expect(res.diagnostics.status).toBe('fired');
    expect(res.answers.map((a: any) => a.slug).sort()).toEqual(['people/bob-example', 'people/priv-example']);
    const bob = res.paths[res.answers.findIndex((a: any) => a.slug === 'people/bob-example')];
    expect(bob.nodes).toEqual(['people/alice-example', 'companies/acme-example', 'people/bob-example']);
    expect(bob.edges[1]).toMatchObject({ link_type: 'founded', stored_from: 'companies/acme-example', orientation: 'flipped' });
  });

  test('remote callers: private pages hidden; context only from sealed pages, sanitized and bounded', async () => {
    const remote = async () => JSON.parse((await dispatchToolCall(engine, 'traverse_graph', { slug: 'people/alice-example', hops: HOPS }, remoteOpts())).content[0].text);
    const unsealed = await remote();
    expect(unsealed.answers.map((a: any) => a.slug)).toEqual(['people/bob-example']);
    expect(unsealed.paths[0].edges[1].context).toBeNull();
    const before = await engine.executeRaw<{ v: number }>(`SELECT chunker_version AS v FROM pages WHERE slug = 'companies/acme-example'`);
    await engine.executeRaw(`UPDATE pages SET chunker_version = 4 WHERE slug = 'companies/acme-example'`);
    const body = await remote();
    await engine.executeRaw(`UPDATE pages SET chunker_version = $1 WHERE slug = 'companies/acme-example'`, [before[0].v]);
    const ctx = body.paths[0].edges[1].context as string;
    expect(ctx.startsWith('founded by bob')).toBe(true);
    expect(ctx.length).toBeLessThanOrEqual(160);
  });

  test('invalid hops are invalid_params with the exact problem', async () => {
    await expect(runLocal({ slug: 'people/alice-example', hops: [{ link_type: 'mentions', toward: 'object' }] }))
      .rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('hops[0].link_type') });
    await expect(runLocal({ slug: 'people/alice-example', hops: [{ link_type: 'founded', toward: 'in' }] }))
      .rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('hops[0].toward') });
    await expect(runLocal({ slug: 'people/alice-example', hops: [...HOPS, ...HOPS] }))
      .rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('at most 3 hops') });
  });

  test('depth and link_type beside hops walk the same chain and are named in set_aside, never silently dropped', async () => {
    const chain = await runLocal({ slug: 'people/alice-example', hops: HOPS });
    const { set_aside, ...rest } = await runLocal({ slug: 'people/alice-example', hops: HOPS, depth: 2, link_type: 'founded' });
    expect(rest).toEqual(chain);
    expect(chain.set_aside).toBeUndefined();
    expect(set_aside).toEqual({ ignored: ['depth', 'link_type'],
      note: 'Walked the hops chain; ignored depth and link_type: each hop names its link type and direction (toward), and the chain length is the number of hops.' });
  });

  test('anchor_not_found, no_edges and empty_hop each carry a notice with the next call', async () => {
    const notices: Notice[] = [];
    const missing = await runLocal({ slug: 'people/nobody-example', hops: HOPS }, notices);
    expect(missing.diagnostics.status).toBe('anchor_not_found');
    expect(notices.pop()).toMatchObject({ code: 'relational_chain', fix: { mcp: { tool: 'search' } } });
    const none = await runLocal({ slug: 'companies/lonely-example', hops: [{ link_type: 'founded', toward: 'subject' }] }, notices);
    expect(none.diagnostics.status).toBe('no_edges');
    expect(notices.pop()).toMatchObject({ fix: { mcp: { tool: 'traverse_graph', arguments: { slug: 'companies/lonely-example', depth: 1 } } } });
    const later = await runLocal({ slug: 'people/alice-example', hops: [HOPS[0], { link_type: 'advises', toward: 'subject' }] }, notices);
    expect(later.diagnostics).toMatchObject({ status: 'empty_hop', empty_hop: 2 });
    expect(notices.pop()).toMatchObject({ fix: { mcp: { tool: 'traverse_graph', arguments: { hops: [HOPS[0]] } } } });
  });

  test('hops is advertised on the full surface only; the starter list stays inside its budget', () => {
    const on = (surface: 'full' | 'starter') => filterOpsForSurface(operations, surface).find(o => o.name === 'traverse_graph')!.params;
    expect(on('full')).toHaveProperty('hops');
    expect(on('starter')).not.toHaveProperty('hops');
    expect(on('starter')).toHaveProperty('depth');
  });

  test('without hops the op keeps its existing shape', async () => {
    const res = await runLocal({ slug: 'people/alice-example', link_type: 'invested_in', direction: 'out' });
    expect(Array.isArray(res)).toBe(true);
  });
});

describe('traverse_graph hops: relationship validity', () => {
  test('an ended state relationship is not walked; a "formerly" question walks it', async () => {
    await engine.putPage('people/carol-example', { type: 'person', title: 'carol', compiled_truth: 'carol', timeline: '' });
    await engine.putPage('companies/old-example', { type: 'company', title: 'old', compiled_truth: 'old', timeline: '' });
    await engine.addLink('companies/old-example', 'people/bob-example', 'founded by bob', 'founded', 'markdown');
    await operationsByName.add_link.handler(localCtx(), {
      from: 'people/carol-example', to: 'companies/old-example', link_type: 'advises', valid_from: '2019-01-01', valid_until: '2021-06-30',
    });
    const hops = [{ link_type: 'advises', toward: 'object' }, { link_type: 'founded', toward: 'subject' }];
    const live = await runLocal({ slug: 'people/carol-example', hops });
    expect(live.answers).toEqual([]);
    expect(live.diagnostics.status).toBe('no_edges');

    // The search arm: present tense walks live relationships, "formerly" walks the ended one.
    for (const slug of ['people/bob-example', 'companies/old-example']) {
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `${slug} body` }]);
    }
    const arm = async (q: string) => {
      let meta: any;
      const list = await buildRelationalArm(engine, q, { planner: true, onMeta: m => { meta = m; } });
      return { answers: list.filter(r => r.relational?.role === 'answer').map(r => r.slug), status: meta.plan?.status };
    };
    expect(await arm('Who founded the companies Carol Example advises?')).toEqual({ answers: [], status: 'no_edges' });
    expect(await arm('Who founded the companies Carol Example formerly advised?')).toEqual({ answers: ['people/bob-example'], status: 'fired' });
  });
});
