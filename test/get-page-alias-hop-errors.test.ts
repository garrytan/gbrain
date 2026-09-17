/** Coherent exact/alias snapshot failures propagate instead of becoming false misses. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';

const get_page = operations.find((o) => o.name === 'get_page')!;

let engine: PGLiteEngine;
/** A pre-v104 shape: same engine class, slug_aliases table dropped. */
let preV104: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage(
    'people/alice-example',
    { type: 'person', title: 'Alice Example', compiled_truth: 'a page', frontmatter: {} },
    { sourceId: 'default' },
  );
  preV104 = new PGLiteEngine();
  await preV104.connect({});
  await preV104.initSchema();
  await preV104.executeRaw(`DROP TABLE IF EXISTS slug_aliases CASCADE`);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  await preV104.disconnect();
});

function failingAliasEngine(err: Error): PGLiteEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'readPageSnapshot') {
        return async () => {
          throw err;
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as PGLiteEngine;
}

function ctxOf(eng: PGLiteEngine, overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: eng as unknown as OperationContext['engine'],
    config: {} as OperationContext['config'],
    logger: console as unknown as OperationContext['logger'],
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

describe('get_page alias hop error propagation', () => {
  test('a connection error from the alias lookup REJECTS get_page (no degrade to page_not_found)', async () => {
    const conn = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const eng = failingAliasEngine(conn);
    let caught: unknown = null;
    try {
      await get_page.handler(ctxOf(eng), { slug: 'people/retired-slug' });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).message).toContain('ECONNRESET');
    expect(caught instanceof OperationError && caught.code === 'page_not_found').toBe(false);
  });

  test('a connection error from the alias lookup is not papered over by fuzzy either', async () => {
    const conn = new Error('Connection terminated unexpectedly');
    const eng = failingAliasEngine(conn);
    await expect(
      get_page.handler(ctxOf(eng), { slug: 'people/alice-exampl', fuzzy: true }),
    ).rejects.toThrow('Connection terminated unexpectedly');
  });

  test('a missing snapshot dependency reports a schema error instead of a false missing page', async () => {
    // Snapshot reads require their migrated dependencies. Do not hide a
    // damaged or unmigrated schema as a confident page-not-found result.
    let caught: unknown = null;
    try {
      await get_page.handler(ctxOf(preV104), { slug: 'people/retired-slug' });
    } catch (e) {
      caught = e;
    }
    expect((caught as {code:string}).code).toBe('42P01');
  });

  test('a live page resolves through the coherent snapshot (exact read wins)', async () => {
    const r = (await get_page.handler(ctxOf(engine), { slug: 'people/alice-example' })) as { slug: string };
    expect(r.slug).toBe('people/alice-example');
  });
});
