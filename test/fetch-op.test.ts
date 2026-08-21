/**
 * #4039 - OpenAI deep-research `fetch` contract.
 *
 * ChatGPT's deep research and company knowledge integrations require the MCP
 * server to expose a `search`/`fetch` pair. gbrain's `search` already existed;
 * `fetch` was missing. This op is a thin adapter over get_page:
 *
 *   - the id is the page slug, so `search` results (stamped `id: slug` at the
 *     op boundary) round-trip into `fetch` with zero translation;
 *   - same scope resolution: federated grants, per-call source_id, remote
 *     privacy fences (takes/facts stripped for untrusted readers);
 *   - same failure mode: page_not_found for unknown ids.
 *
 * These tests cover the round-trip contract, the OpenAI response envelope
 * ({id, title, text, metadata}), source scoping, and the privacy fence
 * inheritance from get_page.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const fetch = operations.find(o => o.name === 'fetch')!;
const get_page = operations.find(o => o.name === 'get_page')!;
const put_page = operations.find(o => o.name === 'put_page')!;
const search = operations.find(o => o.name === 'search')!;

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
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);
  await engine.putPage('docs/alpha', {
    type: 'note', title: 'Alpha doc', compiled_truth: 'alpha content body', frontmatter: {},
  }, { sourceId: 'default' });
  await engine.addTag('docs/alpha', 'misc', { sourceId: 'default' });
  await engine.putPage('secret/beta-doc', {
    type: 'note', title: 'Beta secret', compiled_truth: 'beta-only content', frontmatter: {},
  }, { sourceId: 'beta' });
});

describe('fetch contract (OpenAI deep-research id docs)', () => {
  test('round-trips a slug from search results', async () => {
    const results = await search.handler(ctxOf({ sourceId: 'default' }), { query: 'alpha content', limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    const hit = (results as any[]).find(r => r.id === 'docs/alpha');
    expect(hit).toBeDefined();

    const doc = await fetch.handler(ctxOf({ sourceId: 'default' }), { id: 'docs/alpha' });
    expect((doc as any).id).toBe('docs/alpha');
    expect((doc as any).title).toBe('Alpha doc');
    expect((doc as any).text).toContain('alpha content body');
  });

  test('returns the OpenAI envelope {id, title, text, metadata}', async () => {
    const doc: any = await fetch.handler(ctxOf({ sourceId: 'default' }), { id: 'docs/alpha' });
    expect(doc.id).toBe('docs/alpha');
    expect(doc.title).toBe('Alpha doc');
    expect(doc.text).toContain('alpha content body');
    expect(doc.metadata.type).toBe('note');
    expect(doc.metadata.tags).toEqual(['misc']);
  });

  test('text carries the canonical content when available', async () => {
    const doc: any = await fetch.handler(ctxOf({ sourceId: 'default' }), { id: 'docs/alpha' });
    // get_page with include_content serializes frontmatter + body; the
    // canonical serialization must include both the title field frontmatter
    // and the compiled body.
    expect(doc.text).toContain('alpha content body');
    expect(doc.text.length).toBeGreaterThan(0);
  });

  test('unknown id fails with page_not_found, same as get_page', async () => {
    try {
      await fetch.handler(ctxOf({ sourceId: 'default' }), { id: 'no/such-page' });
      expect.unreachable('expected page_not_found');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('page_not_found');
    }
  });

  test('respects per-call source_id scoping', async () => {
    // Same slug exists in 'default' only; beta has a different slug. A
    // source-scoped fetch to beta must not leak the default page.
    await expect(fetch.handler(ctxOf({ sourceId: 'default' }), { id: 'secret/beta-doc', source_id: 'beta' }))
      .resolves.toMatchObject({ id: 'secret/beta-doc' });
    try {
      await fetch.handler(ctxOf({ sourceId: 'default' }), { id: 'docs/alpha', source_id: 'beta' });
      expect.unreachable('expected page_not_found');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('page_not_found');
    }
  });

  test('inherits the remote privacy fences (takes/facts stripped)', async () => {
      // Mirror of the get_page remote-reader guarantee: a remote fetch must not
      // leak private takes/facts fences. Seed a page with a private fact, then
      // assert the row is stripped for a remote caller.
      const fencedBody = [
        'public part',
        '',
        '<!--- gbrain:facts:begin -->',
        '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
        '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
        '| 1 | private claim | fact | 0.9 | private | 2 |  |  |  |  |',
        '<!--- gbrain:facts:end -->',
      ].join('\n');
      await engine.putPage('privacy/fenced', {
        type: 'note', title: 'Fenced', compiled_truth: fencedBody, frontmatter: {},
      }, { sourceId: 'default' });
      const doc: any = await fetch.handler(ctxOf({ sourceId: 'default' }), { id: 'privacy/fenced' });
      expect(doc.text).not.toContain('private');
      expect(doc.text).toContain('public part');
    });

  test('is a non-localOnly op (remote OAuth callers can use it)', () => {
    expect(fetch.localOnly).toBeFalsy();
    expect(fetch.scope).toBe('read');
  });
});