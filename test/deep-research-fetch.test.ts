/**
 * test/deep-research-fetch.test.ts — #4039.
 *
 * ChatGPT's deep-research mode requires an MCP server to expose a
 * `search`/`fetch` PAIR: search results carry an `id`, and `fetch(id)`
 * returns OpenAI's `{ id, title, text, url, metadata }` shape. gbrain had
 * `search` but no `fetch` (and results carried no `id`), so the connector
 * worked in normal chat and failed in deep research. Pins:
 *   - the `fetch` op exists, is remote-allowed read scope, returns the shape
 *   - search results are stamped with id = slug so the pair round-trips
 *   - fetch honors source scoping and the remote privacy fences
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const fetch_op = operations.find(o => o.name === 'fetch')!;
const search_op = operations.find(o => o.name === 'search')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.putPage('people/alice-example', {
    type: 'person', title: 'Alice Example', compiled_truth: 'Alice runs widget-co.', frontmatter: {},
  }, { sourceId: 'default' });
});

describe('fetch op (#4039 deep-research contract)', () => {
  test('exists as a remote-allowed read op with a required id param', () => {
    expect(fetch_op, "the 'fetch' op must exist").toBeDefined();
    expect(fetch_op.scope).toBe('read');
    expect(fetch_op.localOnly).not.toBe(true);
    expect(fetch_op.params.id?.required).toBe(true);
  });

  test('returns the OpenAI {id,title,text,url,metadata} shape for a slug id', async () => {
    const res = (await fetch_op.handler(ctxOf(), { id: 'people/alice-example' })) as Record<string, unknown>;
    expect(res.id).toBe('people/alice-example');
    expect(res.title).toBe('Alice Example');
    expect(String(res.text)).toContain('Alice runs widget-co.');
    expect(String(res.url)).toBe('gbrain://page/default/people/alice-example');
    const metadata = res.metadata as Record<string, unknown>;
    expect(metadata.type).toBe('person');
    expect(metadata.source_id).toBe('default');
  });

  test('unknown id → page_not_found; empty id → invalid_params', async () => {
    await expect(fetch_op.handler(ctxOf(), { id: 'no/such-page' })).rejects.toThrow(OperationError);
    await expect(fetch_op.handler(ctxOf(), { id: '  ' })).rejects.toThrow(OperationError);
  });

  test('source scoping: a caller granted another source cannot fetch this page', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);
    const scoped = ctxOf({ sourceId: undefined, auth: { allowedSources: ['beta'] } as any });
    await expect(fetch_op.handler(scoped, { id: 'people/alice-example' })).rejects.toThrow(OperationError);
  });

  test('remote privacy fence: takes fence content never crosses fetch', async () => {
    await engine.putPage('people/bob-example', {
      type: 'person',
      title: 'Bob Example',
      compiled_truth: 'Bob intro.\n\n<!--- gbrain:takes:begin -->\n| SECRET-TAKE |\n<!--- gbrain:takes:end -->\n',
      frontmatter: {},
    }, { sourceId: 'default' });
    const remoteRes = (await fetch_op.handler(ctxOf({ remote: true }), { id: 'people/bob-example' })) as Record<string, unknown>;
    expect(String(remoteRes.text)).not.toContain('SECRET-TAKE');
  });

  test('search results carry id = slug so the pair round-trips', async () => {
    const results = (await search_op.handler(ctxOf({ remote: false }), { query: 'Alice widget' })) as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.id).toBe(r.slug);
    }
    // Round-trip: the stamped id feeds fetch directly.
    const fetched = (await fetch_op.handler(ctxOf(), { id: results[0].id as string })) as Record<string, unknown>;
    expect(fetched.id).toBe(results[0].slug);
  });
});
