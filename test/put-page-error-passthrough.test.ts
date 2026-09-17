/**
 * test/put-page-error-passthrough.test.ts — #3984.
 *
 * importFromContent returns { status: 'skipped'|'error', error: <reason> }
 * for rejected writes (oversized content, invalid YAML frontmatter), but
 * put_page's return envelope dropped the `error` field — an MCP caller
 * pushing >5MB got bare `{ status: 'skipped', chunks: 0 }` and had no idea
 * why the page never appeared. The reason now rides the op response.
 * capture delegates to put_page, so it inherits the passthrough.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const put_page = operations.find(o => o.name === 'put_page')!;

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
}, 30_000);

describe('put_page passes the skip/error reason through (#3984)', () => {
  test('>5MB content returns a failed receipt with a bounded size diagnostic', async () => {
    const big = '---\ntype: note\n---\n' + 'x'.repeat(5_000_001);
    let failure: any;
    try { await put_page.handler(ctxOf(), { slug: 'notes/too-big', content: big }); } catch (error) { failure = error; }
    expect(failure.code).toBe('request_too_large');
    expect(failure.message).toContain('max 5000000');
    expect(failure.writeRequest.state).toBe('failed');
    expect(await engine.getPage('notes/too-big')).toBeNull();
  });

  test('invalid YAML returns a failed receipt without copying submitted content', async () => {
    const bad = '---\ntype: [PRIVATE_YAML_CANARY\n---\nbody\n';
    let failure: any;
    try { await put_page.handler(ctxOf(), { slug: 'notes/bad-yaml', content: bad }); } catch (error) { failure = error; }
    expect(failure.code).toBe('invalid_params');
    expect(failure.message).toContain('YAML');
    expect(failure.writeRequest.state).toBe('failed');
    expect(JSON.stringify(failure.toJSON())).not.toContain('PRIVATE_YAML_CANARY');
  });

  test('successful write carries NO error field (additive only)', async () => {
    const res = (await put_page.handler(ctxOf(), {
      slug: 'notes/fine', content: '---\ntype: note\n---\nfine body\n',
    })) as Record<string, unknown>;
    expect(res.status).toBe('created_or_updated');
    expect('error' in res).toBe(false);
  });
});
