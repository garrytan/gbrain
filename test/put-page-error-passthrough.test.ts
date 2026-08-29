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
  test('>5MB content → status skipped WITH the error text', async () => {
    const big = '---\ntype: note\n---\n' + 'x'.repeat(5_000_001);
    const res = (await put_page.handler(ctxOf(), { slug: 'notes/too-big', content: big })) as Record<string, unknown>;
    expect(res.status).toBe('skipped');
    expect(String(res.error)).toContain('Content too large');
    expect(String(res.error)).toContain('max 5000000');
  });

  test('invalid YAML frontmatter → status error WITH the error text', async () => {
    const bad = '---\ntype: [unclosed\n---\nbody\n';
    const res = (await put_page.handler(ctxOf(), { slug: 'notes/bad-yaml', content: bad })) as Record<string, unknown>;
    expect(res.status).toBe('error');
    expect(typeof res.error).toBe('string');
    expect(String(res.error).length).toBeGreaterThan(0);
  });

  test('successful write carries NO error field (additive only)', async () => {
    const res = (await put_page.handler(ctxOf(), {
      slug: 'notes/fine', content: '---\ntype: note\n---\nfine body\n',
    })) as Record<string, unknown>;
    expect(res.status).toBe('created_or_updated');
    expect('error' in res).toBe(false);
  });
});
