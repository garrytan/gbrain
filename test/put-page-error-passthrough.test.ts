/**
 * test/put-page-error-passthrough.test.ts — #3984.
 *
 * importFromContent returns { status: 'skipped'|'error', error: <reason> }
 * for rejected writes (oversized content, invalid YAML frontmatter), but
 * put_page's return envelope dropped the `error` field — an MCP caller
 * pushing >5MB got bare `{ status: 'skipped', chunks: 0 }` and had no idea
 * why the page never appeared. The reason now rides the op response.
 * capture delegates to put_page, so it inherits the passthrough.
 *
 * Large pages (N14 baseline): a body over the page ceiling is refused as
 * request_too_large (a caller error) before journal admission, so it never
 * reserves intent bytes and never reads as retryable queue_capacity, even when
 * it is also over the journal's intent-byte cap.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';

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
  test('content over the page ceiling is refused before admission with a bounded size diagnostic', async () => {
    const big = '---\ntype: note\n---\n' + 'x'.repeat(PAGE_MAX_BYTES);
    let failure: any;
    try { await put_page.handler(ctxOf(), { slug: 'notes/too-big', content: big }); } catch (error) { failure = error; }
    expect(failure.code).toBe('request_too_large');
    expect(failure.message).toContain(`max ${PAGE_MAX_BYTES}`);
    expect(failure.message.length).toBeLessThan(400);
    expect(failure.writeRequest).toBeUndefined();
    expect(await engine.getPage('notes/too-big')).toBeNull();
    const [journal] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests');
    expect(Number(journal.n)).toBe(0);
  });

  test('an over-ceiling body that is also over the intent-byte cap is a size refusal, never queue_capacity', async () => {
    await engine.setConfig('persistence.limits.principal_intent_bytes', String(16 * 1024 * 1024));
    const big = '---\ntype: note\n---\n' + 'x'.repeat(PAGE_MAX_BYTES);
    let failure: any;
    try { await put_page.handler(ctxOf(), { slug: 'notes/too-big-for-the-journal', content: big }); } catch (error) { failure = error; }
    expect(failure.code).toBe('request_too_large');
    const small = await put_page.handler(ctxOf(), { slug: 'notes/fits', content: '---\ntype: note\n---\nfits\n' }) as Record<string, unknown>;
    expect(small.status).toBe('created_or_updated');
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
